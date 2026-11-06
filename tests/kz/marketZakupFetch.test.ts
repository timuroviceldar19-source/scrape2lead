import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import { fetchZakupMarketUnits } from "../../src/kz/market/fetchZakupMarket.js";
import { fetchMarketUnits } from "../../src/kz/market/fetchMarket.js";

const cfg = { ...loadMarketConfig(), ourBins: ["111111111111"] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tmpDirs: string[] = [];
const tmpOrgCache = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zakup-orgs-"));
  tmpDirs.push(dir);
  return path.join(dir, "orgs.json");
};
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const STATUSES = [
  { id: 6, name: "Действует", egz_code: "190" },
  { id: 25, name: "Изменен", egz_code: "455" },
  { id: 64, name: "Заключен", egz_code: null }
];
const METHODS = [
  { id: 39, name_ru: "Электронный магазин", egz_code: "60" },
  { id: 10, name_ru: "Из одного источника путем прямого заключения договора", egz_code: "23" },
  { id: 12, name_ru: "Запрос ценовых предложений", egz_code: "3" }
];

function contract(over: Record<string, unknown>) {
  return {
    id: 1,
    external_id: 501,
    sign_date: "2026-10-14",
    status_id: 6,
    system_id: 1,
    actual_purchase_method: { id: 39, name_ru: "Электронный магазин" },
    purchase_method_id: 39,
    contract_price_with_vat: 1_120_000,
    enstru_code: ["262030.100.000021"],
    supplier_organization_id: 11,
    supplier_organization_name: "ТОО \"Альфа\"",
    customer_organization_id: 12,
    customer_organization_name: "ГККП  \"Заказчик Бета\"",
    ...over
  };
}

const subject = (code: string | null, price: number, qty: number, oldId?: number, timestamp?: number) => ({
  external_id: oldId ?? null,
  timestamp: timestamp ?? null,
  item_price_without_vat: price,
  quantity: qty,
  contract_price_without_vat: price * qty,
  plan_item: code ? { enstru: { code } } : null
});

