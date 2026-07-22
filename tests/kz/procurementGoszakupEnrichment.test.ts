import { describe, expect, it } from "vitest";
import { applyGoszakupEnrichmentCandidates } from "../../src/kz/procurement/goszakupEnrichment.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

describe("strict Goszakup enrichment", () => {
  it("fills values only when a stable upstream key matches exactly", () => {
    const [result] = applyGoszakupEnrichmentCandidates([row()], [{
      upstreamKey: "samruk:plan:42", customerName: "ТОО Покупатель", bin: "123456789012",
      truCode: "262011.100.000002"
    }]);
    expect(result).toMatchObject({ customerBin: "123456789012", truCode: "262011.100.000002",
      enrichment: { source: "goszakup", confidence: "exact" } });
  });

  it("keeps a unique exact-name match as a candidate without filling CRM fields", () => {
    const [result] = applyGoszakupEnrichmentCandidates([row()], [{
      customerName: "  тоо  покупатель ", bin: "123456789012"
    }]);
    expect(result?.customerBin).toBeNull();
    expect(result?.truCode).toBeNull();
    expect(result?.enrichment).toMatchObject({ source: "goszakup", confidence: "candidate", candidateBin: "123456789012" });
  });

  it("does not annotate ambiguous name matches", () => {
    const [result] = applyGoszakupEnrichmentCandidates([row()], [
      { customerName: "ТОО Покупатель", bin: "123456789012" },
      { customerName: "ТОО Покупатель", bin: "999999999999" }
    ]);
    expect(result?.enrichment).toBeUndefined();
  });
});

function row(): ProcurementRecord {
  return { source: "samruk", recordKind: "plan", sourceRecordId: "42", externalId: "42", parentExternalId: null,
    status: "Утвержден", productName: "Ноутбук", description: "", truCode: null,
    customerName: "ТОО Покупатель", customerBin: null, amount: 1_000_000, currency: "KZT",
    startDate: null, endDate: null, url: "https://example.kz/42", purchaseMethod: null,
    collectedAt: "2026-07-22T00:00:00Z" };
}
