import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { collectExternalProcurement, markWarning } from "../src/kz/procurement/collector.js";
import { loadProcurementConfig } from "../src/kz/procurement/config.js";
import { enrichEligibleEpzCustomers } from "../src/kz/procurement/enrichment.js";
import { enrichEligibleEpzPlanDetails } from "../src/kz/procurement/planDetail.js";
import { classifyProcurementRecords } from "../src/kz/procurement/filter.js";
import { buildPlanPeriodWindow } from "../src/kz/procurement/planPeriod.js";
import { resolveEpzPlanYearIds } from "../src/kz/procurement/planYears.js";
import { fetchProcurementJson, withRetry } from "../src/kz/procurement/http.js";
import { applyGoszakupEnrichmentCandidates, type GoszakupEnrichmentCandidate } from "../src/kz/procurement/goszakupEnrichment.js";
import { ProcurementStorage } from "../src/kz/procurement/storage.js";
import { buildProcurementWorkbookModel } from "../src/kz/procurement/workbookModel.js";
import { writeProcurementWorkbook } from "../src/kz/procurement/workbookWriter.js";

const args = parseArgs(process.argv.slice(2));
const config = loadProcurementConfig(args.config);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.resolve(args.outputDirectory ?? config.outputDirectory);
const xlsxPath = path.join(outputDirectory, `procurement-${stamp}.xlsx`);
const jsonPath = path.join(outputDirectory, `procurement-${stamp}.json`);
const databasePath = path.resolve(config.databasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(outputDirectory, { recursive: true });

const now = new Date();
const planPeriodWindow = buildPlanPeriodWindow(now, config.rollingMonths);
const targetYears = args.years ?? planPeriodWindow.years;
const fetchJson = (url: string) => withRetry(() => fetchProcurementJson(url), { maxAttempts: 4, delayMs: 500 });

const planYears = await resolveEpzPlanYearIds(targetYears, {
  fetchJson, overrides: config.planYearIds, probeRange: config.planYearProbeRange
});
const availableStatuses = config.planStatuses.filter((status) => status.id !== null);
if (!availableStatuses.length) throw new Error("no plan status from config resolves to an EPZ status id");

const collection = await collectExternalProcurement({
  keywords: config.keywords,
  planYears: planYears.resolved,
  planStatusIds: availableStatuses.map((status) => status.id as number),
  pageSize: args.pageSize ?? config.pageSize,
  maxPages: args.maxPages ?? config.maxPages,
  delayMs: args.delayMs ?? config.delayMs,
  now
});
applyPlanYearResolution(collection.completeness, planYears, targetYears);
applyUnavailableStatuses(collection.completeness, config.planStatuses);

const collectedRecords = collection.records.filter((record) => config.sources.includes(record.source));
const filterOptions = { minAmount: config.minAmount, pkTruPrefixes: config.pkTruPrefixes,
  panelKeywords: config.panelKeywords, stopWords: config.stopWords,
  planStatuses: config.planStatuses.map((status) => status.name), planPeriodWindow };
const classificationBeforeDetail = classifyProcurementRecords(collectedRecords, filterOptions);
const detailEnriched = await enrichEligibleEpzPlanDetails(collectedRecords, {
  completeness: collection.completeness, filter: filterOptions, concurrency: config.detailConcurrency
});
const epzEnriched = await enrichEligibleEpzCustomers(detailEnriched.records, { filter: filterOptions });
const records = applyGoszakupEnrichmentCandidates(epzEnriched,
  config.goszakupRegistryDatabasePath ? loadGoszakupCandidates(path.resolve(config.goszakupRegistryDatabasePath)) : []);
collection.completeness.monthUnknown = records
  .filter((record) => record.recordKind === "plan" && record.planMonth === null).length;

const database = new Database(databasePath);
try {
  const storage = new ProcurementStorage({ db: database });
  for (const record of records) storage.upsert(record);
} finally {
  database.close();
}

const classification = classifyProcurementRecords(records, filterOptions);
const beforeBuckets = classificationBuckets(classificationBeforeDetail);
const afterBuckets = classificationBuckets(classification);
collection.completeness.detailPromotedToData = [...afterBuckets.entries()]
  .filter(([key, bucket]) => bucket === "data" && beforeBuckets.get(key) === "review").length;
collection.completeness.detailRejectedAfterDetail = [...afterBuckets.entries()]
  .filter(([key, bucket]) => bucket === "rejected" && ["data", "review"].includes(beforeBuckets.get(key) ?? "")).length;
const model = buildProcurementWorkbookModel(classification, collection.completeness);
await writeProcurementWorkbook(xlsxPath, model);
fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), config: args.config,
  summary: model.summary, collection: collection.completeness, classification }, null, 2), "utf8");

console.log(JSON.stringify({ mode: "xlsx-only", recordsCollected: records.length, ...model.summary,
  collection: collection.completeness, xlsxPath, jsonPath, databasePath }, null, 2));

