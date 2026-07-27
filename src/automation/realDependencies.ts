import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { z } from "zod";
import { exportGoszakupLotsByNstru, resolveLotStatusIds } from "../kz/goszakupLotsNstruExporter.js";
import { exportGzPlansReport } from "../kz/gzPlanExporter.js";
import { loadGzPlansConfig, mergeGzPlansExportOptions } from "../kz/gzPlansConfig.js";
import type { AutomationDependencies, AutomationExportResult, AutomationStepResult, RollingPeriod } from "./types.js";

const execFileAsync = promisify(execFile);
export const AUTOMATION_RESULT_PREFIX = "AUTOMATION_RESULT_JSON=";
const LotsConfigSchema = z.object({
  keywords: z.array(z.string()).default([]), nstruCodes: z.array(z.string()).default([]), inputPath: z.string().optional(),
  statuses: z.array(z.string()).default([]), minAmount: z.number().nonnegative().optional(), excludeKeywords: z.array(z.string()).default([]),
  maxPages: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional(), headless: z.boolean().default(true), debugDir: z.string().optional(), pageLoadTimeoutMs: z.number().int().positive().optional()
});

export function createRealAutomationDependencies(): AutomationDependencies {
  return {
    exportPlans: exportPlansForPeriods,
    exportLots: exportLotsForPeriods,
    dryRunPlans: (input) => runTsx("scripts/bitrix-push-gz-deals.mts", ["--input", input]),
    dryRunLots: (input) => runTsx("scripts/bitrix-push-gz-lots.mts", ["--input", input, "--no-company"]),
    applyPlans: (input, limit) => runTsx("scripts/bitrix-push-gz-deals.mts", withLimit(["--input", input, "--execute"], limit)),
    applyLots: (input, limit) => runTsx("scripts/bitrix-push-gz-lots.mts", withLimit(["--input", input, "--execute"], limit)),
    analyzeLots: (input, limit) => runTsx("scripts/analyze-gz-specs.mts", withLimit(["--input", input, "--execute"], limit)),
    procurement: {
      collect: async (configPath, outputDir, years) => {
        const result = await runTsx("scripts/kz-export-procurement.mts",
          ["--config", configPath, "--output", outputDir, "--years", years.join(",")]);
        const payload = readAutomationResult(result.output ?? "", "scripts/kz-export-procurement.mts");
        return {
          counts: numberRecord(payload.counts),
          criticalErrors: stringArray(payload.criticalErrors),
          warnings: stringArray(payload.warnings),
          output: result.output,
          xlsxPath: requireString(payload.xlsxPath, "xlsxPath"),
          jsonPath: requireString(payload.jsonPath, "jsonPath")
        };
      },
      dryRun: (reportPath, outputPath) =>
        runProcurementPush(["--report", reportPath, "--output", outputPath]),
      apply: (reportPath, limit) =>
        runProcurementPush(withLimit(["--report", reportPath, "--execute"], limit))
    }
  };
}

async function runProcurementPush(args: string[]): Promise<AutomationStepResult> {
  const result = await runTsx("scripts/bitrix-push-procurement.mts", args);
  const payload = readAutomationResult(result.output ?? "", "scripts/bitrix-push-procurement.mts");
  return {
    counts: numberRecord(payload.counts),
    criticalErrors: stringArray(payload.criticalErrors),
    warnings: stringArray(payload.warnings),
    output: result.output
  };
}

/**
 * Читает единственную машинно-читаемую строку скрипта.
 *
 * Общий `parseCounts` скребёт стдаут регуляркой `слово=цифры` и на pretty-JSON даёт ложные
 * совпадения, поэтому пути и счётчики берём только отсюда.
 */
