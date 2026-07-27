import { describe, expect, it, vi } from "vitest";
import {
  planProcurementRemediation, sha256, verifyRemediationPlan
} from "../../src/bitrix/procurementRemediation.js";
import type { ProcurementCardAuditRow } from "../../src/bitrix/procurementCardAudit.js";
import { EMPTY_PLAN_PERIOD } from "../../src/kz/procurement/planPeriod.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

const AUDIT_BODY = '{"generatedAt":"2026-07-27T00:00:00.000Z"}\n';

describe("procurement remediation plan", () => {
  it("rewrites a relevant card and clears its stale BEGINDATE", () => {
    const plan = planProcurementRemediation(AUDIT_BODY,
      [row({ findings: ["still_relevant", "begindate_will_be_cleared"], currentBeginDate: "2026-04-15" })],
      [record()]);

    expect(plan.counts).toEqual({ update: 1, skip: 0 });
    expect(plan.items[0]).toMatchObject({ dealId: "43001", action: "update" });
    expect(plan.items[0]?.fields.BEGINDATE).toBe("");
    expect(plan.items[0]?.fields.UF_CRM_TRADE_METHOD).toBe("2026");
  });

  it("never sends the stage or the assignee", () => {
    const plan = planProcurementRemediation(AUDIT_BODY,
      [row({ findings: ["still_relevant"], stageId: "C1:UC_XMKT7F", assignedById: "2255" })], [record()]);

    expect(plan.items[0]?.fields).not.toHaveProperty("STAGE_ID");
    expect(plan.items[0]?.fields).not.toHaveProperty("ASSIGNED_BY_ID");
    expect(() => verifyRemediationPlan(plan, AUDIT_BODY)).not.toThrow();
  });

  it("leaves a card that needs a human decision untouched", () => {
    const plan = planProcurementRemediation(AUDIT_BODY,
      [row({ findings: ["wrong_plan_year", "begindate_will_be_cleared"] })], [record({ planYear: 2024 })]);

    expect(plan.counts).toEqual({ update: 0, skip: 1 });
    expect(plan.items[0]).toMatchObject({ action: "skip", reason: expect.stringContaining("wrong_plan_year") });
    expect(plan.items[0]?.fields).toEqual({});
  });

  it("preserves and corrects an approved out-of-window plan only under the explicit policy", () => {
    const plan = planProcurementRemediation(AUDIT_BODY,
      [row({
        findings: ["wrong_plan_year", "begindate_will_be_cleared"],
        currentBeginDate: "2026-04-15",
        upstreamPlanYear: 2024,
        upstreamStatus: "РЈС‚РІРµСЂР¶РґРµРЅ"
      })],
      [record({ planYear: 2024, planYearId: 9 })],
      { wrongPlanYear: "preserve-and-correct" });

    expect(plan.counts).toEqual({ update: 1, skip: 0 });
    expect(plan.items[0]).toMatchObject({ action: "update", reason: "preserve_wrong_plan_year" });
    expect(plan.items[0]?.fields.BEGINDATE).toBe("");
    expect(plan.items[0]?.fields.UF_CRM_TRADE_METHOD).toBe("2024");
    expect(plan.items[0]?.fields).not.toHaveProperty("STAGE_ID");
    expect(plan.items[0]?.fields).not.toHaveProperty("ASSIGNED_BY_ID");
  });

  it("does not override other manual-decision findings under the preserve policy", () => {
    const plan = planProcurementRemediation(AUDIT_BODY,
      [row({ findings: ["wrong_plan_year", "status_changed", "begindate_will_be_cleared"] })],
      [record({ planYear: 2024, planYearId: 9, status: "РћС‚РјРµРЅРµРЅ" })],
      { wrongPlanYear: "preserve-and-correct" });

    expect(plan.items[0]).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("status_changed")
    });
  });

  it("skips a card whose upstream record was not resolved", () => {
    const plan = planProcurementRemediation(AUDIT_BODY, [row({ findings: ["still_relevant"] })], []);
    expect(plan.items[0]).toMatchObject({ action: "skip", reason: "upstream_record_missing" });
  });

  it("accepts execution only against the audit file the plan was built from", () => {
    const plan = planProcurementRemediation(AUDIT_BODY, [row({ findings: ["still_relevant"] })], [record()]);

    expect(plan.auditSha256).toBe(sha256(AUDIT_BODY));
    expect(() => verifyRemediationPlan(plan, AUDIT_BODY)).not.toThrow();
    expect(() => verifyRemediationPlan(plan, `${AUDIT_BODY}tampered`))
      .toThrow(/does not match the audit file/);
  });

  it("refuses a plan that somehow carries a forbidden field", () => {
    const plan = planProcurementRemediation(AUDIT_BODY, [row({ findings: ["still_relevant"] })], [record()]);
    plan.items[0]!.fields.STAGE_ID = "C1:WON";

    expect(() => verifyRemediationPlan(plan, AUDIT_BODY)).toThrow(/must never send STAGE_ID/);
  });

  it("builds the plan without contacting Bitrix", () => {
    const client = { addDeal: vi.fn(), updateDeal: vi.fn() };
    planProcurementRemediation(AUDIT_BODY, [row({ findings: ["still_relevant"] })], [record()]);
    expect(client.addDeal).not.toHaveBeenCalled();
    expect(client.updateDeal).not.toHaveBeenCalled();
  });
});

function row(overrides: Partial<ProcurementCardAuditRow> = {}): ProcurementCardAuditRow {
  return {
    dealId: "43001", originId: "proc:samruk:plan:19354222", source: "samruk", recordKind: "plan",
    upstreamKey: "19354222", findings: [], currentBeginDate: null, upstreamPlanYear: 2026,
    upstreamStatus: "Утвержден", stageId: "C1:NEW", assignedById: "2255", notes: [], ...overrides
  };
}

function record(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return {
    source: "samruk", recordKind: "plan", sourceRecordId: "19354222", externalId: "ext-1",
    parentExternalId: null, status: "Утвержден", productName: "Компьютер", description: "",
    truCode: "262013.000.000011", customerName: "Customer", customerBin: "123456789012",
    amount: 900_000, currency: "KZT", startDate: null, endDate: null,
    url: "https://zakup.gov.kz/plan-items/19354222", purchaseMethod: null,
    ...EMPTY_PLAN_PERIOD, planYear: 2026, planYearId: 12,
    collectedAt: "2026-07-27T00:00:00.000Z", ...overrides
  };
}
