import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenderRecord } from "../../src/kz/tenderTypes.js";

const collectStatGovForBins = vi.fn();
const collectZakupTendersForBatch = vi.fn();
const fetchGoszakupTenders = vi.fn();
const isGoszakupAvailable = vi.fn();

vi.mock("../../src/kz/statGovCollector.js", () => ({
  collectStatGovForBins
}));

vi.mock("../../src/kz/zakupCollector.js", () => ({
  collectZakupTendersForBatch
}));

vi.mock("../../src/kz/goszakupCollector.js", () => ({
  fetchGoszakupTenders,
  isGoszakupAvailable
}));

describe("KZ adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ZakupTenderAdapter delegates to zakup collector", async () => {
    const { ZakupTenderAdapter } = await import("../../src/adapters/kz/ZakupTenderAdapter.js");
    const tender = tenderRecord("zakup.sk.kz");
    collectZakupTendersForBatch.mockResolvedValue({
      tenders: [tender],
      processed: 1,
      skipped: 0,
      failed: 0,
      errors: []
    });

    const adapter = new ZakupTenderAdapter();
    const result = await adapter.fetchTendersByBin("220540025781", "API-KZ");

    expect(adapter.source).toBe("zakup.sk.kz");
    expect(adapter.requiresAuth).toBe(false);
    expect(adapter.isAvailable()).toBe(true);
    expect(collectZakupTendersForBatch).toHaveBeenCalledWith([{ bin: "220540025781", companyName: "API-KZ" }]);
    expect(result).toEqual([tender]);
  });

  it("GoszakupTenderAdapter delegates availability and fetch", async () => {
    const { GoszakupTenderAdapter } = await import("../../src/adapters/kz/GoszakupTenderAdapter.js");
    const tender = tenderRecord("goszakup.gov.kz");
    isGoszakupAvailable.mockReturnValue(true);
    fetchGoszakupTenders.mockResolvedValue({ tenders: [tender], raw: 1, filtered: 0, pages: 1 });

    const adapter = new GoszakupTenderAdapter();
    const result = await adapter.fetchTendersByBin("220540025781");

    expect(adapter.source).toBe("goszakup.gov.kz");
    expect(adapter.requiresAuth).toBe(true);
    expect(adapter.isAvailable()).toBe(true);
    expect(fetchGoszakupTenders).toHaveBeenCalledWith("220540025781");
    expect(result).toEqual([tender]);
  });

  it("StatGovAdapter delegates collection then reads storage", async () => {
    const { StatGovAdapter } = await import("../../src/adapters/kz/StatGovAdapter.js");
    collectStatGovForBins.mockResolvedValue({ processed: 1, success: 1, failed: 0, skipped: 0, cached: 0 });

    const adapter = new StatGovAdapter({ databasePath: ":memory:", forceRefresh: true });
    const result = await adapter.fetchByBin("220540025781");

    expect(collectStatGovForBins).toHaveBeenCalledWith(["220540025781"], {
      databasePath: ":memory:",
      forceRefresh: true
    });
    expect(result).toBeNull();
  });
});

function tenderRecord(source: TenderRecord["source"]): TenderRecord {
  return {
    source,
    bin: "220540025781",
    tender_number: "T-1",
    tender_name: "Tender",
    customer_name: "API-KZ",
    budget_amount: "100",
    currency: "KZT",
    start_date: null,
    end_date: null,
    status: "PUBLISHED",
    method: null,
    url: null,
    parsed_at: "2026-06-07T00:00:00.000Z"
  };
}
