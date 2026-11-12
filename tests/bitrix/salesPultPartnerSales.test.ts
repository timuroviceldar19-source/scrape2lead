import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { chromium, type Browser } from "playwright";
import { parseRegisterWorkbook } from "../../src/bitrix/salesPult/register/parseExcel.js";
import { buildRegisterView } from "../../src/bitrix/salesPult/register/buildView.js";
import { buildRegisterMonthSummary } from "../../src/bitrix/salesPult/register/history.js";
import type { RegisterRow, RegisterSuccessView } from "../../src/bitrix/salesPult/register/types.js";
import { attachRegisterContracts } from "../../src/bitrix/salesPult/contracts.js";
import { buildPultView } from "../../src/bitrix/salesPult/view.js";
import { renderPultHtml, renderRegisterHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { loadMarketView } from "../../src/kz/market/load.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import type { MarketUnit } from "../../src/kz/market/types.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";

// Все данные этого файла выдуманные.
const row = (extra: Partial<RegisterRow>): RegisterRow => ({
  date: "2026-11-05", type: "зцп", customer: "Тестовая школа", qty: 1, product: "панель", cost: 0, extras: 0,
  sale: 1000, portal: 1000, val: 300, bonusMop: 30, bonusRop: 5, manager: "Менеджер А", note: null,
  group: "ИП", kind: "Интерактивные панели", channel: "Запрос ценовых предложений", ...extra
});
const own = [
  row({}),
  row({ date: "2026-11-06", customer: "Тестовая гимназия", product: "моноблок", group: "КТ", kind: "Моноблоки", sale: 500, val: 100, bonusMop: 15, bonusRop: 2, manager: "Менеджер Б", type: "ом", channel: "Электронный магазин" })
];
const partner = row({
  date: "2026-11-07", customer: "Тестовый колледж", product: "мульт сист", kind: "Мультимедийные системы",
  sale: 2000, val: 120, bonusMop: 10, bonusRop: 2, type: "ок", channel: "Открытый конкурс", partner: true
});
const plans = { "Менеджер А": 3000, "Менеджер Б": 2000 };
const view = (rows: RegisterRow[]) => buildRegisterView({
  rows, plans, missing: [], extraDealsCount: 0, fileName: "ОП 07.11.26.xlsx", asOf: "2026-11-07", month: "2026-11", hasValColumn: true
}) as RegisterSuccessView;

describe("партнёрские продажи: реестр", () => {
  it("помечает мультимедийные системы в любом написании как партнёрские", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");
    ws.getRow(1).values = [null, "Дата договора", "Контрагент", "Товар", "Сумма продажи без НДС", "Менеджер"];
    ["панель", "мульт сист", "мульт система", "Мульт комплекс", "моноблок"].forEach((product, i) => {
      ws.getRow(i + 2).values = [null, "2026-11-02", `Заказчик ${i}`, product, 100, "Менеджер А"];
    });
    const parsed = parseRegisterWorkbook(wb, "ОП 03.11.26.xlsx");
    expect(parsed.rows.map((r) => [r.product, r.kind, r.partner])).toEqual([
      ["панель", "Интерактивные панели", false],
      ["мульт сист", "Мультимедийные системы", true],
      ["мульт система", "Мультимедийные системы", true],
      ["Мульт комплекс", "Мультимедийные системы", true],
      ["моноблок", "Моноблоки", false]
    ]);
  });

  it("не считает партнёрские продажи в выручке, вале, бонусах, договорах, плане и разбивках", () => {
    const v = view([...own, partner]);
    expect(v.total).toMatchObject({ sale: 1500, val: 400, bonusMop: 45, bonusRop: 7, contracts: 2, plan: 5000 });
    expect(v.total.margin).toBeCloseTo(400 / 1500);
    expect(v.daily.at(-1)).toEqual({ d: "2026-11-06", sale: 1500 });
    expect(v.managers.find((m) => m.name === "Менеджер А")).toMatchObject({ sale: 1000, val: 300, bonus: 30, contracts: 1 });
    expect(v.mix.map((x) => x.kind)).toEqual(["Интерактивные панели", "Моноблоки"]);
    expect(v.channels.map((x) => x.name)).toEqual(["Запрос ценовых предложений", "Электронный магазин"]);
    expect(v.groups.find((g) => g.g === "ИП")).toEqual({ g: "ИП", sale: 1000, val: 300 });
    expect(v.partner).toMatchObject({ sale: 2000, val: 120, bonusMop: 10, bonusRop: 2, contracts: 1, kinds: ["Мультимедийные системы"] });
    expect(v.partner!.margin).toBeCloseTo(0.06);
    expect(v.partner!.rows.map((r) => r.customer)).toEqual(["Тестовый колледж"]);
    // Список «Все договоры месяца» и сверка с CRM видят все строки.
    expect(v.rows).toHaveLength(3);
  });

  it("без партнёрских строк блока нет и итоги прежние", () => {
    const v = view(own);
    expect(v.partner).toBeUndefined();
    expect(v.total).toMatchObject({ sale: 1500, contracts: 2 });
  });

  it("история месяцев тоже считает партнёрские продажи отдельно", () => {
    const s = buildRegisterMonthSummary({ month: "2026-11", fileName: "ОП 30.11.26.xlsx", rows: [...own, partner], plans, hasValColumn: true });
    expect(s).toMatchObject({ sale: 1500, val: 400, contracts: 2, partnerSale: 2000, partnerContracts: 1 });
    expect(s.planPct).toBeCloseTo(30);
    expect(s.byManager.find((m) => m.name === "Менеджер А")).toMatchObject({ sale: 1000, contracts: 1 });
    expect(s.dailyContracts!.map((d) => d.date)).toEqual(["2026-11-05", "2026-11-06"]);
    const plain = buildRegisterMonthSummary({ month: "2026-11", fileName: "ОП 30.11.26.xlsx", rows: own, plans, hasValColumn: true });
    expect(plain.partnerSale).toBeUndefined();
  });
});

