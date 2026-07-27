import { describe, expect, it } from "vitest";
import { evaluateProcurementCollectionGate, evaluateProcurementReleaseGate } from "../../src/kz/procurement/releaseGate.js";
import type { ProcurementCollectionCompleteness } from "../../src/kz/procurement/types.js";

describe("procurement release gate", () => {
  it("requires seven clean manual XLSX/dry-run checks plus assignment verification", () => {
    const clean = Array.from({ length: 7 }, (_, index) => ({
      runId: `run-${index + 1}`, irrelevantProducts: 0, automaticDuplicates: 0, assignmentVerified: true
    }));
    expect(evaluateProcurementReleaseGate(clean, 7)).toEqual({ ok: true, reasons: [] });
    expect(evaluateProcurementReleaseGate(clean.slice(0, 6), 7)).toMatchObject({ ok: false });
    expect(evaluateProcurementReleaseGate([...clean.slice(0, 6), { ...clean[6], assignmentVerified: false }], 7).reasons)
      .toContain("assignment_not_verified");
  });

  it("blocks production push for an incomplete collection", () => {
    expect(evaluateProcurementCollectionGate(collection({ complete: false,
      incompleteReasons: ["plan-items:Компьютер:page_limit"] }))).toEqual({
      ok: false, reasons: ["collection_incomplete", "plan-items:Компьютер:page_limit"]
    });
  });

  it("blocks production push when a record contradicts the plan year it was collected under", () => {
    expect(evaluateProcurementCollectionGate(collection({ yearConflicts: 3 }))).toEqual({
      ok: false, reasons: ["plan_year_conflicts:3"]
    });
  });

  it("lets a not-yet-opened future year and an absent source status through as warnings", () => {
    expect(evaluateProcurementCollectionGate(collection({
      unresolvedFutureYears: [2027],
      unavailablePlanStatuses: ["На проверке камерального контроля"],
      warnings: ["plan-status:На проверке камерального контроля:unavailable"]
    }))).toEqual({ ok: true, reasons: [] });
  });
});

function collection(overrides: Partial<ProcurementCollectionCompleteness> = {}): ProcurementCollectionCompleteness {
  return { complete: true, planYears: [{ year: 2026, planYearId: 12 }], pageLimit: 500, pagesFetched: 500,
    incompleteReasons: [], warnings: [], ...overrides };
}
