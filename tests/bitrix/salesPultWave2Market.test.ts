import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  buildAllMarketMonthContracts,
  buildMarketGroupView,
  buildMarketMonthContracts,
  buildMarketView,
  filterMarketUnitsForView
} from "../../src/kz/market/aggregate.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import { EDUCATION_CODE } from "../../src/kz/market/educationImport.js";
import type { EducationVerdict } from "../../src/kz/market/educationVerdicts.js";
import type { MarketMonthContractsPayload, MarketUnit } from "../../src/kz/market/types.js";
import { renderPultHtml, type SalesPultPayload, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { parseGateConfig } from "../../src/bitrix/salesPult/gate/config.js";
import { clearJwksCache } from "../../src/bitrix/salesPult/gate/accessJwt.js";
import { handleGateRequest } from "../../src/bitrix/salesPult/gate/handler.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { deployPultVariants } from "../../scripts/pult-variants.mjs";
import { writeMarketMonthContractFiles } from "../../scripts/sales-pult.mjs";

const cfg = loadMarketConfig();
const ourBin = typeof cfg.ourBins[0] === "string" ? cfg.ourBins[0] : cfg.ourBins[0].bin;

const TEAM = "example-team";
const AUD = "a".repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const NOW_MS = 1_800_000_000_000;

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  return { pair, jwk };
}

