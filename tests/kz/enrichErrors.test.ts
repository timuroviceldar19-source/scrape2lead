import { describe, expect, it } from "vitest";
import { dedupeEnrichErrors } from "../../src/kz/enrichErrors.js";
import type { EnrichError } from "../../src/kz/tenderTypes.js";

function error(id: number, bin: string, stage: string, message: string): EnrichError {
  return { id, bin, stage, message, created_at: `2026-06-08T${id}:00:00.000Z` };
}

describe("dedupeEnrichErrors", () => {
  it("keeps the latest error per bin and stage", () => {
    const result = dedupeEnrichErrors([
      error(1, "100000000001", "stat_gov", "old timeout"),
      error(2, "100000000001", "stat_gov", "stat.gov: BIN not found in BNS database"),
      error(3, "100000000001", "zakup", "search input not found")
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((e) => e.stage === "stat_gov")?.message).toContain("BNS database");
    expect(result.find((e) => e.stage === "zakup")?.id).toBe(3);
  });

  it("filters by allowed bins when provided", () => {
    const result = dedupeEnrichErrors([
      error(1, "100000000001", "stat_gov", "a"),
      error(2, "100000000002", "stat_gov", "b")
    ], ["100000000001"]);

    expect(result).toHaveLength(1);
    expect(result[0].bin).toBe("100000000001");
  });
});
