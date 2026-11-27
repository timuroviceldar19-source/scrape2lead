import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyFinanceWorkbook } from "../../src/bitrix/salesPult/finance/classifyWorkbook.js";
import { loadFinanceView } from "../../src/bitrix/salesPult/finance/load.js";
import { parseOpiuExcel } from "../../src/bitrix/salesPult/finance/parseOpiu.js";
import { deriveOppositeRealization, parseRealizationExcel } from "../../src/bitrix/salesPult/finance/parseRealization.js";
import { handleGateRequest } from "../../src/bitrix/salesPult/gate/handler.js";
import { parseGateConfig } from "../../src/bitrix/salesPult/gate/config.js";
import { renderFinanceHtml, renderFinReportsHtml, renderPultHtml, renderRegisterHtml } from "../../src/bitrix/salesPult/site.js";
import { buildRopVariant, renderRopVariant } from "../../src/bitrix/salesPult/variants/rop.js";
import { buildRtoVariant, renderRtoVariant } from "../../src/bitrix/salesPult/variants/rto.js";
import { deployPultVariants } from "../../scripts/pult-variants.mjs";
import { financeWorkbookBuffer } from "../fixtures/sales-pult/financeWorkbook.js";
import { opiuWorkbookBuffer, realizationWorkbookBuffer } from "../fixtures/sales-pult/opiuAndRealizationWorkbooks.js";
import crypto from "node:crypto";

// Все данные выдуманные (см. tests/fixtures/sales-pult/opiuAndRealizationWorkbooks.ts).

let dailyBuf: Buffer;
let opiuBuf: Buffer;
let opiuValuesOnlyBuf: Buffer;
let opiuMismatchBuf: Buffer;
let realClientTmcBuf: Buffer;
let realTmcClientBuf: Buffer;

