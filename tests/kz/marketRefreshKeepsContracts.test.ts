import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchZakupMarketUnits } from "../../src/kz/market/fetchZakupMarket.js";
import { backfillMarketByMonths, fetchMarketUnits, logMarketRefreshCounts, mergeMarketUnits, saveStoredMarketData } from "../../src/kz/market/fetchMarket.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import type { MarketUnit } from "../../src/kz/market/types.js";

const cfg = { ...loadMarketConfig(), ourBins: ["111111111111"] };
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "market-keeps-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });
const unit = (id: number, over: Partial<MarketUnit> = {}): MarketUnit => ({ id, unitIndex: 0, date: "2026-10-10", month: "2026-10", group: "ИП", code: "262030.100.000021", kind: "Панель", sum: 300000, price: 300000, qty: 1, supplier: "111111111111", customer: "222222222222", supplierName: "Компания Альфа", customerName: "Заказчик Бета", method: "Магазин", us: true, ...over });
const row = (over = {}) => ({ id: 1, external_id: 501, sign_date: "2026-10-10", status_id: 1, enstru_code: ["262030.100.000021"], supplier_organization_id: 11, customer_organization_id: 12, ...over });
const subject = { plan_item: { enstru: { code: "262030.100.000021" } }, quantity: 1, item_price_without_vat: 300000 };
const detail = { external_id: 501, supplier_organization: { id: 11, iin_bin: "111111111111" }, customer_organization: { id: 12, iin_bin: "222222222222" } };
function site(rows: unknown[], subjects: unknown[] = [subject], card: unknown = detail, failure?: "subjects" | "card") {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const u = new URL(String(input)); const p = u.pathname.replace("/api/core/api", ""); calls.push(p);
    if (p === "/dicts/contract-statuses/") return Response.json([{ id: 1, egz_code: "190" }, { id: 2, egz_code: "455" }]);
    if (p === "/dicts/purchase-methods/") return Response.json([]);
    if (p === "/public/contracts/") return Response.json({ count: u.searchParams.get("enstru_code__startswith") === "262030.100." ? rows.length : 0, results: u.searchParams.get("enstru_code__startswith") === "262030.100." ? rows : [] });
    if (p.endsWith("/subjects/")) { if (failure === "subjects") throw new Error("Тестовый таймаут"); return Response.json(subjects); }
    if (failure === "card") throw new Error("Тестовый таймаут");
    return Response.json(card);
  }) as unknown as typeof fetch;
  const orgCachePath = path.join(tmp(), "orgs.json");
  return { calls, options: { fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchFn, pauseMs: 0, maxRetries: 0, secondPassDelayMs: 0, retryDelayMs: 0, orgCachePath } };
}

