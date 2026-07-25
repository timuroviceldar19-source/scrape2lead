import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { enrichEligibleEpzPlanDetails, parseEpzPlanDetail } from "../../src/kz/procurement/planDetail.js";
import type { ProcurementCollectionCompleteness, ProcurementRecord } from "../../src/kz/procurement/types.js";

const fixture = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/kz/procurement/plan-item-18121209.json"), "utf8"));

describe("EPZ plan detail enrichment", () => {
  it("parses authoritative fields from plan item 18121209", () => {
    const parsed = parseEpzPlanDetail(fixture);
    expect(parsed).toMatchObject({ sourceRecordId: "18121209", externalId: "4128263137", source: "samruk",
      status: "Утвержден", customerBin: "970940002871", truCode: "262030.100.000021",
      quantity: 4, unitPrice: 1_475_000, amount: 5_900_000, approvedAt: "2026-04-15",
      financialYear: 2026, unitName: "Штука" });
    expect(parsed?.deliveries).toEqual([
      { address: "микрорайон Промзона, дом 1.", kato: "101065100", quantity: 4 },
      { address: "г.Аксу ул.Камзина, 1", kato: "551610000", quantity: 5 }
    ]);
  });

  it("fetches each detail id once, retries, and gives detail values priority", async () => {
    const fetchJson = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(fixture);
    const completeness = complete();
    const records = [row(), row()];
    const result = await enrichEligibleEpzPlanDetails(records, { fetchJson, completeness, retryDelayMs: 0 });

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchJson).toHaveBeenCalledWith("https://zakup.gov.kz/api/core/api/public/plan-items/18121209/");
    expect(result.records.every((record) => record.truCode === "262030.100.000021")).toBe(true);
    expect(result.records[0]).toMatchObject({ customerBin: "970940002871", amount: 5_900_000,
      url: "https://zakup.gov.kz/plan-items/18121209", enrichment: { source: "epz-plan-detail", confidence: "exact" } });
    expect(completeness).toMatchObject({ complete: true, detailRequested: 1, detailSucceeded: 1,
      detailFailed: 0, detailIdentityMismatches: 0 });
  });

  it("marks failed and identity-mismatched details as incomplete review issues", async () => {
    const completeness = complete();
    const fetchJson = vi.fn(async (url: string) => url.includes("18121209")
      ? { ...fixture, external_id: "wrong" }
      : Promise.reject(new Error("offline")));
    const result = await enrichEligibleEpzPlanDetails([
      row(), row({ sourceRecordId: "99", externalId: "99" })
    ], { fetchJson, completeness, retryDelayMs: 0, maxAttempts: 2 });

    expect(result.records.map((record) => record.detailIssue)).toEqual(["detail_identity_mismatch", "detail_fetch_failed"]);
    expect(completeness.complete).toBe(false);
    expect(completeness.detailFailed).toBe(1);
    expect(completeness.detailIdentityMismatches).toBe(1);
    expect(completeness.incompleteReasons).toEqual(expect.arrayContaining([
      "plan-detail:18121209:identity_mismatch", "plan-detail:99:fetch_failed"
    ]));
  });
});

function complete(): ProcurementCollectionCompleteness {
  return { complete: true, planYearId: 9, pageLimit: 500, pagesFetched: 1, incompleteReasons: [] };
}

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return { source: "samruk", recordKind: "plan", sourceRecordId: "18121209", externalId: "4128263137",
    parentExternalId: null, status: "Утвержден", productName: "Панель интерактивная", description: "LCD поверхность",
    truCode: null, customerSourceId: "45697", customerName: "ТОО Заказчик", customerBin: null, amount: 5_900_000,
    currency: "KZT", startDate: null, endDate: null, url: "https://example.kz/old", purchaseMethod: null,
    collectedAt: "2026-07-22T00:00:00.000Z", ...overrides };
}