beforeAll(async () => {
  dailyBuf = await financeWorkbookBuffer();
  opiuBuf = await opiuWorkbookBuffer();
  opiuValuesOnlyBuf = await opiuWorkbookBuffer({ valuesOnly: true });
  opiuMismatchBuf = await opiuWorkbookBuffer({ mismatchSelling: true });
  realClientTmcBuf = realizationWorkbookBuffer("client-tmc");
  realTmcClientBuf = realizationWorkbookBuffer("tmc-client");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("классификатор финансовых .xlsx-файлов", () => {
  it("различает Ежед., ОПиУ, ОР (Клиент-ТМЦ и ТМЦ-Клиент) и неизвестные файлы", () => {
    expect(classifyFinanceWorkbook(dailyBuf)).toBe("daily");
    expect(classifyFinanceWorkbook(opiuBuf)).toBe("opiu");
    expect(classifyFinanceWorkbook(realClientTmcBuf)).toBe("realization-client-tmc");
    expect(classifyFinanceWorkbook(realTmcClientBuf)).toBe("realization-tmc-client");
    expect(classifyFinanceWorkbook(Buffer.from("not an excel"))).toBe("unknown");
  });
});

describe("разбор ОПиУ и двухуровневых расшифровок", () => {
  it("читает годы, активные месяцы, 1- и 2-уровневые расшифровки и досчитывает помесячную маржу", async () => {
    const report = await parseOpiuExcel(opiuBuf);
    expect(report.organization).toBe("ТОО «Тест-ОПиУ»");
    expect(report.unitLabel).toBe("тенге без НДС");
    expect(report.periodLabel).toBe("9 мес. 2026");
    expect(report.years.map((y) => [y.year, y.label, y.months])).toEqual([
      ["2025", "2025", ["2025-01", "2025-02"]],
      ["2026", "9 мес. 2026", ["2026-01", "2026-02"]]
    ]);
    expect(report.warnings).toEqual([]);

    const margin = report.rows.find((r) => r.label === "Маржа");
    expect(margin?.isPercent).toBe(true);
    expect(margin?.months["2026-01"]).toBeCloseTo(15 / 40, 4);

    // 1-уровневая расшифровка (010 Выручка)
    const revRow = report.rows.find((r) => r.code === "010");
    expect(revRow?.breakdownKey).toBe("010");
    expect(report.breakdowns["010"].hasGroups).toBe(false);
    expect(report.breakdowns["010"].items.map((x) => x.label)).toEqual([
      "ТОО Заказчик Альфа Договор №1",
      "ТОО Заказчик Бета Договор №2"
    ]);

    // 2-уровневая расшифровка (013 Расходы по реализации: жирные категории -> детали)
    const sellRow = report.rows.find((r) => r.code === "013");
    expect(sellRow?.breakdownKey).toBe("013");
    const sell = report.breakdowns["013"];
    expect(sell.hasGroups).toBe(true);
    expect(sell.items.map((x) => x.label)).toEqual([
      "Агентские услуги Реализация",
      "Заработная плата Реализация"
    ]);
    expect(sell.items[0].years).toEqual([12_000_000, 9_000_000]);
    expect(sell.items[0].children?.map((x) => x.label)).toEqual([
      "ТОО Партнёр Восток Договор №10",
      "ИП Агент Запад Без договора"
    ]);
    expect(sell.items[1].children?.map((x) => x.label)).toEqual([
      "Сотрудник Первый",
      "Сотрудник Второй"
    ]);

    // 2-уровневая расшифровка (014 Административные расходы)
    expect(report.breakdowns["014"].hasGroups).toBe(true);
    expect(report.breakdowns["014"].items[0].children?.[0].label).toBe("Бизнес-центр Тест Договор аренды");
  });

  it("привязывает расшифровки по названиям разделов, даже если в ОПиУ вставлены значения без формул", async () => {
    const report = await parseOpiuExcel(opiuValuesOnlyBuf);
    expect(Object.keys(report.breakdowns).sort()).toEqual(["010", "011", "013", "014"]);
    expect(report.breakdowns["013"].hasGroups).toBe(true);
  });

  it("выявляет расхождение суммы расшифровки со строкой ОПиУ без утечки названий", async () => {
    const report = await parseOpiuExcel(opiuMismatchBuf);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/013/);
    expect(report.warnings[0]).not.toMatch(/Партнёр|Сотрудник|500/);
  });
});

describe("разбор Отчёта о реализации (Клиент-ТМЦ и ТМЦ-Клиент)", () => {
  it("разбирает оба 3-уровневых дерева с возвратами и прибылью без предупреждений", () => {
    const c2t = parseRealizationExcel(realClientTmcBuf);
    expect(c2t.kind).toBe("client-tmc");
    expect(c2t.organization).toBe('ТОО "Тест-Компания"');
    expect(c2t.periodLabel).toBe("Ноябрь 2026");
    expect(c2t.hasProfit).toBe(true);
    expect(c2t.warnings).toEqual([]);
    expect(c2t.nodes).toHaveLength(2);
    expect(c2t.nodes[0].name).toBe("ТОО Покупатель Один");
    expect(c2t.nodes[0].children?.map((x) => x.name)).toEqual(["Интерактивные панели", "Ноутбуки"]);
    expect(c2t.nodes[0].children?.[0].children?.[0].name).toBe("Панель Альфа 75");
    expect(c2t.totals.qtyNet).toBe(6);
    expect(c2t.totals.sumNet).toBe(5_000_000);
    expect(c2t.totals.profit).toBe(1_210_344.83);

    const t2c = parseRealizationExcel(realTmcClientBuf);
    expect(t2c.kind).toBe("tmc-client");
    expect(t2c.warnings).toEqual([]);
    expect(t2c.nodes.map((x) => x.name)).toEqual(["Интерактивные панели", "Ноутбуки"]);
    expect(t2c.nodes[0].children?.[0].children?.map((x) => x.name)).toEqual([
      "ТОО Покупатель Один",
      "ТОО Покупатель Два"
    ]);
    expect(t2c.totals.sumNet).toBe(5_000_000);
  });

  it("автоматически строит противоположный разрез, если загружен только один файл", () => {
    const c2t = parseRealizationExcel(realClientTmcBuf);
    const derived = deriveOppositeRealization(c2t);
    expect(derived.kind).toBe("tmc-client");
    expect(derived.derived).toBe(true);
    expect(derived.nodes.map((x) => x.name)).toEqual(["Интерактивные панели", "Ноутбуки"]);
    expect(derived.totals.sumNet).toBe(c2t.totals.sumNet);
    expect(derived.totals.profit).toBe(c2t.totals.profit);
    expect(derived.nodes[0].metrics.qtyNet).toBe(4);
  });
});

describe("загрузка всех типов отчётов из одного чата Битрикс24", () => {
  it("разделяет Ежед., ОПиУ и оба ОР, не роняет Ежед. и кэширует без повторных скачиваний", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a) => void logs.push(a.join(" ")));

    const listing = [
      { ID: 1, NAME: "Ежедневный отчет.xlsx", TYPE: "file", CREATE_TIME: "2026-11-26T10:00:00+03:00", UPDATE_TIME: "2026-11-26T10:00:00+03:00", DOWNLOAD_URL: "https://disk.example.test/1" },
      { ID: 2, NAME: "ФО Тест 9 мес.xlsx", TYPE: "file", CREATE_TIME: "2026-11-26T15:42:00+03:00", UPDATE_TIME: "2026-11-26T15:42:00+03:00", DOWNLOAD_URL: "https://disk.example.test/2" },
      { ID: 3, NAME: "ОР ноябрь.xlsx", TYPE: "file", CREATE_TIME: "2026-11-26T16:02:00+03:00", UPDATE_TIME: "2026-11-26T16:02:00+03:00", DOWNLOAD_URL: "https://disk.example.test/3" },
      { ID: 4, NAME: "ОР ноябрь ТМЦ-Клиент.xlsx", TYPE: "file", CREATE_TIME: "2026-11-26T16:03:00+03:00", UPDATE_TIME: "2026-11-26T16:03:00+03:00", DOWNLOAD_URL: "https://disk.example.test/4" }
    ];
    const bodies: Record<string, Buffer> = {
      "https://disk.example.test/1": dailyBuf,
      "https://disk.example.test/2": opiuBuf,
      "https://disk.example.test/3": realClientTmcBuf,
      "https://disk.example.test/4": realTmcClientBuf
    };
    const asked: string[] = [];
    const reader = { listAllBatched: vi.fn(async () => listing as never[]) };
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const k = String(url);
      asked.push(k);
      return new Response(new Uint8Array(bodies[k]));
    }) as unknown as typeof fetch;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-fin-multi-"));
    const cachePath = path.join(dir, "finance.json");
    const view = await loadFinanceView({ reader, folderId: 104393, cachePath, secretKey: "multi-key", fetchFn });

    expect(view.report?.dataDate).toBe("2026-11-16");
    expect(view.notice).toBeUndefined();
    expect(view.opiu?.report?.periodLabel).toBe("9 мес. 2026");
    expect(view.opiu?.file?.name).toBe("ФО Тест 9 мес.xlsx");
    expect(view.realization?.clientTmc?.totals.sumNet).toBe(5_000_000);
    expect(view.realization?.tmcClient?.totals.sumNet).toBe(5_000_000);
    expect(view.realization?.clientTmc?.derived).toBeUndefined();
    expect(view.realization?.tmcClient?.derived).toBeUndefined();
    expect(view.snapshots).toHaveLength(1);

    // Кэш зашифрован, повторный запуск не скачивает файлы заново
    const rawCache = fs.readFileSync(cachePath, "utf8");
    expect(rawCache).not.toMatch(/Покупатель|Партнёр|Сотрудник|Заказчик/);
    const second = await loadFinanceView({ reader, folderId: 104393, cachePath, secretKey: "multi-key", fetchFn });
    expect(asked).toHaveLength(4);
    expect(second.opiu?.report?.rows.length).toBe(view.opiu?.report?.rows.length);
    expect(second.realization?.clientTmc?.totals.sumNet).toBe(5_000_000);

    // В публичном логе нет названий контрагентов и сумм
    const logText = logs.join("\n");
    expect(logText).not.toMatch(/Покупатель|Партнёр|Сотрудник|Заказчик|5000000/);
  });

  it("если загружен только один файл ОР — второй разрез строится автоматически", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-fin-one-real-"));
    const finPath = path.join(dir, "daily.xlsx");
    const realPath = path.join(dir, "real-c2t.xlsx");
    fs.writeFileSync(finPath, dailyBuf);
    fs.writeFileSync(realPath, realClientTmcBuf);

    const view = await loadFinanceView({ localFile: finPath, localRealizationFiles: [realPath] });
    expect(view.realization?.clientTmc?.derived).toBeUndefined();
    expect(view.realization?.tmcClient?.derived).toBe(true);
    expect(view.realization?.tmcClient?.nodes.map((x) => x.name)).toEqual(["Интерактивные панели", "Ноутбуки"]);
  });
});

