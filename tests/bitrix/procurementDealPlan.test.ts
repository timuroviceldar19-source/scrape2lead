import { describe, expect, it } from "vitest";
import {
  buildProcurementDealDecision,
  procurementOpportunityOriginId,
  verifyProcurementAssignmentGate
} from "../../src/bitrix/procurementDealPlan.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

describe("procurement Bitrix lifecycle", () => {
  it("creates plans in F3-B2B tenders without hardcoded assignee", () => {
    const result = buildProcurementDealDecision(row(), null);
    expect(result.action).toBe("create");
    expect(result.fields).toMatchObject({ CATEGORY_ID: 1, STAGE_ID: "C1:NEW", OPENED: "Y" });
    expect(result.fields).not.toHaveProperty("ASSIGNED_BY_ID");
    expect(result.fields).toMatchObject({
      ORIGINATOR_ID: "scrape2lead-procurement",
      ORIGIN_ID: "proc:mitwork:plan:42"
    });
  });

  it("updates the linked plan when its tender is published without resetting manual stage", () => {
    const tender = row({ recordKind: "tender", externalId: "lot-9", parentExternalId: "42", status: "Опубликован" });
    const result = buildProcurementDealDecision(tender, {
      ID: "500", CATEGORY_ID: "1", STAGE_ID: "C1:UC_XMKT7F", ASSIGNED_BY_ID: "2015"
    });
    expect(result.action).toBe("update");
    expect(result.dealId).toBe("500");
    expect(result.fields).not.toHaveProperty("STAGE_ID");
    expect(result.fields).not.toHaveProperty("ASSIGNED_BY_ID");
    expect(result.fields).toMatchObject({ CATEGORY_ID: 1, OPENED: "Y" });
  });

  it("passes the distribution gate only for the configured manager pool", () => {
    expect(procurementOpportunityOriginId(row({ sourceRecordId: "42", externalId: "MTW-42" })))
      .toBe(procurementOpportunityOriginId(row({ recordKind: "tender", externalId: "lot-9", parentExternalId: "42" })));

    expect(verifyProcurementAssignmentGate([
      { ID: "1", ASSIGNED_BY_ID: "2015" },
      { ID: "2", ASSIGNED_BY_ID: "2209" },
      { ID: "3", ASSIGNED_BY_ID: "2255" }
    ])).toEqual({ ok: true, invalidDealIds: [] });
    expect(verifyProcurementAssignmentGate([
      { ID: "1", ASSIGNED_BY_ID: "2301" },
      { ID: "2", ASSIGNED_BY_ID: "999" }
    ])).toEqual({ ok: false, invalidDealIds: ["1", "2"] });
  });
});

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return {
    source: "mitwork", recordKind: "plan", sourceRecordId: null, externalId: "42", parentExternalId: null,
    status: "Утвержден", productName: "Ноутбук", description: "16 GB", truCode: "262011.100.000002",
    customerName: "Customer", customerBin: "123456789012", amount: 1_000_000, currency: "KZT",
    startDate: null, endDate: null, url: "https://example.kz/42", purchaseMethod: "ЗЦП",
    collectedAt: "2026-07-21T00:00:00.000Z", ...overrides
  };
}
