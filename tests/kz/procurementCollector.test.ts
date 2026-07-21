import { describe, expect, it, vi } from "vitest";
import { collectExternalProcurement } from "../../src/kz/procurement/collector.js";

describe("collectExternalProcurement", () => {
  it("queries only EPZ systems 2 and 3, paginates, and deduplicates keyword overlap", async () => {
    const urls: string[] = [];
    const fetchJson = vi.fn(async (url: string) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.hostname === "zakup.gov.kz") {
        const isPlan = parsed.pathname.includes("plan-items");
        const offset = Number(parsed.searchParams.get("offset"));
        if (offset > 0) return { count: 1, results: [] };
        const row = isPlan
          ? { system_id: 2, id: 10, external_id: "same", total_price: 900_000, organization_name: "Buyer", organization_bin: "123456789012", enstru: { name_ru: "Ноутбук", code: "262011.100.000002" } }
          : { system: { id: 3, name: "SKK" }, id: 20, external_id: "lot", lot_number: "lot", total_price: 2_000_000, organization_name: "Buyer", organization_bin: "123456789012", name_ru: "Ноутбук", enstru_key: "262011.100.000002", status_name: "Опубликован", offer_end_date: "2026-08-01T00:00:00Z" };
        return { count: 1, results: [row] };
      }
      return { data: [], meta: { current_page: 1, last_page: 1 } };
    });

    const rows = await collectExternalProcurement({
      keywords: ["Ноутбук", "Компьютер"], pageSize: 1, maxPages: 2,
      now: new Date("2026-07-21T00:00:00Z"), fetchJson
    });

    expect(rows).toHaveLength(2);
    expect(urls.filter((url) => url.includes("zakup.gov.kz"))).not.toHaveLength(0);
    expect(urls.filter((url) => url.includes("zakup.gov.kz")).every((url) => url.includes("system_id__in=2__3"))).toBe(true);
  });

  it("keeps only published active Tizilim tenders with a future deadline", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("zakup.gov.kz")) return { count: 0, results: [] };
      return { data: [
        tender("active", "Опубликован", "2026-08-01 00:00:00+05"),
        tender("past", "Опубликован", "2026-07-01 00:00:00+05"),
        tender("done", "Завершен", "2026-08-01 00:00:00+05")
      ], meta: { current_page: 1, last_page: 1 } };
    });
    const rows = await collectExternalProcurement({
      keywords: ["Панель"], maxPages: 1, now: new Date("2026-07-21T00:00:00Z"), fetchJson
    });
    expect(rows.filter((row) => row.source === "tizilim").map((row) => row.externalId)).toEqual(["active"]);
  });
});

function tender(number: string, status: string, endDate: string) {
  return { number, name_ru: "Панель интерактивная", customer: { name_ru: "Buyer" }, amount: "1000000",
    status: { name_ru: status }, type: { name_ru: "Конкурс" }, start_date: "2026-07-20 00:00:00+05", end_date: endDate };
}