export function readAutomationResult(output: string, script: string): Record<string, unknown> {
  const line = output.split(/\r?\n/).reverse().find((row) => row.startsWith(AUTOMATION_RESULT_PREFIX));
  if (!line) throw new Error(`${script} did not emit ${AUTOMATION_RESULT_PREFIX}`);
  try {
    const parsed = JSON.parse(line.slice(AUTOMATION_RESULT_PREFIX.length)) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("payload is not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${script} emitted an unreadable ${AUTOMATION_RESULT_PREFIX}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => Number.isFinite(Number(item)))
    .map(([key, item]) => [key, Number(item)]));
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${AUTOMATION_RESULT_PREFIX} is missing ${field}`);
  return value;
}

async function exportPlansForPeriods(configPath: string, outputPath: string, periods: RollingPeriod[]): Promise<AutomationExportResult> {
  const base = loadGzPlansConfig(configPath);
  const parts: Array<{ path: string; rows: number }> = [];
  const cache = { cacheHit: 0, cacheMiss: 0, fetched: 0, fetchFailed: 0 };
  for (const period of periods) {
    const partPath = partName(outputPath, period.year);
    const options = mergeGzPlansExportOptions(base, { year: period.year, months: period.months, outPath: partPath });
    const result = await exportGzPlansReport({ ...options, token: process.env.GOSZAKUP_TOKEN ?? null });
    parts.push({ path: result.xlsxPath, rows: result.rows });
    cache.cacheHit += result.cacheStats.cacheHit; cache.cacheMiss += result.cacheStats.cacheMiss;
    cache.fetched += result.cacheStats.fetched; cache.fetchFailed += result.cacheStats.fetchFailed;
  }
  await mergeWorkbooks(parts.map((part) => part.path), outputPath); cleanupParts(parts.map((part) => part.path));
  return {
    path: outputPath,
    rows: parts.reduce((sum, part) => sum + part.rows, 0),
    cacheHit: cache.cacheHit, cacheMiss: cache.cacheMiss, fetched: cache.fetched, fetchFailed: cache.fetchFailed
  };
}

async function exportLotsForPeriods(configPath: string, outputPath: string, periods: RollingPeriod[]): Promise<AutomationExportResult> {
  const config = LotsConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
  const parts: Array<{ path: string; rows: number }> = [];
  for (const period of periods) {
    const partPath = partName(outputPath, period.year);
    const result = await exportGoszakupLotsByNstru({
      inputPath: config.inputPath, nstruCodes: config.nstruCodes.length ? config.nstruCodes : undefined, keywords: config.keywords,
      year: period.year, months: period.months, statusIds: resolveLotStatusIds(config.statuses), minAmount: config.minAmount,
      excludeKeywords: config.excludeKeywords, maxPages: config.maxPages, delayMs: config.delayMs, headless: config.headless, debugDir: config.debugDir,
      pageLoadTimeoutMs: config.pageLoadTimeoutMs, outPath: partPath
    });
    parts.push({ path: result.xlsxPath, rows: result.rows });
  }
  await mergeWorkbooks(parts.map((part) => part.path), outputPath); cleanupParts(parts.map((part) => part.path));
  return { path: outputPath, rows: parts.reduce((sum, part) => sum + part.rows, 0) };
}

async function mergeWorkbooks(inputs: string[], output: string): Promise<void> {
  if (!inputs.length) throw new Error("no workbooks to merge");
  const target = new ExcelJS.Workbook(); const sheet = target.addWorksheet("Data"); let first = true;
  for (const input of inputs) {
    const source = new ExcelJS.Workbook(); await source.xlsx.readFile(input); const sourceSheet = source.worksheets[0];
    if (!sourceSheet) throw new Error(`workbook has no worksheet: ${input}`);
    if (first) { sheet.columns = sourceSheet.columns.map((column) => ({ width: column.width })); first = false; }
    sourceSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1 && sheet.rowCount > 0) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : Object.values(row.values);
      sheet.addRow(values);
    });
  }
  fs.mkdirSync(path.dirname(output), { recursive: true }); await target.xlsx.writeFile(output);
}

async function runTsx(script: string, args: string[]): Promise<AutomationStepResult> {
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [tsxCli, path.resolve(script), ...args], { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024, env: process.env });
    const output = `${stdout}${stderr}`.trim(); return { counts: parseCounts(output), criticalErrors: [], output };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${script} failed: ${[detail.message, detail.stdout, detail.stderr].filter(Boolean).join("\n")}`);
  }
}

function parseCounts(output: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of output.matchAll(/\b([a-z][a-z0-9_]*)=(\d+)\b/gi)) counts[match[1]] = Number(match[2]);
  return counts;
}
function withLimit(args: string[], limit: number | null): string[] { return limit ? [...args, "--limit", String(limit)] : args; }
function partName(output: string, year: number): string { const parsed = path.parse(output); return path.join(parsed.dir, `${parsed.name}-${year}.part${parsed.ext}`); }
function cleanupParts(files: string[]): void { for (const file of files) if (fs.existsSync(file)) fs.rmSync(file, { force: true }); }
