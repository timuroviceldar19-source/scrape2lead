import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildGzPlanNumberUpdate,
  canExecuteGzPlanNumberBackfill,
  decideGzPlanNumberWrite,
  extractGzPlanNumberFromHeading,
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

// The real page carries a site-wide announcement <h3> before the real heading.
const ANNOUNCEMENT_H3 = "<h3>Всем участникам государственных закупок в сфере строительства!</h3>";
const REAL_PAGE = `<div>${ANNOUNCEMENT_H3}<h3>86795650: Доска специальная</h3></div>`;

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
    source: "snapshot",
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
      legacyPlanId: "4751746",
      snapshotId: "4751746"
    });
  });

  it("looks the snapshot up by the legacy segment, not the canonical id", () => {
    const source = resolveGzPlanNumberSource(makeDeal({ UF_CRM_PLAN_LINK: AMENDED_URL }));

    expect(source?.canonicalPlanPointId).toBe("87173984");
    expect(source?.snapshotId).toBe("4753515");
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

describe("extractGzPlanNumberFromHeading", () => {
  it("reads the number from the real heading", () => {
    expect(extractGzPlanNumberFromHeading(REAL_PAGE)).toBe("86795650");
  });

  it("reads the number from an actual goszakup snapshot", () => {
    const html = fs.readFileSync("data/debug/goszakup-plan-detail-4751746.html", "utf8");

    expect(extractGzPlanNumberFromHeading(html)).toBe("86795650");
  });

  it("ignores the site announcement heading that carries no number", () => {
    expect(extractGzPlanNumberFromHeading(`<div>${ANNOUNCEMENT_H3}</div>`)).toBeNull();
  });

  it("rejects an empty or non-numeric heading", () => {
    expect(extractGzPlanNumberFromHeading("")).toBeNull();
    expect(extractGzPlanNumberFromHeading("<h3></h3>")).toBeNull();
    expect(extractGzPlanNumberFromHeading("<h3>: Доска специальная</h3>")).toBeNull();
    expect(extractGzPlanNumberFromHeading("<h3>ABC123: Доска специальная</h3>")).toBeNull();
  });

  it("rejects an ambiguous page carrying two different numbered headings", () => {
    const ambiguous = "<h3>86795650: Доска специальная</h3><h3>82425225: Панель интерактивная</h3>";

    expect(extractGzPlanNumberFromHeading(ambiguous)).toBeNull();
  });

  it("accepts a page repeating the same numbered heading", () => {
    const repeated = "<h3>86795650: Доска специальная</h3><h3>86795650: Доска специальная</h3>";

    expect(extractGzPlanNumberFromHeading(repeated)).toBe("86795650");
  });
});

describe("planGzPlanNumberBackfill", () => {
  const readSnapshot = (id: string): string | null => (id === "4753515" ? REAL_PAGE : null);

  it("resolves from the local snapshot without deferring to Playwright", () => {
    const plan = planGzPlanNumberBackfill([makeDeal()], { readSnapshot });

    expect(plan.unresolved).toEqual([]);
    expect(plan.resolved).toEqual([makeEntry()]);
  });

  it("defers only the deals with no local snapshot", () => {
    const missing = makeDeal({ ID: "40001", UF_CRM_PLAN_LINK: LEGACY_URL });
    const plan = planGzPlanNumberBackfill([makeDeal(), missing], { readSnapshot });

    expect(plan.resolved.map((entry) => entry.dealId)).toEqual(["39149"]);
    expect(plan.unresolved.map((entry) => entry.dealId)).toEqual(["40001"]);
    expect(plan.unresolved[0].canonicalPlanPointId).toBe("86795650");
  });

  it("defers a candidate whose snapshot carries no numbered heading", () => {
    const plan = planGzPlanNumberBackfill([makeDeal()], {
      readSnapshot: () => `<div>${ANNOUNCEMENT_H3}</div>`
    });

    expect(plan.resolved).toEqual([]);
    expect(plan.unresolved[0].reason).toBe("no numbered heading in snapshot");
  });

  it("defers a candidate carrying no usable plan link", () => {
    const plan = planGzPlanNumberBackfill([makeDeal({ UF_CRM_PLAN_LINK: "" })], { readSnapshot });

    expect(plan.unresolved).toEqual([
      { dealId: "39149", canonicalPlanPointId: "", reason: "no usable plan link" }
    ]);
  });

  it("excludes non-candidates from the plan entirely", () => {
    const plan = planGzPlanNumberBackfill(
      [makeDeal({ ID: "1", UF_CRM_PLAN_ID: "111" }), makeDeal({ ID: "2", ORIGINATOR_ID: "scrape2lead-gz-lots" })],
      { readSnapshot }
    );

    expect(plan.resolved).toEqual([]);
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
      unresolved: [{ dealId: "40001", canonicalPlanPointId: "86795650", reason: "no snapshot" }]
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