describe("утреннее обновление сохраняет договоры без кода", () => {
  it("пауза предшествует второму проходу; договор и счётчик не дублируются", async () => {
    const s = site([row({ external_id: null, enstru_code: [] })], []);
    const original = s.options.fetchFn; let cards = 0;
    s.options.fetchFn = vi.fn(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/public/contracts/1/")) {
        cards++;
        if (cards === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return original(url, init);
    });
    vi.useFakeTimers();
    try {
      const promise = fetchZakupMarketUnits({ ...s.options, secondPassDelayMs: 50 });
      await vi.advanceTimersByTimeAsync(0);
      expect(cards).toBe(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(cards).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;
      expect(cards).toBe(2);
      expect(result.keepContractIds).toEqual([501]);
      expect(result.stats).toEqual({ missingListIds: 1, withoutCodes: 1, skippedWithoutId: 0 });
    } finally { vi.useRealTimers(); }
  });
  it.each(["subjects", "card"] as const)("повторяет неответивший %s после остальных договоров и возвращает его", async failure => {
    const s = site([row({ external_id: null }), row({ id: 2, external_id: 502 })]);
    const original = s.options.fetchFn; const order: string[] = []; let attempts = 0;
    const target = failure === "subjects" ? "/1/subjects/" : "/1/";
    s.options.fetchFn = vi.fn(async (url, init) => {
      const p = new URL(String(url)).pathname;
      if (p.endsWith(target)) {
        order.push("target"); attempts++;
        if (attempts === 1) throw Object.assign(new Error("Тестовый сбой"), { cause: { code: "ECONNRESET" } });
      }
      if (p.endsWith("/2/subjects/")) order.push("other");
      return original(url, init);
    });
    const result = await fetchZakupMarketUnits({ ...s.options, concurrency: 1 });
    expect(result.units.map(u => u.id)).toEqual([501, 502]);
    expect(order).toEqual(["target", "other", "target"]);
    expect(attempts).toBe(2);
  });
  it("missingListIds не включает исключённый статус", async () => {
    const s = site([row({ external_id: null }), row({ id: 2, external_id: null, status_id: 2 })]);
    expect((await fetchZakupMarketUnits(s.options)).stats.missingListIds).toBe(1);
  });
  it("неполная страница обрывает обновление без записи кэша и без запасного источника", async () => {
    const s = site([row()]); const original = s.options.fetchFn;
    let pages = 0;
    s.options.fetchFn = vi.fn(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/public/contracts/")) { pages++; return Response.json({ count: 2, results: [row()] }); }
      return original(url, init);
    });
    const file = path.join(tmp(), "units.json"); saveStoredMarketData({ units: [unit(501)] }, file);
    const before = fs.readFileSync(file, "utf8"); const ows = vi.fn();
    await expect(backfillMarketByMonths({ filePath: file, fromDate: "2026-10-01", toDate: "2026-10-31", cfg,
      fetchUnits: () => fetchMarketUnits({ ...s.options, token: "test-token", sources: { zakup: () => fetchZakupMarketUnits(s.options), ows } })
    })).rejects.toThrow(/неполн/);
    expect(pages).toBe(2); expect(ows).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it("получает номер из карточки одним запросом вместе с БИН, даже если БИН уже в кэше", async () => {
    const s = site([row({ external_id: null })]);
    fs.writeFileSync(s.options.orgCachePath, JSON.stringify({ 11: "111111111111", 12: "222222222222" }));
    const result = await fetchZakupMarketUnits(s.options);
    expect(result.units).toHaveLength(1);
    expect(result.units[0].id).toBe(501);
    expect(result.stats).toMatchObject({ missingListIds: 1, skippedWithoutId: 0 });
    expect(s.calls.filter(p => p === "/public/contracts/1/")).toHaveLength(1);
  });
  it("пропускает и считает договор, если номера нет и в карточке", async () => {
    const s = site([row({ external_id: null })], [subject], { ...detail, external_id: null });
    const result = await fetchZakupMarketUnits(s.options);
    expect(result.units).toEqual([]);
    expect(result.keepContractIds).toEqual([]);
    expect(result.stats).toMatchObject({ missingListIds: 1, skippedWithoutId: 1 });
  });
  it.each([{ subjects: [{ plan_item: { enstru: null } }] }, { subjects: [] }])("удерживает все старые позиции договора без кода %#", async ({ subjects }) => {
    const s = site([row({ external_id: null, enstru_code: [] })], subjects);
    const result = await fetchZakupMarketUnits(s.options);
    expect(result.keepContractIds).toEqual([501]);
    expect(result.stats.withoutCodes).toBe(1);
    const old = [unit(501), unit(501, { unitIndex: 1, code: "262030.100.000043" })];
    expect(mergeMarketUnits(old, result.units, "2026-10-01", "2026-10-31", result.keepContractIds)).toEqual(old);
  });
  it("не удерживает исключённый статус и классифицируемые чужие коды", async () => {
    const s = site([row({ status_id: 2, enstru_code: [] }), row({ id: 2, external_id: 502, enstru_code: [] })], [{ plan_item: { enstru: { code: "999999.000.000001" } } }]);
    const result = await fetchZakupMarketUnits(s.options);
    expect(result.keepContractIds).toEqual([]);
    expect(result.stats.withoutCodes).toBe(0);
    expect(s.calls).not.toContain("/public/contracts/1/subjects/");
    expect(mergeMarketUnits([unit(501)], result.units, "2026-10-01", "2026-10-31", result.keepContractIds)).toEqual([]);
  });
  it("неизвестный код не удерживает договор, если другой предмет классифицирован", async () => {
    const s = site([row({ enstru_code: [] })], [subject, { plan_item: null }]);
    const result = await fetchZakupMarketUnits(s.options);
    expect(result.units).toHaveLength(1);
    expect(result.keepContractIds).toEqual([]);
  });
  it("проверяет предметы даже при чужих кодах в строке списка, попавшей по широкому префиксу", async () => {
    const s = site([row({ enstru_code: ["262030.100.000098", "262030.100.000099"] })], [{ plan_item: { enstru: null } }]);
    const result = await fetchZakupMarketUnits(s.options);
    expect(result.keepContractIds).toEqual([501]);
  });
  it("удаляет отсутствующих, fresh заменяет все старые позиции даже при другом ключе", () => {
    const old = [unit(501), unit(501, { unitIndex: 1 }), unit(502), unit(503, { date: "2026-09-30", month: "2026-09" }), unit(504, { date: "2026-11-01", month: "2026-11" })];
    const fresh = unit(501, { code: "262030.100.000043", price: 400000, sum: 800000, qty: 2 });
    expect(mergeMarketUnits(old, [fresh], "2026-10-01", "2026-10-31", [501])).toEqual([old[3], fresh, old[4]]);
    expect(mergeMarketUnits(old, [], "2026-10-01", "2026-10-31")).toEqual(old.slice(3));
  });
  it("лог содержит только количества, без номеров, имён и сумм", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logMarketRefreshCounts([unit(501), unit(502)], { source: "zakup", units: [], keepContractIds: [501], stats: { missingListIds: 3, withoutCodes: 1, skippedWithoutId: 2 } }, "2026-10-01", "2026-10-31");
    expect(log.mock.calls).toEqual([["[Рынок] Без номера в списке: 3, без кода: 1, удержано в окне: 1, ушло из окна: 1, пропущено без номера: 2"]]);
  });
  it("передаёт keepContractIds через общий fetch в backfillMarketByMonths", async () => {
    const s = site([row({ enstru_code: [] })], []);
    const result = await fetchMarketUnits({ ...s.options, sources: { zakup: () => fetchZakupMarketUnits(s.options) } });
    expect(result.keepContractIds).toEqual([501]);
    const file = path.join(tmp(), "units.json"); saveStoredMarketData({ units: [unit(501), unit(502)] }, file);
    const saved = await backfillMarketByMonths({ filePath: file, fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchUnits: async () => result });
    expect(saved).toEqual([unit(501)]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).units).toEqual(saved);
  });
  it.each(["subjects", "card"] as const)("ошибка %s обрывает выгрузку; файл кэша не меняется", async failure => {
    const s = site([row({ external_id: null })], [subject], detail, failure);
    const file = path.join(tmp(), "units.json"); saveStoredMarketData({ units: [unit(501)] }, file);
    const before = fs.readFileSync(file, "utf8");
    const ows = vi.fn();
    await expect(backfillMarketByMonths({ filePath: file, fromDate: "2026-10-01", toDate: "2026-10-31", cfg,
      fetchUnits: () => fetchMarketUnits({ ...s.options, token: "test-token", sources: { zakup: () => fetchZakupMarketUnits(s.options), ows } })
    })).rejects.toThrow();
    expect(ows).not.toHaveBeenCalled();
    expect(s.calls.filter(p => p === (failure === "subjects" ? "/public/contracts/1/subjects/" : "/public/contracts/1/"))).toHaveLength(2);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
