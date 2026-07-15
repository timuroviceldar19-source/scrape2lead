import { describe, expect, it } from "vitest";
import {
  buildGzPlanNumberUpdate,
  canExecuteGzPlanNumberBackfill,
  decideGzPlanNumberWrite,
  isGzPlanNumberBackfillCandidate,
  planGzPlanNumberBackfill,
  resolveGzPlanNumberSource,
  type GzBackfillDeal,
  type GzPlanNumberReportEntry
} from "../../src/bitrix/gzPlanNumberBackfill.js";

// Deal 39149's plan point: legacy URL segment 4751746, canonical point 86795650.
const LEGACY_URL = "https://goszakup.gov.kz/ru/registry/show_plan/86795650/4751746";
// Row 21 of run 20260715-120949: the same lineage after goszakup amended it.
const AMENDED_URL = "https://goszakup.gov.kz/ru/registry/show_plan/87173984/4753515";

// Deals 41719 and 38807 in the live CRM: two distinct canonical points, one legacy segment.
const COLLIDING_URL_A = "https://goszakup.gov.kz/ru/registry/show_plan/87018811/4775438";
const COLLIDING_URL_B = "https://goszakup.gov.kz/ru/registry/show_plan/87018653/4775438";

function makeDeal(overrides: Partial<GzBackfillDeal> = {}): GzBackfillDeal {
  return {
    ID: "39149",
    ORIGINATOR_ID: "scrape2lead-gz-plans",
    STAGE_ID: "C41:PREPAYMENT_INVOIC",
    UF_CRM_PLAN_ID: null,
    UF_CRM_PLAN_LINK: AMENDED_URL,
    ...overrides
  };
}

function makeEntry(overrides: Partial<GzPlanNumberReportEntry> = {}): GzPlanNumberReportEntry {
  return {
    dealId: "39149",
    canonicalPlanPointId: "87173984",
    planNumber: "86795650",
    source: "canonical-page",
    stageId: "C41:PREPAYMENT_INVOIC",
    ...overrides
  };
}

describe("isGzPlanNumberBackfillCandidate", () => {
  it("accepts a GZ plans deal with an empty plan number", () => {
    expect(isGzPlanNumberBackfillCandidate(makeDeal())).toBe(true);
  });

  it("skips a deal that already carries a plan number", () => {
    expect(isGzPlanNumberBackfillCandidate(makeDeal({ UF_CRM_PLAN_ID: "86795650" }))).toBe(false);
    expect(isGzPlanNumberBackfillCandidate(makeDeal({ UF_CRM_PLAN_ID: 86795650 }))).toBe(false);
  });

  it("skips deals from a foreign originator", () => {
    // GZ lots carry no plan number at all and must never enter the set.
    expect(isGzPlanNumberBackfillCandidate(makeDeal({ ORIGINATOR_ID: "scrape2lead-gz-lots" }))).toBe(false);
    expect(isGzPlanNumberBackfillCandidate(makeDeal({ ORIGINATOR_ID: "app_iu_xls_import" }))).toBe(false);
    expect(isGzPlanNumberBackfillCandidate(makeDeal({ ORIGINATOR_ID: null }))).toBe(false);
  });

  it("skips archived duplicates on any DUPLICATE stage", () => {
    expect(isGzPlanNumberBackfillCandidate(makeDeal({ STAGE_ID: "C41:DUPLICATE" }))).toBe(false);
    expect(isGzPlanNumberBackfillCandidate(makeDeal({ STAGE_ID: "C9:DUPLICATE" }))).toBe(false);
  });
});

describe("resolveGzPlanNumberSource", () => {
  it("separates the canonical point id from the legacy segment", () => {
    expect(resolveGzPlanNumberSource(makeDeal({ UF_CRM_PLAN_LINK: LEGACY_URL }))).toEqual({
      canonicalPlanPointId: "86795650",
      legacyPlanId: "4751746"
    });
  });

  it("keeps two canonical points that share a legacy segment apart", () => {
    const a = resolveGzPlanNumberSource(makeDeal({ ID: "41719", UF_CRM_PLAN_LINK: COLLIDING_URL_A }));
    const b = resolveGzPlanNumberSource(makeDeal({ ID: "38807", UF_CRM_PLAN_LINK: COLLIDING_URL_B }));

    expect(a?.legacyPlanId).toBe(b?.legacyPlanId);
    expect(a?.canonicalPlanPointId).not.toBe(b?.canonicalPlanPointId);
  });

  it("offers no cache key at all, so no page can be shared between two points", () => {
    // The 20260715 backfill exposed `snapshotId = legacyPlanId` here and read one
    // page for both 87018811 and 87018653. 26 legacy segments in the live CRM are
    // shared this way; a value read under that key is evidence about neither point.
    const source = resolveGzPlanNumberSource(makeDeal({ UF_CRM_PLAN_LINK: COLLIDING_URL_A }));

    expect(source).not.toHaveProperty("snapshotId");
    expect(Object.keys(source ?? {})).toEqual(["canonicalPlanPointId", "legacyPlanId"]);
  });

  it("falls back to the alternate link field", () => {
    const deal = makeDeal({ UF_CRM_PLAN_LINK: null, UF_CRM_1782386571874_IU_XLS: LEGACY_URL });

    expect(resolveGzPlanNumberSource(deal)?.canonicalPlanPointId).toBe("86795650");
  });

  it("returns null when the deal carries no usable plan link", () => {
    expect(resolveGzPlanNumberSource(makeDeal({ UF_CRM_PLAN_LINK: "" }))).toBeNull();
    expect(resolveGzPlanNumberSource(makeDeal({ UF_CRM_PLAN_LINK: "https://example.test/x" }))).toBeNull();
  });
});

