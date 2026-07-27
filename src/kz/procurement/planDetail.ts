import { sourceFromSystem } from "./epz.js";
import { isPlanDetailCandidate, type ProcurementFilterOptions } from "./filter.js";
import { fetchProcurementJson, isNotFound, withRetry, type ProcurementJsonFetcher } from "./http.js";
import type {
  ProcurementCollectionCompleteness,
  ProcurementDelivery,
  ProcurementDetailIssue,
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
  fetchJson?: ProcurementJsonFetcher;
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
  completeness.detailEmpty = 0;
  completeness.detailIdentityMismatches = 0;
  completeness.yearConflicts = completeness.yearConflicts ?? 0;

  const results = new Map<string, DetailOutcome>();
  const fetchJson = options.fetchJson ?? fetchProcurementJson;
  const entries = [...groups.entries()];
  await mapConcurrent(entries, Math.max(1, options.concurrency ?? 6), async ([key, grouped]) => {
    const id = grouped[0]?.sourceRecordId as string;
    let raw: unknown;
    try {
      raw = await withRetry(() => fetchJson(`${EPZ_PLAN_ITEMS}/${encodeURIComponent(id)}/`), {
        maxAttempts: options.maxAttempts ?? 4,
        delayMs: options.retryDelayMs ?? 250
      });
    } catch (error) {
      // 404 — источник отвечает «нет такой записи»; это не сбой сбора и не требует повторов.
      if (isNotFound(error)) {
        results.set(key, { kind: "issue", issue: "detail_empty" });
        completeness.detailEmpty = (completeness.detailEmpty ?? 0) + 1;
        return;
      }
      results.set(key, { kind: "issue", issue: "detail_fetch_failed" });
      completeness.detailFailed = (completeness.detailFailed ?? 0) + 1;
      markIncomplete(completeness, `plan-detail:${id}:fetch_failed`);
      return;
    }

    const parsed = parseEpzPlanDetail(raw);
    if (!parsed) {
      // EPZ отдаёт `{}` на часть идентификаторов: тело валидное, записи нет.
      results.set(key, { kind: "issue", issue: "detail_empty" });
      completeness.detailEmpty = (completeness.detailEmpty ?? 0) + 1;
      return;
    }
    if (parsed.sourceRecordId !== id
      || grouped.some((record) => parsed.source !== record.source || parsed.externalId !== record.externalId)) {
      results.set(key, { kind: "issue", issue: "detail_identity_mismatch" });
      completeness.detailIdentityMismatches = (completeness.detailIdentityMismatches ?? 0) + 1;
      markIncomplete(completeness, `plan-detail:${id}:identity_mismatch`);
      return;
    }

    const expectedYear = grouped.find((record) => record.collectionPlanYear !== null)?.collectionPlanYear ?? null;
    if (expectedYear !== null && parsed.financialYear !== null && parsed.financialYear !== expectedYear) {
      results.set(key, { kind: "issue", issue: "plan_year_conflict" });
      completeness.yearConflicts = (completeness.yearConflicts ?? 0) + 1;
      markIncomplete(completeness, `plan-detail:${id}:plan_year_conflict:${expectedYear}!=${parsed.financialYear}`);
      return;
    }

    results.set(key, { kind: "ok", detail: parsed });
    completeness.detailSucceeded = (completeness.detailSucceeded ?? 0) + 1;
  });

  return { records: records.map((record) => {
    if (!isPlanDetailCandidate(record, options.filter) || !record.sourceRecordId?.trim()) return record;
    const outcome = results.get(`${record.source}:${record.sourceRecordId}`);
    if (!outcome) return { ...record, detailIssue: "detail_fetch_failed" };
    if (outcome.kind === "issue") return { ...record, detailIssue: outcome.issue };
    return mergeDetail(record, outcome.detail);
  }) };
}

type DetailOutcome =
  | { kind: "ok"; detail: ParsedEpzPlanDetail }
  | { kind: "issue"; issue: ProcurementDetailIssue };

export function parseEpzPlanDetail(input: unknown): ParsedEpzPlanDetail | null {
  const row = object(input);
  const source = sourceFromSystem(object(row.system).id);
  const sourceRecordId = nullableText(row.id);
  const externalId = nullableText(row.external_id);
  if (!source || !sourceRecordId || !externalId) return null;
  const organization = object(row.organization);
  const enstru = object(row.enstru);
  const measure = object(row.measure);
  const year = object(row.year);
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
    // `row.timestamp` — общий штамп загрузки: позиции разных лет несут одно и то же значение,
    // поэтому ни год, ни дата утверждения из него не выводятся.
    approvedAt: normalizeIsoDate(row.decree_date),
    financialYear: finiteNumber(year.year),
    planYearId: finiteNumber(year.id),
    planMonth: finiteNumber(object(row.month).id ?? row.month_id),
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
    planYearId: detail.planYearId,
    planMonth: detail.planMonth,
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
    planYear: detail.financialYear,
    planMonth: detail.planMonth,
    planYearId: detail.planYearId,
    approvedAt: detail.approvedAt,
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
function normalizeIsoDate(value: unknown): string | null {
  const text = nullableText(value);
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dotted = /^(\d{2})[.-](\d{2})[.-](\d{4})$/.exec(text);
  return dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : text;
}