/** Fake site: routes by path, records every call. */
function fakeSite(byPrefix: Record<string, unknown[]>, subjects: Record<number, unknown[]>, details: Record<number, unknown>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (raw: string) => {
    const url = new URL(raw);
    calls.push(url.pathname + url.search);
    const p = url.pathname.replace("/api/core/api", "");
    if (p === "/dicts/contract-statuses/") return json(STATUSES);
    if (p === "/dicts/purchase-methods/") return json(METHODS);
    if (p === "/public/contracts/") {
      expect(url.searchParams.get("system_id")).toBe("1");
      expect(url.searchParams.get("sign_date__gte")).toBe("2026-10-01");
      expect(url.searchParams.get("sign_date__lte")).toBe("2026-10-31");
      const key = url.searchParams.get("enstru_code__isnull") === "true"
        ? (expect(url.searchParams.get("purchase_subject_id")).toBe("1"), "no-codes")
        : url.searchParams.get("enstru_code__startswith") ?? "";
      const rows = byPrefix[key] ?? [];
      return json({ count: rows.length, next: null, results: rows });
    }
    const sub = /^\/public\/contracts\/(\d+)\/subjects\/$/.exec(p);
    if (sub) return json(subjects[Number(sub[1])] ?? []);
    const det = /^\/public\/contracts\/(\d+)\/$/.exec(p);
    if (det) return json(details[Number(det[1])]);
    return json({ detail: `unexpected ${p}` }, 404);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const detail = (supplier: [number, string], customer: [number, string]) => ({
  supplier_organization: { id: supplier[0], iin_bin: supplier[1] },
  customer_organization: { id: customer[0], iin_bin: customer[1] }
});

describe("fetchZakupMarketUnits", () => {
  it("turns public contracts into market units like the ows source: old ids, BINs, prices without VAT, method names", async () => {
    const panel = contract({ id: 1, external_id: 501 });
    const { fetchFn } = fakeSite(
      { "262030.100.": [panel] },
      { 1: [subject("262030.100.000021", 600_000, 2), subject("262030.100.000043", 500_000, 1)] },
      { 1: detail([11, "111111111111"], [12, "222222222222"]) }
    );
    const { units } = await fetchZakupMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchFn, pauseMs: 0, retryDelayMs: 0, orgCachePath: tmpOrgCache() });
    expect(units).toEqual([
      expect.objectContaining({ id: 501, unitIndex: 0, date: "2026-10-14", month: "2026-10", group: "ИП", kind: "Интерактивные панели", code: "262030.100.000021", price: 600_000, qty: 2, sum: 1_200_000, supplier: "111111111111", customer: "222222222222", supplierName: "ТОО \"Альфа\"", customerName: "ГККП \"Заказчик Бета\"", method: "Электронный магазин", us: true }),
      expect.objectContaining({ id: 501, unitIndex: 1, kind: "Интерактивные доски", price: 500_000, qty: 1, sum: 500_000 })
    ]);
  });

  it("skips excluded statuses, contracts without our codes, cheap units and missing old ids after checking the card", async () => {
    const changed = contract({ id: 2, external_id: 502, status_id: 25 });
    const otherGoods = contract({ id: 3, external_id: 503, enstru_code: ["262030.100.000099"] });
    const noOldId = contract({ id: 4, external_id: null });
    const noEgzStatus = contract({ id: 5, external_id: 505, status_id: 64 });
    const cheap = contract({ id: 6, external_id: 506, actual_purchase_method: { id: 10 } });
    const { fetchFn, calls } = fakeSite(
      { "262030.100.": [changed, otherGoods, noOldId, noEgzStatus, cheap] },
      { 3: [subject("262030.100.000099", 300_000, 1)], 6: [subject("262030.100.000021", 9_000, 3), subject("262030.100.000021", 600_000, 1)] },
      { 4: { external_id: null }, 6: detail([700, "111111111111"], [800, "222222222222"]) }
    );
    const { units } = await fetchZakupMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchFn, pauseMs: 0, retryDelayMs: 0, orgCachePath: tmpOrgCache() });
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ id: 506, price: 600_000, method: "Прямой договор", us: false });
    expect(calls.filter((c) => c.includes("/subjects/"))).toEqual(["/api/core/api/public/contracts/3/subjects/", "/api/core/api/public/contracts/4/subjects/", "/api/core/api/public/contracts/6/subjects/"]);
  });

  it("takes line-item text from plan_item: keeps interactive LCD, drops non-interactive LCD", async () => {
    const lcdContract = contract({ id: 8, external_id: 508, enstru_code: ["279020.100.000001"] });
    const { fetchFn } = fakeSite(
      { "279020.100.": [lcdContract] },
      {
        8: [
          {
            external_id: 1,
            item_price_without_vat: 700_000,
            quantity: 1,
            contract_price_without_vat: 700_000,
            plan_item: {
              enstru: { code: "279020.100.000001" },
              name_ru: "Панель жидкокристаллическая",
              extra_description_ru: "Панель интерактивная 75 дюймов"
            }
          },
          {
            external_id: 2,
            item_price_without_vat: 800_000,
            quantity: 1,
            contract_price_without_vat: 800_000,
            plan_item: {
              enstru: { code: "279020.100.000001" },
              name_ru: "Панель жидкокристаллическая",
              extra_description_ru: "Лед экран"
            }
          }
        ]
      },
      { 8: detail([11, "111111111111"], [12, "222222222222"]) }
    );
    const { units } = await fetchZakupMarketUnits({
      fromDate: "2026-10-01",
      toDate: "2026-10-31",
      cfg,
      fetchFn,
      pauseMs: 0,
      retryDelayMs: 0,
      orgCachePath: tmpOrgCache()
    });
    expect(units).toHaveLength(1);
    expect(units[0].code).toBe("279020.100.000001");
    expect(units[0].kind).toBe("Интерактивные панели");
  });

  it("asks each contract once even when it matches several prefixes, and reuses cached BINs", async () => {
    const pc = contract({ id: 7, external_id: 507, enstru_code: ["262013.000.000011", "262040.000.000267"] });
    const orgCachePath = tmpOrgCache();
    fs.writeFileSync(orgCachePath, JSON.stringify({ 11: "111111111111", 12: "222222222222" }));
    const { fetchFn, calls } = fakeSite(
      { "262013.": [pc], "262040.": [pc] },
      { 7: [subject("262013.000.000011", 400_000, 5), subject("262040.000.000267", 300_000, 2)] },
      {}
    );
    const { units } = await fetchZakupMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchFn, pauseMs: 0, retryDelayMs: 0, orgCachePath });
    expect(units.map((u) => [u.group, u.kind, u.supplier])).toEqual([
      ["КТ", "Компьютеры и моноблоки", "111111111111"],
      ["КТ", "Системные блоки", "111111111111"]
    ]);
    expect(calls.filter((c) => c.includes("/subjects/"))).toHaveLength(1);
    expect(calls.some((c) => /\/contracts\/7\/$/.test(c.split("?")[0]))).toBe(false);
  });

  it("finds goods contracts with an empty contract-level code list by their line items", async () => {
    const noCodes = contract({ id: 9, external_id: 509, enstru_code: [] });
    const { fetchFn } = fakeSite(
      { "no-codes": [noCodes] },
      { 9: [subject("262013.000.000011", 650_000, 4)] },
      { 9: detail([11, "111111111111"], [12, "222222222222"]) }
    );
    const { units } = await fetchZakupMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchFn, pauseMs: 0, retryDelayMs: 0, orgCachePath: tmpOrgCache() });
    expect(units).toEqual([expect.objectContaining({ id: 509, group: "КТ", code: "262013.000.000011", qty: 4, sum: 2_600_000 })]);
  });

  it("counts a line item imported twice (same old id) once", async () => {
    const twice = contract({ id: 10, external_id: 510, enstru_code: ["262013.000.000011"] });
    const { fetchFn } = fakeSite(
      { "262013.": [twice] },
      { 10: [subject("262013.000.000011", 450_000, 5, 601, 1000), subject("262013.000.000011", 450_000, 5, 601, 999)] },
      { 10: detail([11, "111111111111"], [12, "222222222222"]) }
    );
    const { units } = await fetchZakupMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchFn, pauseMs: 0, retryDelayMs: 0, orgCachePath: tmpOrgCache() });
    expect(units.map((u) => u.sum)).toEqual([2_250_000]);
  });

  it("does not look up BINs for a contract whose items are not ours", async () => {
    const office = contract({ id: 11, external_id: 511, enstru_code: [], supplier_organization_id: 950, customer_organization_id: 951 });
    const { fetchFn, calls } = fakeSite({ "no-codes": [office] }, { 11: [subject("222929.000.000001", 50_000, 10)] }, {});
    const { units } = await fetchZakupMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchFn, pauseMs: 0, retryDelayMs: 0, orgCachePath: tmpOrgCache() });
    expect(units).toEqual([]);
    expect(calls.some((c) => /\/contracts\/11\/$/.test(c.split("?")[0]))).toBe(false);
  });

  it("saves BINs it had to look up, for the next run", async () => {
    const orgCachePath = tmpOrgCache();
    const { fetchFn } = fakeSite(
      { "262030.100.": [contract({ id: 8, external_id: 508, supplier_organization_id: 900, customer_organization_id: 901 })] },
      { 8: [subject("262030.100.000021", 700_000, 1)] },
      { 8: detail([900, "333333333333"], [901, "444444444444"]) }
    );
    await fetchZakupMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", cfg, fetchFn, pauseMs: 0, retryDelayMs: 0, orgCachePath });
    expect(JSON.parse(fs.readFileSync(orgCachePath, "utf8"))).toEqual({ 900: "333333333333", 901: "444444444444" });
  });
});

