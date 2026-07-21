import { parseEpzLot, parseEpzPlan } from "./epz.js";
import { parseTizilimTender } from "./tizilim.js";
import type { ProcurementRecord } from "./types.js";

const EPZ_API = "https://zakup.gov.kz/api/core/api/public";
const TIZILIM_API = "https://public.tizilim.gov.kz/api/public/tenders";
const ACTIVE_TIZILIM_STATUSES = new Set(["опубликован", "опубликовано торги", "published", "published trades"]);

export interface ProcurementCollectorOptions {
  keywords: string[];
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  now?: Date;
  fetchJson?: (url: string) => Promise<unknown>;
}

export async function collectExternalProcurement(options: ProcurementCollectorOptions): Promise<ProcurementRecord[]> {
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 5;
  const fetchJson = options.fetchJson ?? fetchJsonWithRetry;
  const now = options.now ?? new Date();
  const collectedAt = now.toISOString();
  const records = new Map<string, ProcurementRecord>();

  for (const keyword of uniqueKeywords(options.keywords)) {
    await collectEpzKind("plan-items", keyword, pageSize, maxPages, fetchJson, options.delayMs ?? 0, (raw) => {
      const record = parseEpzPlan(raw, collectedAt);
      if (record) records.set(key(record), record);
    });
    await collectEpzKind("lots", keyword, pageSize, maxPages, fetchJson, options.delayMs ?? 0, (raw) => {
      const record = parseEpzLot(raw, collectedAt);
      if (record && isActivePublished(record, now)) records.set(key(record), record);
    });
    await collectTizilim(keyword, pageSize, maxPages, fetchJson, options.delayMs ?? 0, (raw) => {
      const record = parseTizilimTender(raw, collectedAt);
      if (isActivePublished(record, now)) records.set(key(record), record);
    });
  }
  return [...records.values()];
}

async function collectEpzKind(
  kind: "plan-items" | "lots",
  keyword: string,
  pageSize: number,
  maxPages: number,
  fetchJson: (url: string) => Promise<unknown>,
  delayMs: number,
  onRow: (row: unknown) => void
): Promise<void> {
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      limit: String(pageSize), offset: String(page * pageSize), q: keyword, system_id__in: "2__3"
    });
    const payload = object(await fetchJson(`${EPZ_API}/${kind}/?${params.toString()}`));
    const rows = Array.isArray(payload.results) ? payload.results : [];
    for (const row of rows) onRow(row);
    if (rows.length < pageSize) break;
    if (delayMs) await wait(delayMs);
  }
}

async function collectTizilim(
  keyword: string,
  pageSize: number,
  maxPages: number,
  fetchJson: (url: string) => Promise<unknown>,
  delayMs: number,
  onRow: (row: unknown) => void
): Promise<void> {
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ page: String(page), per_page: String(pageSize), search: keyword,
      start_date: "", end_date: "", category: "default" });
    const payload = object(await fetchJson(`${TIZILIM_API}?${params.toString()}`));
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) onRow(row);
    const meta = object(payload.meta);
    const lastPage = Number(meta.last_page || page);
    if (rows.length < pageSize || page >= lastPage) break;
    if (delayMs) await wait(delayMs);
  }
}

function isActivePublished(record: ProcurementRecord, now: Date): boolean {
  const status = (record.status ?? "").normalize("NFKC").toLocaleLowerCase("ru").trim();
  if (!ACTIVE_TIZILIM_STATUSES.has(status)) return false;
  if (!record.endDate) return true;
  const normalizedDate = record.endDate.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(normalizedDate);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() >= now.getTime();
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "scrape2lead/1.7" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 3) await wait(500 * 2 ** attempt);
    }
  }
  throw new Error(`procurement request failed for ${url}: ${lastError?.message ?? "unknown error"}`);
}

function key(record: ProcurementRecord): string { return `${record.source}:${record.recordKind}:${record.externalId}`; }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
function uniqueKeywords(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
