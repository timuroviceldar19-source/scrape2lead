import { describe, expect, it } from "vitest";
import { evaluateProcurementReleaseGate } from "../../src/kz/procurement/releaseGate.js";

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
});
