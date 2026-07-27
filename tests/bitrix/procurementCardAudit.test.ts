import { describe, expect, it, vi } from "vitest";
import {
  auditProcurementCards,
  needsManualDecision,
  parseProcurementOriginId,
  type ProcurementCardDeal
} from "../../src/bitrix/procurementCardAudit.js";
import { EMPTY_PLAN_PERIOD } from "../../src/kz/procurement/planPeriod.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

const OPTIONS = { allowedPlanYears: [2026, 2027], allowedStatuses: ["Утвержден"] };

describe("parseProcurementOriginId", () => {
  it("parses a well-formed origin id", () => {
    expect(parseProcurementOriginId("proc:samruk:plan:19354222"))
      .toEqual({ source: "samruk", recordKind: "plan", upstreamKey: "19354222" });
  });

  it("refuses to guess at anything else", () => {
    for (const value of ["", null, "gz-plan:123", "proc:samruk:plan", "proc:unknown:plan:1", "proc:samruk:lot:1", "proc:samruk:plan:"]) {
      expect(parseProcurementOriginId(value)).toBeNull();
    }
  });
});

describe("auditProcurementCards", () => {
  it("flags a 2024 card as the wrong plan year and marks its stale BEGINDATE", () => {
    const result = auditProcurementCards(
      [deal({ ID: "43001", ORIGIN_ID: "proc:samruk:plan:19354222", BEGINDATE: "2026-04-15" })],
      [record({ sourceRecordId: "19354222", planYear: 2024 })],
      OPTIONS
    );

    expect(result.rows[0]?.findings).toEqual(expect.arrayContaining(["wrong_plan_year", "begindate_will_be_cleared"]));
    expect(result.rows[0]).toMatchObject({ upstreamPlanYear: 2024, currentBeginDate: "2026-04-15" });
    expect(needsManualDecision(result.rows[0]!)).toBe(true);
  });

  it("recognises a plan whose tender is published and shares the same card", () => {
    const result = auditProcurementCards(
      [deal({ ID: "43002", ORIGIN_ID: "proc:samruk:plan:555" })],
      [
        record({ sourceRecordId: "555", planYear: 2026 }),
        record({ recordKind: "tender", externalId: "lot-1", parentExternalId: "555", sourceRecordId: "lot-1" })
      ],
      OPTIONS
    );

    expect(result.rows[0]?.findings).toContain("superseded_by_tender");
    expect(needsManualDecision(result.rows[0]!)).toBe(false);
  });

  it("keeps a current, approved card as still relevant", () => {
    const result = auditProcurementCards(
      [deal({ ID: "43003", ORIGIN_ID: "proc:mitwork:plan:777", BEGINDATE: "" })],
      [record({ source: "mitwork", sourceRecordId: "777", planYear: 2026 })],
      OPTIONS
    );

    expect(result.rows[0]?.findings).toEqual(["still_relevant"]);
    expect(result.counts.still_relevant).toBe(1);
  });

  it("reports several independent findings on one card", () => {
    const result = auditProcurementCards(
      [deal({ ID: "43004", ORIGIN_ID: "proc:samruk:plan:888", BEGINDATE: "2026-04-15" })],
      [
        record({ sourceRecordId: "888", planYear: 2024, status: "Отменен" }),
        record({ recordKind: "tender", externalId: "lot-2", parentExternalId: "888", sourceRecordId: "lot-2" })
      ],
      OPTIONS
    );

    expect(result.rows[0]?.findings.sort()).toEqual(
      ["begindate_will_be_cleared", "status_changed", "superseded_by_tender", "wrong_plan_year"]
    );
    expect(result.rows[0]?.findings).not.toContain("still_relevant");
  });

  it("marks a card whose upstream record no longer exists", () => {
    const result = auditProcurementCards([deal({ ID: "43005", ORIGIN_ID: "proc:samruk:plan:999" })], [], OPTIONS);
    expect(result.rows[0]?.findings).toEqual(["not_found_upstream"]);
  });

  it("does not guess at a card whose origin id it cannot parse", () => {
    const result = auditProcurementCards([deal({ ID: "43006", ORIGIN_ID: "gz-plan:12345" })], [], OPTIONS);
    expect(result.rows[0]).toMatchObject({ findings: ["unparsable_origin"], source: null, upstreamKey: null });
  });

  it("counts every finding across the whole set", () => {
    const result = auditProcurementCards(
      [
        deal({ ID: "1", ORIGIN_ID: "proc:samruk:plan:1", BEGINDATE: "2026-04-15" }),
        deal({ ID: "2", ORIGIN_ID: "proc:samruk:plan:2", BEGINDATE: "2026-04-15" }),
        deal({ ID: "3", ORIGIN_ID: "proc:mitwork:plan:3" })
      ],
      [
        record({ sourceRecordId: "1", planYear: 2024 }),
        record({ sourceRecordId: "2", planYear: 2024 }),
        record({ source: "mitwork", sourceRecordId: "3", planYear: 2026 })
      ],
      OPTIONS
    );

    expect(result.counts).toMatchObject({
      wrong_plan_year: 2, begindate_will_be_cleared: 2, still_relevant: 1, not_found_upstream: 0
    });
  });

  it("never issues a write call: it receives plain data and returns plain data", () => {
    const client = { addDeal: vi.fn(), updateDeal: vi.fn() };
    auditProcurementCards([deal({ ID: "1", ORIGIN_ID: "proc:samruk:plan:1" })], [], OPTIONS);
    expect(client.addDeal).not.toHaveBeenCalled();
    expect(client.updateDeal).not.toHaveBeenCalled();
  });
});

function deal(overrides: Partial<ProcurementCardDeal> & { ID: string }): ProcurementCardDeal {
  return { ORIGINATOR_ID: "scrape2lead-procurement", STAGE_ID: "C1:NEW", ASSIGNED_BY_ID: "2255", ...overrides };
}

function record(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return {
    source: "samruk", recordKind: "plan", sourceRecordId: "1", externalId: "ext-1", parentExternalId: null,
    status: "Утвержден", productName: "Ноутбук", description: "", truCode: "262011.100.000002",
    customerName: "Customer", customerBin: "123456789012", amount: 900_000, currency: "KZT",
    startDate: null, endDate: null, url: "https://example.kz/1", purchaseMethod: null,
    ...EMPTY_PLAN_PERIOD, collectedAt: "2026-07-27T00:00:00.000Z", ...overrides
  };
}