describe("партнёрские продажи: главная", () => {
  const partnerFixture = () => {
    const f = fixture([{ id: "d4", title: "Каппа", amount: 2000, assignedById: "s", stageSemanticId: "S" }]);
    const partnerRow: RegisterRow = { ...f.rows[0], customer: "Каппа", sale: 2000, product: "мульт сист", kind: "Мультимедийные системы", group: "ИП", partner: true };
    const register = buildRegisterView({
      fileName: "ОП тест.xlsx", asOf: "2026-10-28", month: "2026-10", rows: [...f.rows, partnerRow],
      plans: { Алия: 1000, Борис: 1000, B2B: 500 }, missing: [], extraDealsCount: 0
    });
    return { ...f, register };
  };

  it("выручка и договоры месяца без партнёрских, но сделка партнёрской продажи не висит в «ждут ОП»", () => {
    const f = partnerFixture();
    attachRegisterContracts(f.payload, f.register, f.deals, f.aliases);
    const v = buildPultView(f.payload);
    expect(v.month).toMatchObject({ fact: 3, amount: 600, revenuePlan: 2500, awaitingRegister: 1, partnerAmount: 2000, partnerContracts: 1 });
    expect(v.periods.month.sales.managers[0].contracts.totalAmount).toBe(100);
    expect(v.month.split.map((x) => [x.name, x.c, x.a])).toEqual([["Продажи", 1, 100], ["Тендеры", 1, 200], ["Другие", 1, 300]]);
  });

  it("закрытый месяц из истории тоже без партнёрских", () => {
    const f = fixture();
    const summary = buildRegisterMonthSummary({ month: "2026-10", fileName: "ОП 31.10.26.xlsx", rows: [...f.rows, { ...f.rows[0], customer: "Каппа", sale: 2000, partner: true }], plans: { Алия: 1000 } });
    f.payload.closedMonth = true;
    attachRegisterContracts(f.payload, { error: "нет файла", history: { asOf: "2026-10-31", months: [summary] } }, new Map(), f.aliases);
    expect(buildPultView(f.payload).month).toMatchObject({ amount: 600, partnerAmount: 2000, partnerContracts: 1 });
  });
});