// Единственная машинно-читаемая строка для оркестратора: пути и счётчики не выскребаются из pretty JSON.
console.log(`AUTOMATION_RESULT_JSON=${JSON.stringify({
  stage: "f3-collect",
  xlsxPath, jsonPath,
  counts: {
    collected: records.length, data: model.summary.data, review: model.summary.review,
    rejected: model.summary.rejected, yearConflicts: collection.completeness.yearConflicts ?? 0,
    monthUnknown: collection.completeness.monthUnknown ?? 0, pagesFetched: collection.completeness.pagesFetched
  },
  planYears: collection.completeness.planYears,
  complete: collection.completeness.complete,
  criticalErrors: collection.completeness.complete ? [] : collection.completeness.incompleteReasons,
  warnings: collection.completeness.warnings
})}`);

interface ExportArgs {
  config: string;
  outputDirectory?: string;
  maxPages?: number;
  pageSize?: number;
  delayMs?: number;
  years?: number[];
}

/**
 * Переносит результат резолвинга годов в отчёт о полноте сбора.
 *
 * Сбой пробы блокирует: из него не следует, что года нет. Опровергнутый конфигом id блокирует тоже.
 * Ненайденный будущий год — предупреждение: в EPZ он открывается не сразу.
 */
function applyPlanYearResolution(
  completeness: Parameters<typeof markWarning>[0],
  resolution: Awaited<ReturnType<typeof resolveEpzPlanYearIds>>,
  targetYears: number[]
): void {
  for (const error of resolution.probeErrors) {
    completeness.complete = false;
    completeness.incompleteReasons.push(error);
  }
  for (const conflict of resolution.conflicts) {
    completeness.complete = false;
    completeness.incompleteReasons.push(conflict);
  }
  completeness.unresolvedFutureYears = resolution.unresolvedFutureYears;
  const currentYear = new Date().getFullYear();
  for (const year of resolution.unresolvedFutureYears) {
    if (year <= currentYear && !resolution.probeErrors.length) {
      completeness.complete = false;
      completeness.incompleteReasons.push(`plan-year:${year}:unresolved_current_year`);
    } else {
      markWarning(completeness, `plan-year:${year}:not_open_yet`);
    }
  }
  if (!resolution.resolved.length) {
    completeness.complete = false;
    completeness.incompleteReasons.push(`plan-year:none_resolved_for:${targetYears.join(",")}`);
  }
}

/** Статус, заявленный в конфиге, но отсутствующий в источнике: видно в каждом отчёте, но не блокирует. */
function applyUnavailableStatuses(
  completeness: Parameters<typeof markWarning>[0],
  planStatuses: Array<{ name: string; id: number | null }>
): void {
  const unavailable = planStatuses.filter((status) => status.id === null).map((status) => status.name);
  completeness.unavailablePlanStatuses = unavailable;
  for (const name of unavailable) markWarning(completeness, `plan-status:${name}:unavailable`);
}

function parseArgs(argv: string[]): ExportArgs {
  const result: ExportArgs = { config: "config/procurement-sources.json" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--config" && value) { result.config = value; index++; }
    else if (arg === "--output" && value) { result.outputDirectory = value; index++; }
    else if (arg === "--max-pages" && value) { result.maxPages = positive(value, arg); index++; }
    else if (arg === "--page-size" && value) { result.pageSize = positive(value, arg); index++; }
    else if (arg === "--delay-ms" && value) { result.delayMs = nonnegative(value, arg); index++; }
    else if (arg === "--years" && value) { result.years = value.split(",").map((year) => positive(year.trim(), arg)); index++; }
    else if (arg === "--help") {
      console.log("tsx scripts/kz-export-procurement.mts [--config path] [--output dir] [--years 2026,2027] [--max-pages n] [--page-size n] [--delay-ms n]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return result;
}
function positive(value: string, name: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`); return parsed; }
function nonnegative(value: string, name: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`); return parsed; }

function loadGoszakupCandidates(databasePath: string): GoszakupEnrichmentCandidate[] {
  if (!fs.existsSync(databasePath)) return [];
  const registry = new Database(databasePath, { readonly: true });
  try {
    const table = registry.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goszakup_registry_data'").get();
    if (!table) return [];
    return registry.prepare(`SELECT name_ru AS customerName, bin, website, email, phone,
      reporting_administrator AS reportingAdministrator,
      COALESCE(full_address_ru, legal_address, location_address) AS legalAddress,
      director_name AS directorName
      FROM goszakup_registry_data WHERE bin IS NOT NULL`)
      .all() as GoszakupEnrichmentCandidate[];
  } finally {
    registry.close();
  }
}

function classificationBuckets(value: ReturnType<typeof classifyProcurementRecords>): Map<string, "data" | "review" | "rejected"> {
  const result = new Map<string, "data" | "review" | "rejected">();
  for (const bucket of ["data", "review", "rejected"] as const) {
    for (const item of value[bucket]) result.set(`${item.record.source}:${item.record.recordKind}:${item.record.externalId}`, bucket);
  }
  return result;
}
