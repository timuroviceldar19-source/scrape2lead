import { describe, expect, it, vi } from "vitest";
import { enrichEligibleEpzCustomers } from "../../src/kz/procurement/enrichment.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

describe("EPZ customer enrichment", () => {
  it("loads BIN only for product-eligible rows and caches organizations", async () => {
    const fetchJson = vi.fn(async () => ({ iin_bin: "981240001604", name_ru: "ТОО Покупатель" }));
    const records = [row("ok-1"), row("ok-2"), row("junk", { productName: "Транспондер", truCode: "261100.000.000001" })];
    const enriched = await enrichEligibleEpzCustomers(records, { fetchJson });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(enriched[0]?.customerBin).toBe("981240001604");
    expect(enriched[1]?.customerBin).toBe("981240001604");
    expect(enriched[2]?.customerBin).toBeNull();
  });

  it("loads a published lot customer from its public announcement", async () => {
    const fetchJson = vi.fn(async () => ({ customer: { iin_bin: "050540000581", name: "АО Покупатель" } }));
    const tender = row("lot-1", { recordKind: "tender", customerSourceId: null, announcementSourceId: "40179226",
      status: "Опубликован", endDate: "2026-08-01T00:00:00Z" });
    const [enriched] = await enrichEligibleEpzCustomers([tender], { fetchJson });
    expect(fetchJson.mock.calls[0]?.[0]).toContain("/announcements/40179226/");
    expect(enriched?.customerBin).toBe("050540000581");
  });
});

function row(id: string, overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return { source: "samruk", recordKind: "plan", sourceRecordId: id, externalId: id, parentExternalId: null,
    status: "Утвержден", productName: "Ноутбук", description: "", truCode: "262011.100.000002",
    customerSourceId: "39114", customerName: "Покупатель", customerBin: null, amount: 1_000_000, currency: "KZT",
    startDate: null, endDate: null, url: `https://example.kz/${id}`, purchaseMethod: null,
    collectedAt: "2026-07-21T00:00:00Z", ...overrides };
}