async function signJwt(privateKey: CryptoKey, kid: string, email: string) {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify({
    iss: ISS,
    aud: [AUD],
    email,
    iat: NOW_MS / 1000 - 60,
    nbf: NOW_MS / 1000 - 60,
    exp: NOW_MS / 1000 + 3600
  }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

function makeSyntheticUnits(): MarketUnit[] {
  const units: MarketUnit[] = [];
  // ИП 2026-10: 65 уникальных договоров (один из них многопозиционный с одинаковым id=9001).
  units.push(
    {
      id: 9001,
      unitIndex: 0,
      month: "2026-10",
      date: "2026-10-15",
      group: "ИП",
      code: "262030.100.000021",
      kind: "Интерактивные панели",
      sum: 1_200_000,
      qty: 2,
      price: 600_000,
      supplier: ourBin,
      customer: "111111111101",
      supplierName: 'ТОО "Альфа Тест"',
      customerName: "Учебный центр 1",
      method: "Открытый конкурс",
      us: true
    },
    {
      id: 9001,
      unitIndex: 1,
      month: "2026-10",
      date: "2026-10-15",
      group: "ИП",
      code: "262030.100.000021",
      kind: "Интерактивные панели",
      sum: 800_000,
      qty: 1,
      price: 800_000,
      supplier: ourBin,
      customer: "111111111101",
      supplierName: 'ТОО "Альфа Тест"',
      customerName: "Учебный центр 1",
      method: "Открытый конкурс",
      us: true
    }
  );
  for (let i = 1; i < 65; i++) {
    const isUs = i % 5 === 0;
    units.push({
      id: 10_000 + i,
      month: "2026-10",
      date: `2026-10-${String((i % 25) + 1).padStart(2, "0")}`,
      group: "ИП",
      code: "262030.100.000021",
      kind: "Интерактивные панели",
      sum: 1_000_000 + i * 50_000,
      qty: (i % 4) + 1,
      price: 500_000,
      supplier: isUs ? ourBin : `999000000${String(i).padStart(3, "0")}`,
      customer: `111000000${String(i).padStart(3, "0")}`,
      supplierName: isUs ? 'ТОО "Альфа Тест"' : `Поставщик ИП-${String(i).padStart(2, "0")}`,
      customerName: `Заказчик ИП-${String(i).padStart(2, "0")}`,
      method: i % 2 === 0 ? "Открытый конкурс" : "Электронный магазин",
      us: isUs
    });
  }
  // ИП 2026-09: 3 договора для проверки переключения месяца и защиты от гонок.
  for (let i = 1; i <= 3; i++) {
    units.push({
      id: 20_000 + i,
      month: "2026-09",
      date: `2026-09-0${i}`,
      group: "ИП",
      code: "262030.100.000021",
      kind: "Интерактивные панели",
      sum: i * 1_500_000,
      qty: i,
      price: 1_500_000,
      supplier: `88800000000${i}`,
      customer: `22200000000${i}`,
      supplierName: `Поставщик Сентябрь-${i}`,
      customerName: `Заказчик Сентябрь-${i}`,
      method: "Запрос ценовых предложений",
      us: false
    });
  }
  // КТ 2026-10: 4 договора.
  for (let i = 1; i <= 4; i++) {
    units.push({
      id: 30_000 + i,
      month: "2026-10",
      date: `2026-10-1${i}`,
      group: "КТ",
      code: "262011.100.000001",
      kind: "Ноутбуки",
      sum: i * 900_000,
      qty: i * 2,
      price: 450_000,
      supplier: i === 1 ? ourBin : `77700000000${i}`,
      customer: `33300000000${i}`,
      supplierName: i === 1 ? 'ТОО "Альфа Тест"' : `Поставщик КТ-${i}`,
      customerName: `Заказчик КТ-${i}`,
      method: "Электронный магазин",
      us: i === 1
    });
  }
  return units;
}

describe("волна 2: помесячные JSON рынка, выкладка, gate и замеры", () => {
  it("сборка JSON 100% сходится с месячной сводкой (вкл. многопозиционный договор, hiddenKinds, вердикты и пустые месяцы)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-wave2-data-"));
    try {
      const units = makeSyntheticUnits();
      const hiddenKind = (cfg.hiddenKinds && cfg.hiddenKinds[0]) || "Мультимедийные системы";
      const hiddenUnit: MarketUnit = {
        id: 80_001,
        month: "2026-10",
        date: "2026-10-12",
        group: "ИП",
        code: "262030.100.000011",
        kind: hiddenKind,
        sum: 9_999_999,
        qty: 5,
        price: 1_999_999,
        supplier: "555555555555",
        customer: "666666666666",
        supplierName: "Скрытый поставщик",
        customerName: "Скрытый заказчик",
        method: "Открытый конкурс",
        us: false
      };
      const eduYes: MarketUnit = {
        id: 80_002,
        month: "2026-10",
        date: "2026-10-13",
        group: "ИП",
        code: EDUCATION_CODE,
        kind: "Учебные комплекты",
        sum: 2_500_000,
        qty: 1,
        price: 2_500_000,
        supplier: "555555555556",
        customer: "666666666667",
        supplierName: "Комплект Да",
        customerName: "Школа Комплект",
        method: "Открытый конкурс",
        us: false
      };
      const eduNo: MarketUnit = {
        ...eduYes,
        id: 80_003,
        supplierName: "Комплект Нет"
      };
      const eduPending: MarketUnit = {
        ...eduYes,
        id: 80_004,
        month: "2026-11",
        date: "2026-11-05",
        supplierName: "Комплект На Проверке"
      };
      const verdicts: EducationVerdict[] = [
        { id: "80002", verdict: "Да", source: "договор" },
        { id: "80003", verdict: "Нет", source: "объявление" }
      ];
      const allInput = [
        ...units,
        hiddenUnit,
        // Скрытая позиция внутри того же многопозиционного договора 9001 не должна попадать в итог и в JSON
        { ...hiddenUnit, id: 9001, unitIndex: 2, supplier: ourBin, supplierName: 'ТОО "Альфа Тест"', customer: "111111111101", customerName: "Учебный центр 1", us: true },
        eduYes,
        eduNo,
        eduPending
      ];
      const unitsFilePath = path.join(dir, "units.json");
      const verdictsFilePath = path.join(dir, "verdicts.json");
      const outDir = path.join(dir, "exports");
      fs.writeFileSync(unitsFilePath, JSON.stringify({ updatedAt: "2026-11-10", units: allInput }));
      fs.writeFileSync(verdictsFilePath, JSON.stringify(verdicts));

      const filtered = filterMarketUnitsForView(allInput, cfg, verdicts);
      const marketView = buildMarketView(filtered.units, "2026-11-10", cfg, undefined, "2026-11-10", filtered.educationPending);
      const written = writeMarketMonthContractFiles({
        outDir,
        todayAlmaty: "2026-11-10",
        unitsFilePath,
        educationVerdictsFilePath: verdictsFilePath,
        cfg
      });

      expect(written.ipMonths).toEqual(["2026-09", "2026-10", "2026-11"]);
      expect(written.ktMonths).toEqual(Object.keys(marketView.kt!.monthViews!).sort());
      expect(written.ktMonths).toEqual(["2026-10"]);

      // Явный additionalMonths также создаёт пустой JSON
      const withExtra = buildAllMarketMonthContracts(filtered.units, "2026-11-10", cfg, filtered.educationPending, ["2026-08"]);
      expect(withExtra.kt["2026-08"]).toEqual({
        group: "КТ",
        month: "2026-08",
        total: { contracts: 0, sum: 0, qty: 0 },
        contracts: []
      });

      for (const month of written.ipMonths) {
        const payload = JSON.parse(fs.readFileSync(path.join(outDir, "market/ip", `${month}.json`), "utf8")) as MarketMonthContractsPayload;
        const summary = marketView.ip!.monthViews![month];
        expect(payload.total.contracts).toBe(summary.total.contracts);
        expect(payload.contracts).toHaveLength(summary.total.contracts);
        expect(payload.total.sum).toBe(summary.total.sum);
        expect(payload.total.qty).toBe(summary.total.qty);
        expect(payload.contracts.reduce((s, c) => s + c.sum, 0)).toBe(summary.total.sum);
      }

      for (const month of written.ktMonths) {
        const payload = JSON.parse(fs.readFileSync(path.join(outDir, "market/kt", `${month}.json`), "utf8")) as MarketMonthContractsPayload;
        const summary = marketView.kt!.monthViews![month];
        expect(payload.total.contracts).toBe(summary.total.contracts);
        expect(payload.contracts).toHaveLength(summary.total.contracts);
        expect(payload.total.sum).toBe(summary.total.sum);
      }

      // Многопозиционный договор 9001 объединён в 1 запись с суммой 1_200_000 + 800_000 = 2_000_000 и qty = 3
      const octIp = JSON.parse(fs.readFileSync(path.join(outDir, "market/ip/2026-10.json"), "utf8")) as MarketMonthContractsPayload;
      const multi = octIp.contracts.find((c) => c.id === 9001);
      expect(multi).toEqual({
        id: 9001,
        date: "2026-10-15",
        supplier: 'ТОО "Альфа Тест"',
        customer: "Учебный центр 1",
        kind: "Интерактивные панели",
        method: "Открытый конкурс",
        qty: 3,
        sum: 2_000_000,
        us: true
      });
      // Проверка набора полей и исключения скрытых/отклонённых/ожидающих
      expect(Object.keys(multi!).sort()).toEqual(["customer", "date", "id", "kind", "method", "qty", "sum", "supplier", "us"]);
      expect(octIp.contracts.some((c) => c.id === 80_001 || c.id === 80_003)).toBe(false);
      expect(octIp.contracts.some((c) => c.id === 80_002)).toBe(true);

      // Пустой месяц 2026-11 из educationPending отдаётся корректно
      const novIp = JSON.parse(fs.readFileSync(path.join(outDir, "market/ip/2026-11.json"), "utf8")) as MarketMonthContractsPayload;
      expect(novIp).toEqual({
        group: "ИП",
        month: "2026-11",
        total: { contracts: 0, sum: 0, qty: 0 },
        contracts: []
      });

      // Замер размеров: index.html vs месячный JSON
      const basePult: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
      const htmlWithoutFullList = renderPultHtml({ ...basePult, market: marketView });
      const htmlWithHypotheticalEmbedded = renderPultHtml({
        ...basePult,
        market: { ...marketView, embeddedContractsForMeasure: octIp.contracts } as unknown as typeof marketView
      });
      const indexBytes = Buffer.byteLength(htmlWithoutFullList, "utf8");
      const embeddedBytes = Buffer.byteLength(htmlWithHypotheticalEmbedded, "utf8");
      const monthJsonBytes = fs.statSync(path.join(outDir, "market/ip/2026-10.json")).size;
      console.log(`[Замер] index.html (без полного списка): ${indexBytes} байт; с гипотетическим полным списком в __PAYLOAD__: ${embeddedBytes} байт; один месячный JSON (66 договоров): ${monthJsonBytes} байт`);
      expect(htmlWithoutFullList).not.toContain("Заказчик ИП-01");
      expect(htmlWithHypotheticalEmbedded).toContain("Заказчик ИП-01");
      expect(indexBytes).toBeLessThan(embeddedBytes);
      expect(monthJsonBytes).toBeGreaterThan(500);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pult-variants копирует market/ в _r/all/market и _r/m<ID>/market, но не в tv", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-variants-"));
    try {
      const src = path.join(dir, "src");
      const out = path.join(dir, "deploy");
      fs.mkdirSync(path.join(src, "market/ip"), { recursive: true });
      fs.mkdirSync(path.join(src, "market/kt"), { recursive: true });
      const basePult: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
      const firstMgrId = basePult.groups[0].managers[0].id;
      const regPayload: RegisterPagePayload = {
        asOfDate: basePult.asOfDate,
        generatedAt: basePult.generatedAt,
        register: { error: "не подключён" }
      };
      fs.writeFileSync(path.join(src, "index.html"), renderPultHtml(basePult));
      fs.writeFileSync(path.join(src, "reg.html"), "REG");
      fs.writeFileSync(path.join(src, "fin.html"), "FIN");
      fs.writeFileSync(path.join(src, "payload.json"), JSON.stringify(basePult));
      fs.writeFileSync(path.join(src, "payload-reg.json"), JSON.stringify(regPayload));
      fs.writeFileSync(path.join(src, "plan-deals.json"), "[]");
      fs.writeFileSync(path.join(src, "market/ip/2026-10.json"), '{"group":"ИП","month":"2026-10","total":{"contracts":0,"sum":0,"qty":0},"contracts":[]}');
      fs.writeFileSync(path.join(src, "market/kt/2026-10.json"), '{"group":"КТ","month":"2026-10","total":{"contracts":0,"sum":0,"qty":0},"contracts":[]}');

      const cfgPath = path.join(dir, "gate-config.json");
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(
          parseGateConfig(
            JSON.stringify({
              team: TEAM,
              aud: AUD,
              users: {
                "boss@example.test": "all",
                "mgr@example.test": `manager:${firstMgrId}`,
                "tv@example.test": "tv"
              }
            })
          )
        )
      );

      const built = deployPultVariants(src, out, cfgPath);
      expect(built).toEqual(["all", `m${firstMgrId}`]);
      expect(fs.existsSync(path.join(out, "_r/all/market/ip/2026-10.json"))).toBe(true);
      expect(fs.existsSync(path.join(out, "_r/all/market/kt/2026-10.json"))).toBe(true);
      expect(fs.existsSync(path.join(out, `_r/m${firstMgrId}/market/ip/2026-10.json`))).toBe(true);
      expect(fs.existsSync(path.join(out, `_r/m${firstMgrId}/market/kt/2026-10.json`))).toBe(true);
      expect(fs.existsSync(path.join(out, "_r/tv"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleGateRequest проверяет JWT, роли (all, manager, tv), несуществующий месяц, плохой маршрут и /_r/...", async () => {
    const config = parseGateConfig(
      JSON.stringify({
        team: TEAM,
        aud: AUD,
        users: {
          "boss@example.test": "all",
          "seller@example.test": "manager:2381",
          "tv@example.test": "tv"
        }
      })
    );
    const jsonIp = JSON.stringify({ group: "ИП", month: "2026-10", total: { contracts: 1, sum: 100, qty: 1 }, contracts: [] });
    const jsonKt = JSON.stringify({ group: "КТ", month: "2026-10", total: { contracts: 1, sum: 200, qty: 1 }, contracts: [] });
    const files: Record<string, string> = {
      "/_r/all/index.html": "ALL",
      "/_r/all/market/ip/2026-10.json": jsonIp,
      "/_r/all/market/kt/2026-10.json": jsonKt,
      "/_r/m2381/index.html": "MGR",
      "/_r/m2381/market/ip/2026-10.json": jsonIp,
      "/_r/tv/index.html": "TV",
      "/_r/tv/market/ip/2026-10.json": jsonIp
    };
    const asked: string[] = [];
    const assets = {
      fetch: async (input: Request | string | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        asked.push(url.pathname);
        if (url.pathname in files) {
          return new Response(files[url.pathname], {
            headers: { "content-type": url.pathname.endsWith(".json") ? "application/json" : "text/html" }
          });
        }
        return new Response("not found", { status: 404 });
      }
    };

    clearJwksCache();
    const { pair, jwk } = await keyPair("k1");
    const fetchFn = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch;

    const call = async (pathname: string, email?: string) => {
      const headers: Record<string, string> = {};
      if (email) {
        headers["Cf-Access-Jwt-Assertion"] = await signJwt(pair.privateKey, "k1", email);
      }
      return handleGateRequest(new Request(`https://pult.example.test${pathname}`, { headers }), {
        config,
        assets,
        fetchFn,
        now: () => NOW_MS
      });
    };

    // Разрешённый доступ all и manager
    const bossRes = await call("/market/ip/2026-10.json", "boss@example.test");
    expect(bossRes.status).toBe(200);
    expect(bossRes.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(bossRes.headers.get("cache-control")).toBe("private, no-store");
    expect(await bossRes.text()).toBe(jsonIp);

    const mgrRes = await call("/market/ip/2026-10.json", "seller@example.test");
    expect(mgrRes.status).toBe(200);
    expect(mgrRes.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(mgrRes.headers.get("cache-control")).toBe("private, no-store");
    expect(asked).toContain("/_r/m2381/market/ip/2026-10.json");

    // Без JWT и чужая почта -> 403 с private, no-store
    const noJwtRes = await call("/market/ip/2026-10.json");
    expect(noJwtRes.status).toBe(403);
    expect(noJwtRes.headers.get("cache-control")).toBe("private, no-store");
    const strangerRes = await call("/market/ip/2026-10.json", "stranger@example.test");
    expect(strangerRes.status).toBe(403);
    expect(strangerRes.headers.get("cache-control")).toBe("private, no-store");

    // Роль tv не имеет доступа к рынку -> 403 (и не ходит в /_r/tv/market/...)
    const askedBeforeTv = asked.length;
    const tvRes = await call("/market/ip/2026-10.json", "tv@example.test");
    expect(tvRes.status).toBe(403);
    expect(tvRes.headers.get("cache-control")).toBe("private, no-store");
    expect(asked.slice(askedBeforeTv)).toEqual([]);

    // Без PULT_ROLES (config: null): /market/... отдаётся из all с private, no-store, но прямой /_r/... всё равно закрыт (404)
    const openGateRes = await handleGateRequest(new Request("https://pult.example.test/market/ip/2026-10.json"), {
      config: null,
      assets,
      fetchFn,
      now: () => NOW_MS
    });
    expect(openGateRes.status).toBe(200);
    expect(openGateRes.headers.get("cache-control")).toBe("private, no-store");
    const directNoCfg = await handleGateRequest(new Request("https://pult.example.test/_r/all/market/ip/2026-10.json"), {
      config: null,
      assets,
      fetchFn,
      now: () => NOW_MS
    });
    expect(directNoCfg.status).toBe(404);
    expect(directNoCfg.headers.get("cache-control")).toBe("private, no-store");

    // Неизвестный месяц -> 404
    expect((await call("/market/ip/2099-01.json", "boss@example.test")).status).toBe(404);
    expect((await call("/market/kt/2026-09.json", "boss@example.test")).status).toBe(404);

    // Плохой маршрут и прямой /_r/... -> 404
    for (const badPath of [
      "/market/other/2026-10.json",
      "/market/ip/2026-13.json",
      "/market/ip/2026-00.json",
      "/market/ip/bad.json",
      "/market/ip/../_r/all/index.html",
      "/_r/all/market/ip/2026-10.json",
      "/_r/m2381/market/ip/2026-10.json"
    ]) {
      expect((await call(badPath, "boss@example.test")).status, badPath).toBe(404);
    }
  });
});

describe("волна 2: Playwright UI для «Все договоры за месяц» на 1440 и 375 px", () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl: string;
  let dir: string;
  let htmlPath: string;
  let monthData: { ip: Record<string, MarketMonthContractsPayload>; kt: Record<string, MarketMonthContractsPayload> };
  let routeOverride: ((reqPath: string, res: http.ServerResponse) => boolean) | null = null;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-wave2-pw-"));
    const units = makeSyntheticUnits();
    const marketView = buildMarketView(units, "2026-11-10", cfg, undefined, "2026-11-10", {
      "2026-11": { contracts: 1, sum: 100_000, ids: [80_004] }
    });
    monthData = buildAllMarketMonthContracts(units, "2026-11-10", cfg, {
      "2026-11": { contracts: 1, sum: 100_000, ids: [80_004] }
    });

    const basePult: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
    basePult.market = marketView;
    const html = renderPultHtml(basePult);
    htmlPath = path.join(dir, "index.html");
    fs.writeFileSync(htmlPath, html, "utf8");

    const stalePult: SalesPultPayload = {
      ...basePult,
      market: buildMarketView(units, "2026-11-10", cfg, undefined, "2026-11-01", {})
    };
    fs.writeFileSync(path.join(dir, "stale.html"), renderPultHtml(stalePult), "utf8");

    const unknownPult: SalesPultPayload = {
      ...basePult,
      market: { ...marketView, updatedAt: undefined, stale: false }
    };
    fs.writeFileSync(path.join(dir, "unknown.html"), renderPultHtml(unknownPult), "utf8");

    // Вид менеджера
    const mgrId = basePult.groups[0].managers[0].id;
    const regPayload: RegisterPagePayload = { asOfDate: basePult.asOfDate, generatedAt: basePult.generatedAt, register: { error: "не подключён" } };
    const mgrVar = buildManagerVariant({ pult: basePult, reg: regPayload, planDeals: [], managerId: mgrId })!;
    fs.writeFileSync(path.join(dir, "manager.html"), renderManagerVariant(mgrVar).index, "utf8");

    server = http.createServer((req, res) => {
      const reqPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (routeOverride && routeOverride(reqPath, res)) return;

      if (reqPath === "/" || reqPath === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(htmlPath, "utf8"));
        return;
      }
      if (reqPath === "/stale.html" || reqPath === "/unknown.html" || reqPath === "/manager.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(path.join(dir, reqPath.slice(1)), "utf8"));
        return;
      }
      const m = /^\/market\/(ip|kt)\/(\d{4}-\d{2})\.json$/.exec(reqPath);
      if (m) {
        const group = m[1] as "ip" | "kt";
        const month = m[2];
        const data = monthData[group][month];
        if (data) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(data));
          return;
        }
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function openPage(urlPath: string, width = 1440): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("https://fonts.**/*", (route) => route.abort());
    await page.goto(urlPath.startsWith("file://") ? urlPath : `${baseUrl}${urlPath}`);
    return { page, errors };
  }

  it("открытие/закрытие с клавиатуры, возврат фокуса, ленивая загрузка, порционная выдача, сверка и проверка на 1440/375 px", async () => {
    const marketRequests: string[] = [];
    const { page, errors } = await openPage("/", 1440);
    page.on("request", (req) => {
      const p = new URL(req.url()).pathname;
      if (p.startsWith("/market/")) marketRequests.push(p);
    });
    try {
      // Главная страница «Сегодня» и стартовый «Рынок» не запрашивают полный список договоров до открытия пользователем
      expect(marketRequests).toEqual([]);
      await page.locator('.sections a[data-t="market"]').click();
      await page.waitForSelector("#tab-ip [data-market-all-toggle]");
      expect(marketRequests).toEqual([]);

      // Свежесть источника и сохранность топов
      expect(await page.locator("#tab-ip .source-freshness").textContent()).toContain("Данные рынка обновлены 10.11");
      expect(await page.locator("#tab-ip .share .r").count()).toBeGreaterThan(2);
      expect(await page.locator("#tab-ip .lost .r").count()).toBeGreaterThan(2);
      expect(await page.locator("#tab-ip .cust .r").count()).toBeGreaterThan(2);

      // Открытие с клавиатуры (Enter)
      const toggleBtn = page.locator("#tab-ip [data-market-all-toggle]");
      expect(await toggleBtn.getAttribute("aria-expanded")).toBe("false");
      await toggleBtn.focus();
      await page.keyboard.press("Enter");

      await page.waitForSelector("#tab-ip .market-all-rows .r:not(.head)");
      expect(marketRequests).toEqual(["/market/ip/2026-10.json"]);
      expect(await toggleBtn.getAttribute("aria-expanded")).toBe("true");
      expect(await page.locator("#tab-ip .market-all-rows .r:not(.head)").count()).toBe(50);

      const summaryText = await page.locator("#tab-ip .market-all-summary").textContent();
      expect(summaryText).toContain("Показано 50 из 65");
      expect(summaryText).toContain("65 договоров");
      expect(summaryText).toContain("совпадает со сводкой");

      // Пагинация с клавиатуры («Показать ещё» -> 65 строк, фокус переходит на «Свернуть список»)
      const moreBtn = page.locator("#tab-ip [data-market-all-more]");
      await moreBtn.focus();
      await page.keyboard.press("Enter");
      expect(await page.locator("#tab-ip .market-all-rows .r:not(.head)").count()).toBe(65);
      expect(await page.locator("#tab-ip .market-all-summary").textContent()).toContain("Показано 65 из 65");
      expect(await page.locator("#tab-ip [data-market-all-more]").count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-market-all-collapse"))).toBe(true);

      // На 375 px: «Свернуть список» с клавиатуры закрывает и возвращает фокус на кнопку открытия
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.setViewportSize({ width: 375, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.keyboard.press("Enter");
      expect(await toggleBtn.getAttribute("aria-expanded")).toBe("false");
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-market-all-toggle"))).toBe(true);

      // Повторное открытие на 375 px и закрытие по Escape с возвратом фокуса на кнопку открытия
      await page.keyboard.press("Enter");
      await page.waitForSelector("#tab-ip .market-all-rows .r:not(.head)");
      const firstLink = page.locator("#tab-ip .market-all-rows a.r").first();
      await firstLink.focus();
      await page.keyboard.press("Escape");
      expect(await toggleBtn.getAttribute("aria-expanded")).toBe("false");
      expect(await page.locator("#tab-ip #market-all-panel-ip").isHidden()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-market-all-toggle"))).toBe(true);

      // Повторное открытие через Space и закрытие через Space
      await page.keyboard.press("Space");
      await page.waitForSelector("#tab-ip .market-all-rows .r:not(.head)");
      expect(await toggleBtn.getAttribute("aria-expanded")).toBe("true");
      await toggleBtn.focus();
      await page.keyboard.press("Space");
      expect(await toggleBtn.getAttribute("aria-expanded")).toBe("false");
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-market-all-toggle"))).toBe(true);

      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("пустой месяц, ошибка + повтор и состояния свежести (stale / неизвестна)", async () => {
    // 1. Пустой месяц (2026-11 из educationPending)
    const { page, errors } = await openPage("/#ip/2026-11", 1440);
    try {
      await page.locator("#tab-ip [data-market-all-toggle]").click();
      await page.waitForFunction(() =>
        document.querySelector("#tab-ip .market-all-state")?.textContent?.includes("Договоров за этот месяц нет")
      );

      // 2. Ошибка (500) + повтор (200)
      let failOnce = true;
      routeOverride = (reqPath, res) => {
        if (reqPath === "/market/ip/2026-09.json" && failOnce) {
          failOnce = false;
          res.writeHead(500);
          res.end("boom");
          return true;
        }
        return false;
      };
      await page.locator('#marketMonths button[data-month="2026-09"]').click();
      await page.waitForSelector("#tab-ip [data-market-all-retry]");
      expect(await page.locator("#tab-ip .market-all-state").textContent()).toContain("Не удалось загрузить");
      const retryBtn = page.locator("#tab-ip [data-market-all-retry]");
      await retryBtn.focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector("#tab-ip .market-all-rows .r:not(.head)");
      expect(await page.locator("#tab-ip .market-all-rows .r:not(.head)").count()).toBe(3);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-market-all-toggle"))).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      routeOverride = null;
      await page.close();
    }

    // 3. Stale и неизвестная дата
    const stalePage = await openPage("/stale.html#ip/2026-10", 1440);
    try {
      expect(await stalePage.page.locator("#tab-ip .note-warn").textContent()).toContain("Данные рынка не обновлены с 01.11");
      expect(stalePage.errors).toEqual([]);
    } finally {
      await stalePage.page.close();
    }

    const unknownPage = await openPage("/unknown.html#ip/2026-10", 1440);
    try {
      expect(await unknownPage.page.locator("#tab-ip .source-freshness.is-unknown").textContent()).toContain("Дата обновления неизвестна");
      expect(unknownPage.errors).toEqual([]);
    } finally {
      await unknownPage.page.close();
    }
  }, 30_000);

  it("file:// и 404 показывают «доступен только краткий список»", async () => {
    const fileRes = await openPage(`${pathToFileURL(htmlPath).href}#ip/2026-10`, 1440);
    try {
      await fileRes.page.locator("#tab-ip [data-market-all-toggle]").click();
      await fileRes.page.waitForSelector("#tab-ip .market-all-state");
      expect((await fileRes.page.locator("#tab-ip .market-all-state").textContent())!.toLowerCase()).toContain("доступен только краткий список");
      expect(fileRes.errors).toEqual([]);
    } finally {
      await fileRes.page.close();
    }

    routeOverride = (reqPath, res) => {
      if (reqPath.startsWith("/market/")) {
        res.writeHead(404);
        res.end("not found");
        return true;
      }
      return false;
    };
    const missingRes = await openPage("/#kt/2026-10", 1440);
    try {
      await missingRes.page.locator("#tab-kt [data-market-all-toggle]").click();
      await missingRes.page.waitForFunction(() =>
        document.querySelector("#tab-kt .market-all-state")?.textContent?.toLowerCase().includes("доступен только краткий список")
      );
      expect(missingRes.errors).toEqual([]);
    } finally {
      routeOverride = null;
      await missingRes.page.close();
    }
  }, 30_000);

  it("защита от гонок: медленный ответ старого месяца/направления не перезаписывает новый выбор", async () => {
    const { page, errors } = await openPage("/#ip/2026-10", 1440);
    try {
      // 1. Смена месяца во время медленного ответа (2026-10 -> 2026-09)
      let slowIpOctResponded = false;
      routeOverride = (reqPath, res) => {
        if (reqPath === "/market/ip/2026-10.json") {
          setTimeout(() => {
            slowIpOctResponded = true;
            if (!res.writableEnded) {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify(monthData.ip["2026-10"]));
            }
          }, 350);
          return true;
        }
        return false;
      };

      await page.locator("#tab-ip [data-market-all-toggle]").click();
      await page.waitForSelector("#tab-ip .market-all-state");
      expect(await page.locator("#tab-ip .market-all-state").textContent()).toContain("Загрузка договоров");

      await page.locator('#marketMonths button[data-month="2026-09"]').click();
      await page.waitForSelector("#tab-ip .market-all-rows .r:not(.head)");
      expect(await page.locator("#tab-ip .market-all-rows").textContent()).toContain("Заказчик Сентябрь-3");

      // Ждём дольше задержки медленного ответа и проверяем, что старый ответ не перезаписал 2026-09
      await page.waitForTimeout(450);
      expect(slowIpOctResponded).toBe(true);
      const afterMonthRace = await page.locator("#tab-ip .market-all-rows").textContent();
      expect(afterMonthRace).toContain("Заказчик Сентябрь-3");
      expect(afterMonthRace).not.toContain("Заказчик ИП-");

      // 2. Смена направления (ИП -> КТ) во время медленного ответа ИП
      slowIpOctResponded = false;
      await page.locator('#marketMonths button[data-month="2026-10"]').click();
      await page.waitForSelector("#tab-ip .market-all-state");
      await page.locator('#productSwitch button[data-product="kt"]').click();
      await page.waitForSelector("#tab-kt.on [data-market-all-toggle]");
      await page.locator("#tab-kt [data-market-all-toggle]").click();
      await page.waitForSelector("#tab-kt .market-all-rows .r:not(.head)");
      expect(await page.locator("#tab-kt .market-all-rows").textContent()).toContain("Заказчик КТ-4");

      await page.waitForTimeout(450);
      expect(await page.locator("#tab-kt.on .market-all-rows").textContent()).toContain("Заказчик КТ-4");
      expect(await page.locator("#tab-ip .market-all-rows").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      routeOverride = null;
      await page.close();
    }
  }, 30_000);

  it("КТ работает с клавиатуры без переполнения на 375 px, роль manager видит Рынок, в ТВ Рынок скрыт", async () => {
    // КТ на 375 px
    const ktRes = await openPage("/#kt/2026-10", 375);
    try {
      const toggleBtn = ktRes.page.locator("#tab-kt [data-market-all-toggle]");
      await toggleBtn.focus();
      await ktRes.page.keyboard.press("Enter");
      await ktRes.page.waitForSelector("#tab-kt .market-all-rows .r:not(.head)");
      expect(await ktRes.page.locator("#tab-kt .market-all-rows .r:not(.head)").count()).toBe(4);
      expect(await ktRes.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(ktRes.errors).toEqual([]);
    } finally {
      await ktRes.page.close();
    }

    // Роль manager
    const mgrRes = await openPage("/manager.html#ip/2026-10", 1440);
    try {
      await mgrRes.page.locator("#tab-ip [data-market-all-toggle]").click();
      await mgrRes.page.waitForSelector("#tab-ip .market-all-rows .r:not(.head)");
      expect(await mgrRes.page.locator("#tab-ip .market-all-rows .r:not(.head)").count()).toBe(50);
      expect(mgrRes.errors).toEqual([]);
    } finally {
      await mgrRes.page.close();
    }

    // ТВ-режим: «Рынок» не виден
    const tvRes = await openPage("/#ip/2026-10", 1440);
    try {
      await tvRes.page.locator("#tvBtn").click();
      expect(await tvRes.page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      expect(await tvRes.page.locator("#tab-ip").isVisible()).toBe(false);
      expect(await tvRes.page.locator("#tab-kt").isVisible()).toBe(false);
      expect(await tvRes.page.locator(".sections").isVisible()).toBe(false);
      expect(tvRes.errors).toEqual([]);
    } finally {
      await tvRes.page.close();
    }
  }, 30_000);
});
