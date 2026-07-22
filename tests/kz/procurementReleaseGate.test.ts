import { describe, expect, it } from "vitest";
import { evaluateProcurementCollectionGate, evaluateProcurementReleaseGate } from "../../src/kz/procurement/releaseGate.js";

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
    expect(evaluateProcurementCollectionGate({ complete: false, planYearId: 9, pageLimit: 500, pagesFetched: 500,
      incompleteReasons: ["plan-items:Компьютер:page_limit"] })).toEqual({
      ok: false, reasons: ["collection_incomplete", "plan-items:Компьютер:page_limit"]
    });
  });
});
