import { describe, expect, it } from "vitest";
import { describeOutcomeCoverage, type OutcomeCoverageInput } from "../../src/bitrix/gzOutcomeCoverage.js";

function input(overrides: Partial<OutcomeCoverageInput> = {}): OutcomeCoverageInput {
  return {
    planPages: { pending: 55, failed: 0 },
    status: { pending: 344, attempted: 344, failed: 0, budgetReached: false },
    registers: { failed: 0 },
    ...overrides
  };
}

describe("describeOutcomeCoverage", () => {
  it("says how many deals the portal check covered out of how many needed it", () => {
    const { markdown } = describeOutcomeCoverage(input());

    expect(markdown).toContain("проверен у 344 из 344");
    expect(markdown).toContain("загружено 55 из 55");
  });

  it("reports the deals left for the next runs when the limit cut the check short", () => {
    const { markdown } = describeOutcomeCoverage(
      input({ status: { pending: 344, attempted: 200, failed: 0, budgetReached: false } })
    );

    expect(markdown).toContain("проверен у 200 из 344");
    expect(markdown).toContain("остальные 144 — в следующих прогонах");
  });

  it("names the time budget when it is what stopped the check", () => {
    const { markdown } = describeOutcomeCoverage(
      input({ status: { pending: 344, attempted: 120, failed: 0, budgetReached: true } })
    );

    expect(markdown).toContain("лимит времени");
  });

  it("warns when most portal requests failed, as the 255 of 255 failures did before the certificate fix", () => {
    const { warning, markdown } = describeOutcomeCoverage(
      input({
        planPages: { pending: 55, failed: 55 },
        status: { pending: 344, attempted: 200, failed: 200, budgetReached: false }
      })
    );

    expect(warning).toContain("255 из 255");
    expect(markdown).toContain("⚠️");
  });

  it("stays quiet when the share of failures is small", () => {
    const { warning, markdown } = describeOutcomeCoverage(
      input({ status: { pending: 344, attempted: 344, failed: 30, budgetReached: false } })
    );

    expect(warning).toBeNull();
    expect(markdown).not.toContain("⚠️");
  });

  it("stays quiet when too few requests were made to judge", () => {
    const { warning } = describeOutcomeCoverage(
      input({ planPages: { pending: 0, failed: 0 }, status: { pending: 4, attempted: 4, failed: 4, budgetReached: false } })
    );

    expect(warning).toBeNull();
  });

  it("puts stable keys into the one-line report", () => {
    const { line } = describeOutcomeCoverage(
      input({ status: { pending: 344, attempted: 200, failed: 7, budgetReached: false }, registers: { failed: 1 } })
    );

    expect(line).toBe("html_status_checked=200 html_status_pending=344 plan_pages_pending=55 portal_failed=8");
  });

  it("says nothing was needed when no deal required the portal", () => {
    const { markdown } = describeOutcomeCoverage(
      input({ planPages: { pending: 0, failed: 0 }, status: { pending: 0, attempted: 0, failed: 0, budgetReached: false } })
    );

    expect(markdown).toContain("не потребовалась");
  });
});
