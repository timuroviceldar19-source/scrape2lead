import { describe, expect, it } from "vitest";
import {
  buildGzDuplicateSearches,
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