describe("партнёрские продажи: страницы", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  for (const width of [1440, 375]) {
    it(`страница «Выручка» показывает отдельный блок на ${width}`, async () => {
      const reg: RegisterPagePayload = { asOfDate: "2026-11-07", generatedAt: "2026-11-07 12:00 (UTC+5)", portal: "https://example.invalid", register: view([...own, partner]) };
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.setContent(renderRegisterHtml(reg));
        expect(await page.locator("#r-month .hero-amt").textContent()).toContain("2 договора");
        expect(await page.locator("#r-month .verdict").textContent()).toContain("Партнёрские продажи");
        const block = page.locator("#r-partner");
        expect(await block.locator("h2").textContent()).toContain("Партнёрские продажи");
        expect(await block.textContent()).toContain("не входят в выручку");
        expect(await block.locator(".gsum").textContent()).toMatch(/6%/);
        expect(await block.locator(".partner .r:not(.head)").count()).toBe(1);
        expect(await block.locator(".partner .r:not(.head)").textContent()).toContain("Тестовый колледж");
        expect(await page.locator(".mix.rows").first().textContent()).not.toContain("Мультимедийные");
        expect(await page.locator("#regAll .partner-tag").count()).toBe(1);
        const idx = await page.locator(".block-head .idx").evaluateAll((es) => es.map((e) => e.textContent));
        expect(idx.slice(0, 3)).toEqual(["01", "02", "03"]);
        expect(new Set(idx).size).toBe(idx.length);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    });
  }

  it("без партнёрских продаж блока нет", async () => {
    const reg: RegisterPagePayload = { asOfDate: "2026-11-07", generatedAt: "2026-11-07 12:00 (UTC+5)", register: view(own) };
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.setContent(renderRegisterHtml(reg));
      expect(await page.locator("#r-partner").count()).toBe(0);
      expect(await page.locator("#r-month .verdict").textContent()).not.toContain("Партнёрские");
    } finally { await page.close(); }
  });

  it("плитка «Выручка» на главной показывает партнёрские продажи отдельно", async () => {
    const f = fixture([{ id: "d4", title: "Каппа", amount: 2000000, assignedById: "s", stageSemanticId: "S" }]);
    const register = buildRegisterView({
      fileName: "ОП тест.xlsx", asOf: "2026-10-28", month: "2026-10",
      rows: [...f.rows, { ...f.rows[0], customer: "Каппа", sale: 2000000, partner: true }],
      plans: { Алия: 1000, Борис: 1000, B2B: 500 }, missing: [], extraDealsCount: 0
    });
    attachRegisterContracts(f.payload, register, f.deals, f.aliases);
    const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.setContent(renderPultHtml(f.payload));
      const tile = page.locator(".month-tiles > .month-tile").nth(1);
      expect(await tile.locator(".tile-note").textContent()).toContain("партнёрские 2,0 млн отдельно");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  });
});

describe("партнёрские продажи: рынок", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const unit = (id: number, kind: string, code: string, sum: number, supplier: string): MarketUnit => ({
    id, sum, kind, code, month: "2026-11", date: "2026-11-05", group: "ИП", qty: 1, price: sum, supplier,
    customer: `customer-${id}`, supplierName: `Поставщик ${id}`, customerName: `Заказчик ${id}`, method: "Открытый конкурс", us: false
  });

  it("скрывает мультимедийные системы из всех срезов рынка, не трогая кэш и ключ конфига", () => {
    const cfg = { ...loadMarketConfig(), ourBins: ["111111111111"], ourCompanyNames: { "111111111111": "Компания Альфа" } };
    expect(cfg.hiddenKinds).toEqual(["Мультимедийные системы"]);
    const units = [
      unit(1, "Интерактивные панели", "262030.100.000021", 100, "111111111111"),
      unit(2, "Мультимедийные системы", "262030.100.000011", 900, "111111111111"),
      unit(3, "Интерактивные панели", "262030.100.000021", 300, "333333333333"),
      unit(4, "Мультимедийные системы", "262030.100.000013", 700, "333333333333")
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-hidden-")); dirs.push(dir);
    const unitsFilePath = path.join(dir, "units.json"), educationVerdictsFilePath = path.join(dir, "verdicts.json");
    fs.writeFileSync(unitsFilePath, JSON.stringify({ units }));
    fs.writeFileSync(educationVerdictsFilePath, "[]");
    const v = loadMarketView({ unitsFilePath, educationVerdictsFilePath, todayAlmaty: "2026-11-12", cfg });
    const nov = v.ip!.monthViews!["2026-11"];
    expect(nov.total).toMatchObject({ sum: 400, contracts: 2 });
    expect(nov.us).toMatchObject({ sum: 100, share: 0.25 });
    expect(nov.kinds.map((k) => k.kind)).toEqual(["Интерактивные панели"]);
    expect(nov.suppliers.flatMap((s) => s.contractList!.map((c) => c.kind))).not.toContain("Мультимедийные системы");
    expect(nov.lost.map((x) => x.id)).toEqual([3]);
    expect(v.ip!.months.map((m) => [m.m, m.sum, m.us])).toEqual([["2026-11", 400, 100]]);
    expect(JSON.parse(fs.readFileSync(unitsFilePath, "utf8")).units).toHaveLength(4);
  });
});