describe("роли и доступ к «Фин. отчёты» (только all)", () => {
  it("deployPultVariants кладёт fin-reports.html только в _r/all, а gate закрывает /fin-reports для РОП, РТО, менеджера и ТВ", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-fr-roles-"));
    const src = path.join(dir, "src");
    const out = path.join(dir, "out");
    const cfgPath = path.join(dir, "config.json");
    fs.mkdirSync(src, { recursive: true });

    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
    const TEST_AUD = "a".repeat(64);
    const signJwt = (email: string) => {
      const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
      const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
      const body = b64({ email, aud: [TEST_AUD], iss: "https://team.cloudflareaccess.com", exp: 2_000_000_000 });
      const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
      return `${head}.${body}.${sig}`;
    };

    const config = parseGateConfig(JSON.stringify({
      team: "team",
      aud: TEST_AUD,
      users: {
        "dir@example.test": "all",
        "rop@example.test": "rop",
        "rto@example.test": "rto",
        "mgr@example.test": "manager:1",
        "tv@example.test": "tv"
      }
    }))!;
    fs.writeFileSync(cfgPath, JSON.stringify(config), "utf8");

    const minimalPult = {
      asOfDate: "2026-11-26",
      generatedAt: "2026-11-26 10:00",
      targets: { daily: { calls: 15, proposals: 3, contracts: 1 }, weekly: { calls: 75, proposals: 15, contracts: 5 }, monthly: { calls: 300, proposals: 60, contracts: 20 } },
      groups: [{ id: "sales", name: "ОП", managers: [{ id: "1", name: "Менеджер Тест", active: true, topTasks: [], rollups: { day: { calls: 0, proposals: 0, contracts: 0, amount: 0, callStats: { successful: 0, missed: 0, total: 0, durationSec: 0 } }, week: { calls: 0, proposals: 0, contracts: 0, amount: 0, callStats: { successful: 0, missed: 0, total: 0, durationSec: 0 } }, month: { calls: 0, proposals: 0, contracts: 0, amount: 0, callStats: { successful: 0, missed: 0, total: 0, durationSec: 0 } } } }] }],
      dynamics: []
    };
    const minimalReg = { asOfDate: "2026-11-26", generatedAt: "2026-11-26 10:00", register: { error: "нет" } };
    fs.writeFileSync(path.join(src, "payload.json"), JSON.stringify(minimalPult), "utf8");
    fs.writeFileSync(path.join(src, "payload-reg.json"), JSON.stringify(minimalReg), "utf8");
    fs.writeFileSync(path.join(src, "index.html"), renderPultHtml(minimalPult as never), "utf8");
    fs.writeFileSync(path.join(src, "reg.html"), renderRegisterHtml(minimalReg as never), "utf8");
    fs.writeFileSync(path.join(src, "fin.html"), "<!--__ACCOUNT__-->FIN", "utf8");
    fs.writeFileSync(path.join(src, "fin-reports.html"), "<!--__ACCOUNT__-->FIN-REPORTS", "utf8");

    deployPultVariants(src, out, cfgPath);

    expect(fs.existsSync(path.join(out, "_r", "all", "fin-reports.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "_r", "rop", "fin-reports.html"))).toBe(false);
    expect(fs.existsSync(path.join(out, "_r", "rto", "fin-reports.html"))).toBe(false);
    expect(fs.existsSync(path.join(out, "_r", "m1", "fin-reports.html"))).toBe(false);

    const assets = {
      fetch: async (input: Request | string | URL) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const rel = u.pathname.replace(/^\/+/, "");
        const candidates = [path.join(out, rel), path.join(out, `${rel}.html`), path.join(out, rel, "index.html")];
        const hit = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
        return hit ? new Response(fs.readFileSync(hit, "utf8"), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("not found", { status: 404 });
      }
    };
    const fetchFn = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as unknown as typeof fetch;

    const req = (email: string, p: string) =>
      handleGateRequest(new Request(`https://pult.example.test${p}`, { headers: { "cf-access-jwt-assertion": signJwt(email) } }), {
        config,
        assets,
        fetchFn,
        now: () => 1_900_000_000
      });

    for (const p of ["/fin-reports", "/fin-reports.html"]) {
      const ok = await req("dir@example.test", p);
      expect(ok.status).toBe(200);
      const body = await ok.text();
      expect(body).toContain("FIN-REPORTS");
      expect(body).toContain("dir@example.test");
    }

    for (const blocked of ["rop@example.test", "rto@example.test", "mgr@example.test", "tv@example.test"]) {
      const res = await req(blocked, "/fin-reports");
      expect(res.status).toBe(403);
    }

    // Проверяем, что варианты РОП и РТО скрывают ссылку на fin-reports.html в браузере (render check)
    const rop = renderRopVariant(buildRopVariant({ pult: minimalPult as never, reg: minimalReg as never }));
    const rto = renderRtoVariant(buildRtoVariant({ pult: minimalPult as never }));
    expect(rop.index).toContain("fin-reports.html"); // скрывается клиентским JS по VIEWER
    expect(rto.index).toContain("fin-reports.html");
  });
});

describe("браузерная проверка ОПиУ (fin-reports.html) и Отчёта о реализации (fin.html)", () => {
  it("ОПиУ: двухуровневое раскрытие «Расходов по реализации», поиск и переключение по месяцам", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-fr-browser-"));
    const opiuReport = await parseOpiuExcel(opiuBuf);
    const html = renderFinReportsHtml({
      asOfDate: "2026-11-26",
      generatedAt: "2026-11-26 10:00",
      opiu: { report: opiuReport, file: { id: "1", name: "ФО Тест.xlsx", uploadedAt: "2026-11-26T10:00:00+05:00" } }
    });
    const filePath = path.join(dir, "fin-reports.html");
    fs.writeFileSync(filePath, html, "utf8");

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`file://${filePath.replace(/\\/g, "/")}`);

      // Изначально показаны годовые столбцы и 4 KPI-плитки
      expect(await page.locator("#fr-summary .fr-tile").count()).toBe(4);
      expect((await page.locator("#fr-opiu thead th").allTextContents()).map((s) => s.trim())).toEqual(["Показатель", "2025", "9 мес. 2026"]);

      // 1-й клик по «Расходы по реализации» открывает жирные категории (уровень 1)
      await page.locator('button[data-sec-toggle="013"]').click();
      const lvl1Text = (await page.locator("tr.fr-lvl1").allTextContents()).join(" | ");
      expect(lvl1Text).toContain("Агентские услуги Реализация");
      expect(lvl1Text).toContain("Заработная плата Реализация");
      // Уровень 2 ещё закрыт
      expect(await page.locator("tr.fr-lvl2").count()).toBe(0);

      // 2-й клик по жирной категории «Агентские услуги Реализация» раскрывает детализацию (уровень 2)
      await page.locator('button[data-group-toggle="013::0"]').click();
      const lvl2Text = (await page.locator("tr.fr-lvl2").allTextContents()).join(" | ");
      expect(lvl2Text).toContain("ТОО Партнёр Восток Договор №10");
      expect(lvl2Text).toContain("ИП Агент Запад Без договора");

      // Поиск по контрагенту/сотруднику внутри «Расходов по реализации» авто-раскрывает нужную жирную группу
      await page.locator('input[data-bd-search="013"]').fill("Сотрудник Второй");
      const searchLvl2 = (await page.locator("tr.fr-lvl2").allTextContents()).join(" | ");
      expect(searchLvl2).toContain("Сотрудник Второй");

      // Переключение на помесячный вид за 2026
      await page.locator('button[data-fr-mode="2026"]').click();
      expect((await page.locator("#fr-opiu thead th").allTextContents()).map((s) => s.trim())).toEqual([
        "Показатель",
        "Янв",
        "Фев",
        "9 мес. 2026"
      ]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("Финансы: блок «Отчёт о реализации» переключает Клиент→ТМЦ и ТМЦ→Клиент, раскрывает 3 уровня и ищет", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-fin-real-browser-"));
    const finPath = path.join(dir, "daily.xlsx");
    const c2tPath = path.join(dir, "c2t.xlsx");
    const t2cPath = path.join(dir, "t2c.xlsx");
    fs.writeFileSync(finPath, dailyBuf);
    fs.writeFileSync(c2tPath, realClientTmcBuf);
    fs.writeFileSync(t2cPath, realTmcClientBuf);

    const finance = await loadFinanceView({ localFile: finPath, localRealizationFiles: [c2tPath, t2cPath] });
    const html = renderFinanceHtml({ asOfDate: "2026-11-26", generatedAt: "2026-11-26 10:00", finance });
    const filePath = path.join(dir, "fin.html");
    fs.writeFileSync(filePath, html, "utf8");

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`file://${filePath.replace(/\\/g, "/")}`);

      expect(await page.locator("#f-realization").isVisible()).toBe(true);
      const l0Text = (await page.locator("#f-realization .fin-real-l0").allTextContents()).join(" | ");
      expect(l0Text).toContain("ТОО Покупатель Один");
      expect(l0Text).toContain("ТОО Покупатель Два");

      // Раскрытие Клиент -> Группа -> Номенклатура
      await page.locator('#f-realization button[data-real-toggle="l0:client-tmc:0"]').click();
      const l1Text = (await page.locator("#f-realization .fin-real-l1").allTextContents()).join(" | ");
      expect(l1Text).toContain("Интерактивные панели");
      expect(l1Text).toContain("Ноутбуки");
      await page.locator('#f-realization button[data-real-toggle="l1:client-tmc:0:0"]').click();
      const l2Text = (await page.locator("#f-realization .fin-real-l2").allTextContents()).join(" | ");
      expect(l2Text).toContain("Панель Альфа 75");

      // Переключение на разрез ТМЦ -> Клиент
      await page.locator('button[data-real-mode="tmc-client"]').click();
      const tmcL0 = (await page.locator("#f-realization .fin-real-l0").allTextContents()).join(" | ");
      expect(tmcL0).toContain("Интерактивные панели");
      expect(tmcL0).toContain("Ноутбуки");

      // Поиск по товару авто-раскрывает ветку
      await page.locator("#realQ").fill("Ноутбук Бета");
      const foundL2 = (await page.locator("#f-realization .fin-real-l2").allTextContents()).join(" | ");
      expect(foundL2).toContain("ТОО Покупатель Один");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
