import { describe, expect, it } from "vitest";
import {
  buildGzDuplicateSearches,
  evaluateGzDuplicateSearchResults,
  type GzDuplicateSearch,
  type GzDuplicateSearchInput
} from "../../src/bitrix/gzDuplicateSearch.js";

// Real data from run 20260715-120949, rows 10-13: four distinct interactive
// panels planned by the same school district, each at exactly 1 500 000 KZT.
function alakolRow(overrides: Partial<GzDuplicateSearchInput> = {}): GzDuplicateSearchInput {
  return {
    planPointId: "87359412",
    planNumber: "87121620",
    planUrl: "https://goszakup.gov.kz/ru/registry/show_plan/87359412/4813388",
    bin: "101240006118",
    amount: 1_500_000,
    ...overrides
  };
}

function reasons(input: GzDuplicateSearchInput): string[] {
  return buildGzDuplicateSearches(input).map((search) => search.reason);
}

function blockingReasons(input: GzDuplicateSearchInput): string[] {
  return buildGzDuplicateSearches(input)
    .filter((search) => search.blocking)
    .map((search) => search.reason);
}

describe("buildGzDuplicateSearches", () => {
  it("treats BIN + amount as advisory rather than blocking", () => {
    const binSearch = buildGzDuplicateSearches(alakolRow())
      .find((search) => search.reason === "BIN + amount");

    expect(binSearch).toBeDefined();
    expect(binSearch?.blocking).toBe(false);
  });

  it("keeps every exact identity rule blocking", () => {
    expect(blockingReasons(alakolRow())).toEqual([
      "plan point id",
      "plan number",
      "plan url",
      "plan url alt"
    ]);
  });

  it("orders exact identity rules before the fuzzy BIN + amount fallback", () => {
    const ordered = reasons(alakolRow());

    expect(ordered).toEqual([
      "plan point id",
      "plan number",
      "plan url",
      "plan url alt",
      "BIN + amount"
    ]);
  });

  it("matches a sibling plan point only through the advisory rule", () => {
    // Deal 40687 is plan point 87268408 for the same BIN at the same amount.
    // None of the exact rules may claim it for row 10's point 87359412.
    const deal40687 = {
      UF_CRM_6A436D5A3614C: "4801277",
      UF_CRM_PLAN_ID: "87121624",
      UF_CRM_PLAN_LINK: "https://goszakup.gov.kz/ru/registry/show_plan/87268408/4801277",
      UF_CRM_6627AEBD7C2D2: "101240006118",
      OPPORTUNITY: 1_500_000
    } as Record<string, unknown>;

    const matching = buildGzDuplicateSearches(alakolRow()).filter((search) =>
      Object.entries(search.filter).every(([field, value]) => deal40687[field] === value)
    );

    expect(matching.map((search) => search.reason)).toEqual(["BIN + amount"]);
    expect(matching.every((search) => search.blocking)).toBe(false);
  });

  it("omits BIN + amount when the BIN or amount is unusable", () => {
    expect(reasons(alakolRow({ bin: null }))).not.toContain("BIN + amount");
    expect(reasons(alakolRow({ amount: 0 }))).not.toContain("BIN + amount");
  });

  it("omits identity rules whose source field is empty", () => {
    expect(reasons(alakolRow({ planNumber: "" }))).not.toContain("plan number");
    expect(reasons(alakolRow({ planUrl: "" }))).not.toContain("plan url");
    expect(reasons(alakolRow({ planUrl: "" }))).not.toContain("plan url alt");
  });
});

interface TestDeal {
  ID?: string | number;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
}

const CURRENT_ORIGIN = { originatorId: "scrape2lead-gz-plans", originId: "gz-plan:87359412" };

function searches(): GzDuplicateSearch[] {
  return buildGzDuplicateSearches(alakolRow());
}

describe("evaluateGzDuplicateSearchResults", () => {
  it("returns the first match in search priority order", () => {
    const all = searches();
    const results: TestDeal[][] = all.map(() => []);
    // Populate both the plan-number search (index 1) and BIN+amount (last).
    results[1] = [{ ID: "555", ORIGINATOR_ID: "manual", ORIGIN_ID: "x" }];
    results[all.length - 1] = [{ ID: "777", ORIGINATOR_ID: "manual", ORIGIN_ID: "y" }];

    const match = evaluateGzDuplicateSearchResults(all, results, CURRENT_ORIGIN);
    expect(match?.deal.ID).toBe("555");
    expect(match?.reason).toBe("plan number");
    expect(match?.blocking).toBe(true);
  });

  it("never treats the row's own canonical deal as a duplicate", () => {
    const all = searches();
    const results: TestDeal[][] = all.map(() => []);
    results[0] = [{ ID: "900", ORIGINATOR_ID: CURRENT_ORIGIN.originatorId, ORIGIN_ID: CURRENT_ORIGIN.originId }];

    expect(evaluateGzDuplicateSearchResults(all, results, CURRENT_ORIGIN)).toBeNull();
  });

  it("skips a deal already seen in an earlier search", () => {
    const all = searches();
    const results: TestDeal[][] = all.map(() => []);
    const sibling: TestDeal = { ID: "40687", ORIGINATOR_ID: "manual", ORIGIN_ID: "z" };
    results[0] = [{ ID: "900", ORIGINATOR_ID: CURRENT_ORIGIN.originatorId, ORIGIN_ID: CURRENT_ORIGIN.originId }];
    results[all.length - 1] = [sibling];

    const match = evaluateGzDuplicateSearchResults(all, results, CURRENT_ORIGIN);
    expect(match?.deal.ID).toBe("40687");
    expect(match?.blocking).toBe(false); // advisory BIN + amount
  });

  it("returns null when no search produced a foreign deal", () => {
    const all = searches();
    const results: TestDeal[][] = all.map(() => []);
    expect(evaluateGzDuplicateSearchResults(all, results, CURRENT_ORIGIN)).toBeNull();
  });
});