describe("planGzPlanNumberBackfill", () => {
  it("sends every candidate to its own canonical page load", () => {
    const plan = planGzPlanNumberBackfill([makeDeal()]);

    expect(plan.unresolved).toEqual([]);
    expect(plan.pending).toEqual([
      {
        dealId: "39149",
        canonicalPlanPointId: "87173984",
        planLink: AMENDED_URL,
        stageId: "C41:PREPAYMENT_INVOIC"
      }
    ]);
  });

  it("never lets two candidates behind one legacy segment share a page load", () => {
    const plan = planGzPlanNumberBackfill([
      makeDeal({ ID: "41719", UF_CRM_PLAN_LINK: COLLIDING_URL_A }),
      makeDeal({ ID: "38807", UF_CRM_PLAN_LINK: COLLIDING_URL_B })
    ]);

    expect(plan.pending).toHaveLength(2);
    expect(plan.pending.map((target) => target.canonicalPlanPointId)).toEqual(["87018811", "87018653"]);
    expect(plan.pending.map((target) => target.planLink)).toEqual([COLLIDING_URL_A, COLLIDING_URL_B]);
  });

  it("defers a candidate carrying no usable plan link", () => {
    const plan = planGzPlanNumberBackfill([makeDeal({ UF_CRM_PLAN_LINK: "" })]);

    expect(plan.pending).toEqual([]);
    expect(plan.unresolved).toEqual([
      { dealId: "39149", canonicalPlanPointId: "", reason: "no usable plan link" }
    ]);
  });

  it("excludes non-candidates from the plan entirely", () => {
    const plan = planGzPlanNumberBackfill([
      makeDeal({ ID: "1", UF_CRM_PLAN_ID: "111" }),
      makeDeal({ ID: "2", ORIGINATOR_ID: "scrape2lead-gz-lots" })
    ]);

    expect(plan.pending).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });
});

describe("canExecuteGzPlanNumberBackfill", () => {
  it("allows execute when every candidate resolved", () => {
    expect(canExecuteGzPlanNumberBackfill({ resolved: [makeEntry()], unresolved: [] }).ok).toBe(true);
  });

  it("refuses execute while any candidate is unresolved", () => {
    const verdict = canExecuteGzPlanNumberBackfill({
      resolved: [makeEntry()],
      unresolved: [{ dealId: "40001", canonicalPlanPointId: "86795650", reason: "page did not load" }]
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("40001");
  });

  it("refuses execute on an empty report", () => {
    expect(canExecuteGzPlanNumberBackfill({ resolved: [], unresolved: [] }).ok).toBe(false);
  });
});

describe("decideGzPlanNumberWrite", () => {
  it("writes when the deal is still empty and matches the report", () => {
    expect(decideGzPlanNumberWrite(makeEntry(), makeDeal())).toEqual({
      action: "write",
      fields: { UF_CRM_PLAN_ID: "86795650" }
    });
  });

  it("skips a deal already carrying the expected number so a re-run is idempotent", () => {
    const decision = decideGzPlanNumberWrite(makeEntry(), makeDeal({ UF_CRM_PLAN_ID: "86795650" }));

    expect(decision.action).toBe("skip-filled");
  });

  it("reports drift when the deal gained a different number since the report", () => {
    const decision = decideGzPlanNumberWrite(makeEntry(), makeDeal({ UF_CRM_PLAN_ID: "99999999" }));

    expect(decision.action).toBe("drift");
  });

  it("reports drift when the deal's plan link no longer matches the report", () => {
    const decision = decideGzPlanNumberWrite(makeEntry(), makeDeal({ UF_CRM_PLAN_LINK: LEGACY_URL }));

    expect(decision.action).toBe("drift");
  });

  it("reports drift when the deal moved to a DUPLICATE stage since the report", () => {
    const decision = decideGzPlanNumberWrite(makeEntry(), makeDeal({ STAGE_ID: "C41:DUPLICATE" }));

    expect(decision.action).toBe("drift");
  });
});

describe("buildGzPlanNumberUpdate", () => {
  it("touches nothing but the plan number field", () => {
    expect(buildGzPlanNumberUpdate("86795650")).toEqual({ UF_CRM_PLAN_ID: "86795650" });
    expect(Object.keys(buildGzPlanNumberUpdate("86795650"))).toEqual(["UF_CRM_PLAN_ID"]);
  });
});
