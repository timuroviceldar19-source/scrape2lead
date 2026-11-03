import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { z } from "zod";
import { exportGoszakupLotsByNstru, readNstruCodes, resolveLotStatusIds } from "../kz/goszakupLotsNstruExporter.js";
import { exportGzPlansReport } from "../kz/gzPlanExporter.js";
import { loadGzPlansConfig, mergeGzPlansExportOptions } from "../kz/gzPlansConfig.js";
import { collectionErrorMessage, GzSourceUnavailableError, isTransientNetworkError, type GzCollectionReport, type GzSkippedQuery } from "../kz/gzCollection.js";
import type { PlanDetailCacheStats } from "../kz/goszakupPlanTypes.js";
import type { AutomationDependencies, AutomationExportResult, AutomationStepResult, RollingPeriod } from "./types.js";

const execFileAsync = promisify(execFile);
export const AUTOMATION_RESULT_PREFIX = "AUTOMATION_RESULT_JSON=";
const LotsConfigSchema = z.object({
  keywords: z.array(z.string()).default([]), nstruCodes: z.array(z.string()).default([]), inputPath: z.string().optional(),
  statuses: z.array(z.string()).default([]), minAmount: z.number().nonnegative().optional(), excludeKeywords: z.array(z.string()).default([]),
  maxPages: z.number().int().positive().optional(),
  maxConsecutiveNetworkFailures: z.number().int().positive().default(3),
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
      dryRun: (reportPath, outputPath, configPath) =>
        runProcurementPush(procurementDryRunArgs(reportPath, outputPath, configPath)),
      apply: (reportPath, limit, configPath) =>
        runProcurementPush(procurementApplyArgs(reportPath, limit, configPath))
    }
  };
}

export function procurementDryRunArgs(reportPath: string, outputPath: string, configPath: string): string[] {
  return ["--report", reportPath, "--output", outputPath, "--config", configPath];
}

export function procurementApplyArgs(reportPath: string, limit: number | null, configPath: string): string[] {
  return withLimit(["--report", reportPath, "--execute", "--config", configPath], limit);
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
  return exportPeriods("plans", outputPath, periods, base.keywords, async (period, partPath) => {
    const options = mergeGzPlansExportOptions(base, { year: period.year, months: period.months, outPath: partPath });
    return exportGzPlansReport({ ...options, partialCollection: true, token: process.env.GOSZAKUP_TOKEN ?? null });
  });
}

async function exportLotsForPeriods(configPath: string, outputPath: string, periods: RollingPeriod[]): Promise<AutomationExportResult> {
  const config = LotsConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
  const nstruCodes = config.nstruCodes.length || config.keywords.length ? config.nstruCodes : readNstruCodes(config.inputPath);
  return exportPeriods("lots", outputPath, periods, [...nstruCodes, ...config.keywords], async (period, partPath) => {
    return exportGoszakupLotsByNstru({
      inputPath: config.inputPath, nstruCodes: nstruCodes.length ? nstruCodes : undefined, keywords: config.keywords,
      year: period.year, months: period.months, statusIds: resolveLotStatusIds(config.statuses), minAmount: config.minAmount,
      excludeKeywords: config.excludeKeywords, maxPages: config.maxPages, delayMs: config.delayMs, headless: config.headless, debugDir: config.debugDir,
      pageLoadTimeoutMs: config.pageLoadTimeoutMs, outPath: partPath, partialCollection: true,
      maxConsecutiveNetworkFailures: config.maxConsecutiveNetworkFailures
    });
  });
}

interface PeriodExport extends GzCollectionReport { xlsxPath: string; rows: number; cacheStats?: PlanDetailCacheStats }

/** Каждый завершённый период сразу попадает в итоговый XLSX и отчёт; более поздний сбой его не удаляет. */
async function exportPeriods(
  source: "plans" | "lots", outputPath: string, periods: RollingPeriod[], queries: string[],
  collect: (period: RollingPeriod, partPath: string) => Promise<PeriodExport>
): Promise<AutomationExportResult> {
  const parts: PeriodExport[] = [];
  const skippedQueries: GzSkippedQuery[] = [];
  let successfulQueries = 0;
  const cache = { cacheHit: 0, cacheMiss: 0, fetched: 0, fetchFailed: 0 };
  for (const period of periods) {
    let result: PeriodExport | undefined;
    try {
      result = await collect(period, partName(outputPath, period.year));
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;
      if (error instanceof GzSourceUnavailableError) skippedQueries.push(...error.skippedQueries);
      else for (const query of queries.length ? queries : ["весь период"]) {
        skippedQueries.push({ stage: source, query, ...period, failedPage: 1, totalPages: null, keptRows: 0,
          attempts: 0, reason: `period aborted: ${collectionErrorMessage(error)}` });
      }
    }
    if (result) {
      parts.push(result);
      successfulQueries += result.successfulQueries ?? 1;
      skippedQueries.push(...(result.skippedQueries ?? []));
      if (result.cacheStats) for (const key of Object.keys(cache) as Array<keyof typeof cache>) cache[key] += result.cacheStats[key];
      await mergeWorkbooks(parts.map(part => part.xlsxPath), outputPath);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const reportPath = `${outputPath}.collection.json`;
    fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify({ successfulQueries, skippedQueries }, null, 2) + "\n");
    fs.renameSync(`${reportPath}.tmp`, reportPath);
  }
  if (!successfulQueries && skippedQueries.length) {
    cleanupParts(periods.map(period => partName(outputPath, period.year)));
    fs.rmSync(outputPath, { force: true });
    throw new GzSourceUnavailableError(skippedQueries);
  }
  if (!parts.length) throw new Error("no periods to export");
  cleanupParts(parts.map(part => part.xlsxPath));
  return { path: outputPath, rows: parts.reduce((sum, part) => sum + part.rows, 0), successfulQueries, skippedQueries,
    ...(source === "plans" ? cache : {}) };
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
