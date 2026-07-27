import { EMPTY_PLAN_PERIOD } from "./planPeriod.js";
import type { EpzPlanYear, ProcurementRecord, ProcurementSource } from "./types.js";

const EPZ_HOME = "https://zakup.gov.kz/home";

export function parseEpzPlan(
  input: unknown,
  collectedAt = new Date().toISOString(),
  queriedYear: EpzPlanYear | null = null
): ProcurementRecord | null {
  const row = object(input);
  const source = sourceFromSystem(row.system_id);
  if (!source) return null;
  const externalId = text(row.external_id);
  const enstru = object(row.enstru);
  const planYearId = firstNumber(row.plan_year_id);
  return {
    source, recordKind: "plan", sourceRecordId: nullableText(row.id), externalId, parentExternalId: null,
    status: nullableText(row.status_name), productName: text(enstru.name_ru ?? enstru.name_text_ru),
    description: text(row.extra_description), truCode: nullableText(enstru.code ?? enstru.key ?? row.enstru_key),
    customerSourceId: nullableText(row.organization_id), customerName: nullableText(row.organization_name), customerBin: normalizeBin(row.organization_bin ?? row.customer_bin),
    amount: number(row.total_price), currency: "KZT",
    planYearId,
    // Год берём из запроса только когда строка подтверждает тот же `plan_year_id`;
    // иначе оставляем null, чтобы решение принял detail и сработала сверка конфликта.
    planYear: queriedYear && planYearId === queriedYear.planYearId ? queriedYear.year : null,
    planMonth: firstNumber(row.month_id),
    approvedAt: null,
    collectionPlanYear: queriedYear?.year ?? null,
    collectionPlanYearId: queriedYear?.planYearId ?? null,
    startDate: null, endDate: null,
    url: epzSearchUrl("plan-items", externalId, row.system_id),
    purchaseMethod: nullableText(row.purchase_method_name), collectedAt
  };
}

export function parseEpzLot(input: unknown, collectedAt = new Date().toISOString()): ProcurementRecord | null {
  const row = object(input);
  const system = object(row.system);
  const source = sourceFromSystem(system.id ?? row.system_id);
  if (!source) return null;
  const externalId = text(row.external_id || row.lot_number || row.id);
  const planItems = Array.isArray(row.plan_items) ? row.plan_items : [];
  const firstPlan = object(planItems[0]);
  const enstrus = Array.isArray(row.enstrus) ? row.enstrus : [];
  const firstEnstru = object(enstrus[0]);
  return {
    source, recordKind: "tender", sourceRecordId: nullableText(row.id), announcementSourceId: nullableText(row.announcement_id), externalId,
    parentExternalId: nullableText(firstPlan.external_id ?? firstPlan.id),
    status: nullableText(row.status_name ?? object(row.status).name),
    productName: text(row.name_ru ?? firstEnstru.name_ru),
    description: text(row.description_ru ?? firstEnstru.short_description_ru),
    truCode: nullableText(row.enstru_key ?? firstEnstru.code),
    customerSourceId: nullableText(row.organization_id), customerName: nullableText(row.organization_name), customerBin: normalizeBin(row.organization_bin ?? row.customer_bin),
    amount: number(row.total_price), currency: "KZT",
    ...EMPTY_PLAN_PERIOD, planYearId: firstNumber(row.plan_year_id),
    startDate: nullableText(row.offer_start_date ?? row.announcement_publish_date), endDate: nullableText(row.offer_end_date),
    url: epzSearchUrl("lots", text(row.lot_number ?? externalId), system.id ?? row.system_id),
    purchaseMethod: nullableText(row.purchase_method_name), collectedAt
  };
}

export function sourceFromSystem(value: unknown): ProcurementSource | null {
  if (Number(value) === 2) return "mitwork";
  if (Number(value) === 3) return "samruk";
  return null;
}

function epzSearchUrl(kind: "plan-items" | "lots", query: string, systemId: unknown): string {
  if (!query) return "";
  const params = new URLSearchParams({ q: query, system_id__in: String(Number(systemId)) });
  return `${EPZ_HOME}/${kind}?${params.toString()}`;
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return value === null || value === undefined ? "" : String(value).trim(); }
function nullableText(value: unknown): string | null { return text(value) || null; }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function normalizeBin(value: unknown): string | null { const digits = text(value).replace(/\D/g, ""); return digits.length === 12 ? digits : null; }
/** `plan_year_id` приходит массивом (`[12]`), `month_id` — скаляром. Берём первое пригодное число. */
function firstNumber(value: unknown): number | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === null || candidate === undefined || candidate === "") return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}
