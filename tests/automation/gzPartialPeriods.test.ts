import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ plans: vi.fn(), lots: vi.fn() }));
vi.mock("../../src/kz/gzPlanExporter.js", () => ({ exportGzPlansReport: mocks.plans }));
vi.mock("../../src/kz/goszakupLotsNstruExporter.js", () => ({ exportGoszakupLotsByNstru: mocks.lots, resolveLotStatusIds: () => [] }));
import { createRealAutomationDependencies } from "../../src/automation/realDependencies.js";

const dirs: string[] = [];
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "gz-periods-")); dirs.push(value); return value; }
beforeEach(() => vi.resetAllMocks());
afterEach(() => { for (const value of dirs.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });
const periods = [{ year: 2026, months: [11, 12] }, { year: 2027, months: [1, 2, 3, 4] }];
const cacheStats = { cacheHit: 0, cacheMiss: 0, fetched: 0, fetchFailed: 0 };
async function part(options: { outPath: string; year: number }, rows: number) {
  const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet("Data");
  sheet.addRow(["Год"]); for (let i = 0; i < rows; i++) sheet.addRow([options.year]);
  await wb.xlsx.writeFile(options.outPath);
  return { xlsxPath: options.outPath, rows, cacheStats, successfulQueries: 1, skippedQueries: [] };
}

describe.each(["plans", "lots"] as const)("partial %s across years", source => {
  function setup() {
    const dir = root(); const config = path.join(dir, "config.json"); fs.writeFileSync(config, JSON.stringify({ keywords: ["Компьютер"] }));
    const deps = createRealAutomationDependencies();
    return { output: path.join(dir, `${source}.xlsx`), config, exportSource: source === "plans" ? deps.exportPlans : deps.exportLots, mock: mocks[source] };
  }
  it("merges a successful first year when the next year times out", async () => {
    const s = setup(); s.mock.mockImplementation(async options => { if (options.year === 2027) throw new Error("fetch failed: ETIMEDOUT"); return part(options, 1); });
    const result = await s.exportSource(s.config, s.output, periods);
    expect(result).toMatchObject({ rows: 1, successfulQueries: 1, skippedQueries: [{ stage: source, year: 2027, months: [1, 2, 3, 4] }] });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(s.output);
    expect(wb.worksheets[0].getRow(2).getCell(1).value).toBe(2026);
    expect(s.mock.mock.calls.every(([options]) => options.partialCollection === true)).toBe(true);
  });
  it("throws a retry-compatible source error when no request succeeded", async () => {
    const s = setup(); s.mock.mockImplementation(async options => ({ ...await part(options, 0), successfulQueries: 0,
      skippedQueries: [{ stage: source, query: "Компьютер", year: options.year, months: options.months,
        failedPage: 1, totalPages: null, keptRows: 0, attempts: 3, reason: "page.goto: Timeout" }] }));
    await expect(s.exportSource(s.config, s.output, periods)).rejects.toMatchObject({
      sourceUnreachable: true, skippedQueries: expect.any(Array), message: expect.stringMatching(/fetch failed/)
    });
    expect(fs.existsSync(s.output)).toBe(true);
  });
  it("allows an empty but successful search", async () => {
    const s = setup(); s.mock.mockImplementation(options => part(options, 0));
    expect(await s.exportSource(s.config, s.output, periods)).toMatchObject({ rows: 0, successfulQueries: 2, skippedQueries: [] });
  });
  it("does not hide a schema or programming error", async () => {
    const s = setup(); s.mock.mockRejectedValue(new TypeError("invalid response schema"));
    await expect(s.exportSource(s.config, s.output, periods)).rejects.toThrow("invalid response schema");
  });
});
