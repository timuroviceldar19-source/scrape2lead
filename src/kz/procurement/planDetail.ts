import { sourceFromSystem } from "./epz.js";
import { isPlanDetailCandidate, type ProcurementFilterOptions } from "./filter.js";
import type {
  ProcurementCollectionCompleteness,
  ProcurementDelivery,
  ProcurementPlanDetail,
  ProcurementRecord,
  ProcurementSource
} from "./types.js";

const EPZ_PLAN_ITEMS = "https://zakup.gov.kz/api/core/api/public/plan-items";
const EPZ_PLAN_PAGE = "https://zakup.gov.kz/plan-items";

export interface ParsedEpzPlanDetail extends ProcurementPlanDetail {
  sourceRecordId: string;
  externalId: string;
  source: ProcurementSource;
  status: string | null;
  customerSourceId: string | null;
  customerName: string | null;
  customerBin: string | null;
  truCode: string | null;
  amount: number;
  purchaseMethod: string | null;
}

export interface PlanDetailEnrichmentOptions {
  fetchJson?: (url: string) => Promise<unknown>;
  completeness: ProcurementCollectionCompleteness;
  filter?: ProcurementFilterOptions;
  concurrency?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export async function enrichEligibleEpzPlanDetails(
  records: ProcurementRecord[],
  options: PlanDetailEnrichmentOptions
): Promise<{ records: ProcurementRecord[] }> {
  const candidates = records.filter((record) => isPlanDetailCandidate(record, options.filter) && record.sourceRecordId?.trim());
  const groups = new Map<string, ProcurementRecord[]>();
  for (const record of candidates) {
    const key = `${record.source}:${record.sourceRecordId}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const completeness = options.completeness;
  completeness.detailRequested = groups.size;
  completeness.detailSucceeded = 0;
  completeness.detailFailed = 0;
  completeness.detailIdentityMismatches = 0;

  const results = new Map<string, ParsedEpzPlanDetail | "failed">();
  const fetchJson = options.fetchJson ?? fetchDetailJson;
  const entries = [...groups.entries()];
  await mapConcurrent(entries, Math.max(1, options.concurrency ?? 6), async ([key, grouped]) => {
    const id = grouped[0]?.sourceRecordId as string;
    try {
      const raw = await withRetry(
        () => fetchJson(`${EPZ_PLAN_ITEMS}/${encodeURIComponent(id)}/`),
        options.maxAttempts ?? 4,
        options.retryDelayMs ?? 250
      );
      const parsed = parseEpzPlanDetail(raw);
      if (!parsed || parsed.sourceRecordId !== id || grouped.some((record) => parsed.source !== record.source || parsed.externalId !== record.externalId)) {
        results.set(key, parsed ?? "failed");
        completeness.detailIdentityMismatches = (completeness.detailIdentityMismatches ?? 0) + 1;
        markIncomplete(completeness, `plan-detail:${id}:identity_mismatch`);
        return;
      }
      results.set(key, parsed);
      completeness.detailSucceeded = (completeness.detailSucceeded ?? 0) + 1;
    } catch {
      results.set(key, "failed");
      completeness.detailFailed = (completeness.detailFailed ?? 0) + 1;
      markIncomplete(completeness, `plan-detail:${id}:fetch_failed`);
    }
  });

  return { records: records.map((record) => {
    if (!isPlanDetailCandidate(record, options.filter) || !record.sourceRecordId?.trim()) return record;
    const detail = results.get(`${record.source}:${record.sourceRecordId}`);
    if (detail === "failed") return { ...record, detailIssue: completeness.incompleteReasons.includes(
      `plan-detail:${record.sourceRecordId}:identity_mismatch`) ? "detail_identity_mismatch" : "detail_fetch_failed" };
    if (!detail || detail.source !== record.source || detail.externalId !== record.externalId) {
      return { ...record, detailIssue: "detail_identity_mismatch" };
    }
    return mergeDetail(record, detail);
  }) };
}

export function parseEpzPlanDetail(input: unknown): ParsedEpzPlanDetail | null {
  const row = object(input);
  const source = sourceFromSystem(object(row.system).id);
  const sourceRecordId = nullableText(row.id);
  const externalId = nullableText(row.external_id);
  if (!source || !sourceRecordId || !externalId) return null;
  const organization = object(row.organization);
  const enstru = object(row.enstru);
  const measure = object(row.measure);
  const timestamp = finiteNumber(row.timestamp);
  const approved = timestamp === null ? null : new Date(timestamp * 1000);
  const approvedAt = approved && !Number.isNaN(approved.getTime()) ? approved.toISOString().slice(0, 10) : null;
  const deliveries = Array.isArray(row.deliveries) ? row.deliveries.map(parseDelivery) : [];
  return {
    sourceRecordId,
    externalId,
    source,
    status: nullableText(object(row.status).name),
    customerSourceId: nullableText(organization.id),
    customerName: nullableText(organization.name ?? organization.name_ru),
    customerBin: normalizeBin(organization.iin_bin),
    truCode: nullableText(enstru.code),
    amount: finiteNumber(row.total_price) ?? 0,
    purchaseMethod: nullableText(object(row.purchase_method).name),
    approvedAt,
    financialYear: approvedAt ? Number(approvedAt.slice(0, 4)) : null,
    nameRu: nullableText(enstru.name_ru ?? enstru.name),
    nameKk: nullableText(enstru.name_kk),
    shortDescriptionRu: nullableText(enstru.short_description_ru ?? enstru.short_description),
    shortDescriptionKk: nullableText(enstru.short_description_kk),
    extraDescription: nullableText(row.extra_description),
    unitName: nullableText(measure.name),
    quantity: finiteNumber(row.count),
    unitPrice: finiteNumber(row.unit_price),
    prepaymentPercent: finiteNumber(row.prepayment),
    deliveryDeadline: nullableText(row.delivery_deadline_ru ?? row.delivery_deadline),
    itemType: nullableText(object(enstru.purchase_item_type).name ?? object(row.purchase_subject).name),
    deliveries
  };
}

function mergeDetail(record: ProcurementRecord, detail: ParsedEpzPlanDetail): ProcurementRecord {
  const planDetail: ProcurementPlanDetail = {
    approvedAt: detail.approvedAt,
    financialYear: detail.financialYear,
    nameRu: detail.nameRu,
    nameKk: detail.nameKk,
    shortDescriptionRu: detail.shortDescriptionRu,
    shortDescriptionKk: detail.shortDescriptionKk,
    extraDescription: detail.extraDescription,
    unitName: detail.unitName,
    quantity: detail.quantity,
    unitPrice: detail.unitPrice,
    prepaymentPercent: detail.prepaymentPercent,
    deliveryDeadline: detail.deliveryDeadline,
    itemType: detail.itemType,
    deliveries: detail.deliveries
  };
  return {
    ...record,
    status: detail.status ?? record.status,
    productName: detail.nameRu ?? record.productName,
    description: detail.extraDescription ?? detail.shortDescriptionRu ?? record.description,
    truCode: detail.truCode,
    customerSourceId: detail.customerSourceId ?? record.customerSourceId,
    customerName: detail.customerName ?? record.customerName,
    customerBin: detail.customerBin,
    amount: detail.amount,
    purchaseMethod: detail.purchaseMethod ?? record.purchaseMethod,
    url: `${EPZ_PLAN_PAGE}/${encodeURIComponent(detail.sourceRecordId)}`,
    planDetail,
    detailIssue: null,
    enrichment: { source: "epz-plan-detail", confidence: "exact" }
  };
}

function parseDelivery(input: unknown): ProcurementDelivery {
  const row = object(input);
  const kato = object(row.kato);
  return {
    address: nullableText(row.full_delivery_place_name ?? row.additional_delivery_place_name
      ?? kato.full_name_ru ?? kato.full_name ?? kato.name_ru ?? kato.name),
    kato: nullableText(kato.code),
    quantity: finiteNumber(row.count)
  };
}

async function withRetry<T>(action: () => Promise<T>, maxAttempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    try { return await action(); } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && delayMs > 0) await wait(delayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function fetchDetailJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "scrape2lead/1.7" } });
  if (!response.ok) throw new Error(`Plan detail enrichment failed: HTTP ${response.status}`);
  return await response.json();
}

async function mapConcurrent<T>(values: T[], concurrency: number, action: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await action(values[index] as T);
    }
  }));
}

function markIncomplete(completeness: ProcurementCollectionCompleteness, reason: string): void {
  completeness.complete = false;
  if (!completeness.incompleteReasons.includes(reason)) completeness.incompleteReasons.push(reason);
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
function nullableText(value: unknown): string | null { const result = value === null || value === undefined ? "" : String(value).trim(); return result || null; }
function finiteNumber(value: unknown): number | null { if (value === null || value === undefined || value === "") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function normalizeBin(value: unknown): string | null { const digits = nullableText(value)?.replace(/\D/g, "") ?? ""; return digits.length === 12 ? digits : null; }
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