describe("fetchMarketUnits: zakup first, ows as the backup", () => {
  const unit = { id: 1, month: "2026-10", date: "2026-10-14", group: "ИП" as const, code: "262030.100.000021", kind: "Интерактивные панели", sum: 1, qty: 1, price: 1, supplier: "s", customer: "c", supplierName: "S", customerName: "C", method: "Электронный магазин", us: false };

  it("uses zakup when it answers", async () => {
    const zakup = vi.fn().mockResolvedValue({ units: [unit], keepContractIds: [], stats: { missingListIds: 0, withoutCodes: 0, skippedWithoutId: 0 } });
    const ows = vi.fn();
    const res = await fetchMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", token: "t", sources: { zakup, ows } });
    expect(res).toMatchObject({ units: [unit], source: "zakup", keepContractIds: [] });
    expect(ows).not.toHaveBeenCalled();
  });

  it("falls back to ows with the token when zakup fails", async () => {
    const zakup = vi.fn().mockRejectedValue(new Error("zakup /public/contracts/: UND_ERR_CONNECT_TIMEOUT"));
    const ows = vi.fn().mockResolvedValue([unit]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetchMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", token: "t", sources: { zakup, ows } });
    expect(res.source).toBe("ows");
    expect(res).not.toHaveProperty("keepContractIds");
    expect(ows).toHaveBeenCalledWith(expect.objectContaining({ token: "t", fromDate: "2026-10-01", toDate: "2026-10-31" }));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("UND_ERR_CONNECT_TIMEOUT");
    warn.mockRestore();
  });

  it("throws the zakup error when there is no token for the backup", async () => {
    const zakup = vi.fn().mockRejectedValue(new Error("zakup down"));
    const ows = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fetchMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", sources: { zakup, ows } })).rejects.toThrow("кэш не обновлён");
    expect(ows).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports both errors when the backup fails too", async () => {
    const zakup = vi.fn().mockRejectedValue(new Error("zakup down"));
    const ows = vi.fn().mockRejectedValue(new Error("ows 403"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fetchMarketUnits({ fromDate: "2026-10-01", toDate: "2026-10-31", token: "t", sources: { zakup, ows } })).rejects.toThrow(/не ответили оба источника/);
    warn.mockRestore();
  });
});
