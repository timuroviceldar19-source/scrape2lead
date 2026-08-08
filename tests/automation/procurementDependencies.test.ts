import { describe, expect, it } from "vitest";
import {
  AUTOMATION_RESULT_PREFIX,
  procurementApplyArgs,
  procurementDryRunArgs,
  readAutomationResult
} from "../../src/automation/realDependencies.js";

describe("procurement push arguments", () => {
  it("passes the selected procurement config to dry-run and production push", () => {
    expect(procurementDryRunArgs("report.json", "dry-run.json", "config/f3.json"))
      .toEqual(["--report", "report.json", "--output", "dry-run.json", "--config", "config/f3.json"]);
    expect(procurementApplyArgs("report.json", 25, "config/f3.json"))
      .toEqual(["--report", "report.json", "--execute", "--config", "config/f3.json", "--limit", "25"]);
  });
});

describe("AUTOMATION_RESULT_JSON parsing", () => {
  it("reads paths and counts from the machine-readable line", () => {
    const output = [
      "{",
      '  "mode": "xlsx-only",',
      '  "recordsCollected": 7',
      "}",
      `${AUTOMATION_RESULT_PREFIX}${JSON.stringify({
        xlsxPath: "runs/f3/f3.xlsx", jsonPath: "runs/f3/f3.json",
        counts: { collected: 7, data: 3 }, criticalErrors: [], warnings: ["plan-year:2027:not_open_yet"]
      })}`
    ].join("\n");

    expect(readAutomationResult(output, "collect")).toMatchObject({
      xlsxPath: "runs/f3/f3.xlsx", counts: { collected: 7, data: 3 }
    });
  });

  it("is not fooled by word=digits pairs inside pretty-printed JSON", () => {
    // Прежний parseCounts скрёб стдаут регуляркой и подхватывал бы такие строки.
    const output = [
      '{ "note": "offset=10000 limit=100", "plan_year_id=12": 1 }',
      `${AUTOMATION_RESULT_PREFIX}${JSON.stringify({
        xlsxPath: "a.xlsx", jsonPath: "a.json", counts: { create: 3 }
      })}`
    ].join("\n");

    expect(readAutomationResult(output, "collect").counts).toEqual({ create: 3 });
  });

  it("takes the last line when a script emits more than one", () => {
    const output = [
      `${AUTOMATION_RESULT_PREFIX}${JSON.stringify({ counts: { create: 1 } })}`,
      `${AUTOMATION_RESULT_PREFIX}${JSON.stringify({ counts: { create: 9 } })}`
    ].join("\n");

    expect(readAutomationResult(output, "collect").counts).toEqual({ create: 9 });
  });

  it("fails loudly when the line is missing rather than reporting zeroes", () => {
    expect(() => readAutomationResult('{"counts":{"create":3}}', "collect"))
      .toThrow(/did not emit AUTOMATION_RESULT_JSON/);
  });

  it("fails loudly when the payload is not readable JSON", () => {
    expect(() => readAutomationResult(`${AUTOMATION_RESULT_PREFIX}{not json`, "collect"))
      .toThrow(/unreadable AUTOMATION_RESULT_JSON/);
  });
});
