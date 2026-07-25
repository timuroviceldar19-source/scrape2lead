import { describe, expect, it, vi } from "vitest";
import { collectExternalProcurement } from "../../src/kz/procurement/collector.js";

describe("collectExternalProcurement", () => {
  it("filters 2026 approved plans and active published tenders, follows next, and deduplicates overlap", async () => {
    const urls: string[] = [];
    const fetchJson = vi.fn(async (url: string) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.hostname === "zakup.gov.kz") {
        const isPlan = parsed.pathname.includes("plan-items");
        const offset = Number(parsed.searchParams.get("offset"));
        if (offset > 0) return { count: 1, next: null, results: [] };
        const row = isPlan
          ? { system_id: 2, id: 10, external_id: "same", total_price: 900_000, status_name: "Утвержден", organization_name: "Buyer", organization_bin: "123456789012", enstru: { name_ru: "Ноутбук", code: "262011.100.000002" } }
          : { system: { id: 3, name: "SKK" }, id: 20, external_id: "lot", lot_number: "lot", total_price: 2_000_000, organization_name: "Buyer", organization_bin: "123456789012", name_ru: "Ноутбук", enstru_key: "262011.100.000002", status_name: "Опубликован", offer_end_date: "2026-08-01T00:00:00Z" };
        return { count: 1, next: isPlan ? `${url.split("?")[0]}?offset=1` : null, results: [row] };
      }
      return { data: [], meta: { current_page: 1, last_page: 1 } };
    });

    const result = await collectExternalProcurement({
      keywords: ["Ноутбук", "Компьютер"], pageSize: 1, maxPages: 3, planYearId: 9,
      now: new Date("2026-07-21T00:00:00Z"), fetchJson
    });

    expect(result.records).toHaveLength(2);
    expect(result.completeness).toMatchObject({ complete: true, planYearId: 9, pageLimit: 3 });
    const epzUrls = urls.filter((url) => url.includes("zakup.gov.kz"));
    expect(epzUrls).not.toHaveLength(0);
    expect(epzUrls.every((url) => url.includes("system_id__in=2__3"))).toBe(true);
    expect(epzUrls.filter((url) => url.includes("plan-items")).every((url) => url.includes("plan_year_id=9") && url.includes("status_id__in=2"))).toBe(true);
    expect(epzUrls.filter((url) => url.includes("/lots/")).every((url) => url.includes("status_id__in=6") && url.includes("offer_end_date__gte="))).toBe(true);
  });

  it("keeps only published active Tizilim tenders with a future deadline", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("zakup.gov.kz")) return { count: 0, next: null, results: [] };
      return { data: [
        tender("active", "Опубликован", "2026-08-01 00:00:00+05"),
        tender("past", "Опубликован", "2026-07-01 00:00:00+05"),
        tender("done", "Завершен", "2026-08-01 00:00:00+05")
      ], meta: { current_page: 1, last_page: 1 } };
    });
    const result = await collectExternalProcurement({
      keywords: ["Панель"], maxPages: 1, planYearId: 9,
      now: new Date("2026-07-21T00:00:00Z"), fetchJson
    });
    expect(result.records.filter((row) => row.source === "tizilim").map((row) => row.externalId)).toEqual(["active"]);
  });

  it("returns partial records but marks the run incomplete when the safety limit is reached", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (!url.includes("zakup.gov.kz")) return { data: [], meta: { current_page: 1, last_page: 1 } };
      if (url.includes("/lots/")) return { results: [], next: null };
      return { results: [{ system_id: 2, id: 1, external_id: "p1", status_name: "Утвержден" }], next: "https://zakup.gov.kz/next" };
    });
    const result = await collectExternalProcurement({ keywords: ["Ноутбук"], maxPages: 1, planYearId: 9, fetchJson });
    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.incompleteReasons).toContainEqual(expect.stringContaining("page_limit"));
  });
});

function tender(number: string, status: string, endDate: string) {
  return { number, name_ru: "Панель интерактивная", customer: { name_ru: "Buyer" }, amount: "1000000",
    status: { name_ru: status }, type: { name_ru: "Конкурс" }, start_date: "2026-07-20 00:00:00+05", end_date: endDate };
}
