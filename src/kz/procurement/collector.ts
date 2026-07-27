import { parseEpzLot, parseEpzPlan } from "./epz.js";
import { fetchProcurementJson, withRetry, type ProcurementJsonFetcher } from "./http.js";
import { parseTizilimTender } from "./tizilim.js";
import type { EpzPlanYear, ProcurementCollectionCompleteness, ProcurementRecord } from "./types.js";

const EPZ_API = "https://zakup.gov.kz/api/core/api/public";
const TIZILIM_API = "https://public.tizilim.gov.kz/api/public/tenders";
const ACTIVE_TENDER_STATUSES = new Set(["опубликован", "опубликовано торги", "published", "published trades"]);
const DEFAULT_PLAN_STATUS_IDS = [2];

export interface ProcurementCollectorOptions {
  keywords: string[];
  /** Годы плана, под которые ведётся сбор, с их `plan_year_id` из справочника EPZ. */
  planYears: EpzPlanYear[];
  planStatusIds?: number[];
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  now?: Date;
  fetchJson?: ProcurementJsonFetcher;
}

export interface ProcurementCollectionResult {
  records: ProcurementRecord[];
  completeness: ProcurementCollectionCompleteness;
}

export async function collectExternalProcurement(options: ProcurementCollectorOptions): Promise<ProcurementCollectionResult> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 500;
  const planYears = options.planYears;
  const planStatusIds = options.planStatusIds?.length ? options.planStatusIds : DEFAULT_PLAN_STATUS_IDS;
  const fetchJson = options.fetchJson ?? fetchJsonWithRetry;
  const now = options.now ?? new Date();
  const collectedAt = now.toISOString();
  const records = new Map<string, ProcurementRecord>();
  const completeness: ProcurementCollectionCompleteness = {
    complete: true, planYears, pageLimit: maxPages, pagesFetched: 0, incompleteReasons: [], warnings: []
  };

  for (const keyword of uniqueKeywords(options.keywords)) {
    for (const planYear of planYears) {
      await safelyCollect(`plan-items:${planYear.year}`, keyword, completeness, async () => collectEpzKind({
        kind: "plan-items", keyword, pageSize, maxPages, planYear, planStatusIds, now, fetchJson,
        delayMs: options.delayMs ?? 0, completeness, onRow: (raw) => {
          const record = parseEpzPlan(raw, collectedAt, planYear);
          if (record) records.set(key(record), record);
        }
      }));
    }
    await safelyCollect("lots", keyword, completeness, async () => collectEpzKind({
      kind: "lots", keyword, pageSize, maxPages, planYear: null, planStatusIds, now, fetchJson,
      delayMs: options.delayMs ?? 0, completeness, onRow: (raw) => {
        const record = parseEpzLot(raw, collectedAt);
        if (record && isActivePublished(record, now)) records.set(key(record), record);
      }
    }));
    await safelyCollect("tizilim", keyword, completeness, async () => collectTizilim({
      keyword, pageSize, maxPages, now, fetchJson, delayMs: options.delayMs ?? 0, completeness,
      onRow: (raw) => {
        const record = parseTizilimTender(raw, collectedAt);
        if (isActivePublished(record, now)) records.set(key(record), record);
      }
    }));
  }
  return { records: [...records.values()], completeness };
}

interface EpzCollectionOptions {
  kind: "plan-items" | "lots";
  keyword: string;
  pageSize: number;
  maxPages: number;
  /** Год плана для `plan-items`; для лотов не применяется — они отбираются по дедлайну. */
  planYear: EpzPlanYear | null;
  planStatusIds: number[];
  now: Date;
  fetchJson: ProcurementJsonFetcher;
  delayMs: number;
  completeness: ProcurementCollectionCompleteness;
  onRow: (row: unknown) => void;
}

async function collectEpzKind(options: EpzCollectionOptions): Promise<void> {
  for (let page = 0; page < options.maxPages; page++) {
    const params = new URLSearchParams({
      limit: String(options.pageSize), offset: String(page * options.pageSize), q: options.keyword,
      system_id__in: "2__3"
    });
    if (options.kind === "plan-items") {
      if (options.planYear) params.set("plan_year_id", String(options.planYear.planYearId));
      params.set("status_id__in", options.planStatusIds.join("__"));
    } else {
      params.set("status_id__in", "6");
      params.set("offer_end_date__gte", options.now.toISOString());
    }
    const payload = object(await options.fetchJson(`${EPZ_API}/${options.kind}/?${params.toString()}`));
    options.completeness.pagesFetched += 1;
    const rows = Array.isArray(payload.results) ? payload.results : [];
    for (const row of rows) options.onRow(row);
    if (!payload.next) return;
    if (page + 1 >= options.maxPages) {
      markIncomplete(options.completeness, `${options.kind}:${options.keyword}:page_limit`);
      return;
    }
    if (options.delayMs) await wait(options.delayMs);
  }
}

interface TizilimCollectionOptions {
  keyword: string;
  pageSize: number;
  maxPages: number;
  now: Date;
  fetchJson: ProcurementJsonFetcher;
  delayMs: number;
  completeness: ProcurementCollectionCompleteness;
  onRow: (row: unknown) => void;
}

async function collectTizilim(options: TizilimCollectionOptions): Promise<void> {
  for (let page = 1; page <= options.maxPages; page++) {
    const params = new URLSearchParams({ page: String(page), per_page: String(options.pageSize), search: options.keyword,
      start_date: "", end_date: "", category: "default" });
    const payload = object(await options.fetchJson(`${TIZILIM_API}?${params.toString()}`));
    options.completeness.pagesFetched += 1;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) options.onRow(row);
    const meta = object(payload.meta);
    const lastPage = Number(meta.last_page || page);
    if (page >= lastPage) return;
    if (page >= options.maxPages) {
      markIncomplete(options.completeness, `tizilim:${options.keyword}:page_limit`);
      return;
    }
    if (options.delayMs) await wait(options.delayMs);
  }
}

async function safelyCollect(
  kind: string,
  keyword: string,
  completeness: ProcurementCollectionCompleteness,
  collect: () => Promise<void>
): Promise<void> {
  try {
    await collect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markIncomplete(completeness, `${kind}:${keyword}:fetch_failed:${message}`);
  }
}

function markIncomplete(completeness: ProcurementCollectionCompleteness, reason: string): void {
  completeness.complete = false;
  if (!completeness.incompleteReasons.includes(reason)) completeness.incompleteReasons.push(reason);
}

/** Наблюдение, не ставящее под сомнение полноту сбора: видно в отчёте, но не блокирует production. */
export function markWarning(completeness: ProcurementCollectionCompleteness, warning: string): void {
  if (!completeness.warnings.includes(warning)) completeness.warnings.push(warning);
}

function isActivePublished(record: ProcurementRecord, now: Date): boolean {
  const status = normalize(record.status ?? "");
  if (!ACTIVE_TENDER_STATUSES.has(status)) return false;
  if (!record.endDate) return true;
  const normalizedDate = record.endDate.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(normalizedDate);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() >= now.getTime();
}

function fetchJsonWithRetry(url: string): Promise<unknown> {
  return withRetry(() => fetchProcurementJson(url), { maxAttempts: 4, delayMs: 500 });
}

function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/g, " ").trim(); }
function key(record: ProcurementRecord): string { return `${record.source}:${record.recordKind}:${record.externalId}`; }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
function uniqueKeywords(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
