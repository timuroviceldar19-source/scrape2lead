/**
 * Пункты планов госзакупок (ЭГЗ, system_id=1) из открытого API zakup.gov.kz.
 *
 * С 13.11.2026 публичный реестр планов procurement.gov.kz не пополняется: самый новый пункт
 * там 88654473, а zakup.gov.kz отдаёт пункты тех же номеров дальше. Сборщик возвращает то же,
 * что `collectGzPlans`, поэтому выгрузка, реестр заказчиков и запись в Bitrix не меняются.
 *
 * Чего в zakup нет: номера исходного пункта (`root`) у изменённых пунктов. Поэтому «№ пункта
 * плана» здесь равен номеру самого пункта, а связь новой версии со старой сделкой проверяет
 * запись в Bitrix (`src/bitrix/gzZakupRevisionLink.ts`).
 */
import { isValidBin } from "./csv.js";
import { prefilterPlanListItems } from "./goszakupPlanCollector.js";
import { matchesPlanStatus } from "./goszakupPlanHtmlParser.js";
import type {
  GoszakupPlanDetail,
  GoszakupPlanListItem,
  GzPlanCollectOptions,
  GzPlanCollectResult
} from "./goszakupPlanTypes.js";
import { DEFAULT_GZ_PLAN_KEYWORDS } from "./goszakupPlanTypes.js";
import { collectionErrorMessage, GzCollectionState, type GzSkippedQuery } from "./gzCollection.js";
import { resolvePlanStatusNames } from "./gzPlansConfig.js";
import {
  mapWithConcurrency,
  zakupGet,
  zakupListAll,
  ZakupRecordNotFoundError,
  type ZakupApiOptions
} from "./zakupPublicApi.js";

export const ZAKUP_PLAN_PAGE_URL = "https://zakup.gov.kz/plan-items";
const GZ_SYSTEM_ID = "1";
const DETAIL_CONCURRENCY = 4;

export interface ZakupGzPlanCollectOptions extends GzPlanCollectOptions {
  zakup?: ZakupApiOptions;
}

interface ZakupPlanListRow {
  id: number;
  external_id: string | number;
  month_id?: number | null;
  month_name?: string | null;
  status_name?: string | null;
  count?: number | null;
  organization_id?: number | null;
  unit_price?: number | null;
  total_price?: number | null;
  purchase_method_name?: string | null;
  organization_name?: string | null;
  enstru?: { name_ru?: string | null } | null;
}

interface ZakupPlanDetail {
  id: number;
  external_id: number | string;
  name_ru?: string | null;
  description_ru?: string | null;
  extra_description_ru?: string | null;
  organization?: { iin_bin?: string | null; name_ru?: string | null; name?: string | null } | null;
  enstru?: { code?: string | null; name_ru?: string | null; short_description_ru?: string | null } | null;
  measure?: { name_ru?: string | null; name?: string | null } | null;
  plan?: { act_date?: string | null; act_number?: string | null } | null;
  delivery_address?: unknown;
  deliveries?: Array<{ kato_full_name_ru?: string | null; kato_full_name?: string | null }> | null;
  budget_planning_admin?: unknown;
}

interface YearRow { id: number; year: number }

type CollectedItem = GoszakupPlanListItem & { detail: GoszakupPlanDetail | null };

export async function collectGzPlansFromZakup(options: ZakupGzPlanCollectOptions = {}): Promise<GzPlanCollectResult> {
  const keywords = options.keywords ?? [...DEFAULT_GZ_PLAN_KEYWORDS];
  const year = options.year ?? 2026;
  const months = options.months ?? [6, 7, 8];
  const allowedStatusNames = resolvePlanStatusNames(options.statuses ?? []);
  const api = options.zakup ?? {};
  const collection = options.partialCollection ? new GzCollectionState(options.maxConsecutiveNetworkFailures) : undefined;
  const queryContext = (query: string) => ({ stage: "plans" as const, query, year, months });
  const attempts = (api.maxRetries ?? 4) + 1;

  let planYearId: number | null;
  try {
    planYearId = await resolvePlanYearId(year, api);
  } catch (error) {
    if (!collection) throw error;
    for (const keyword of keywords) collection.fail(queryContext(keyword), 1, null, 0, attempts, error);
    return { items: [], ...collection.report(), cacheStats: emptyStats() };
  }
  if (planYearId === null) {
    // Года ещё нет в справочнике zakup — значит, и пунктов на этот год нет. Это пустая выдача, не сбой.
    console.log(`zakup plan search: year ${year} is not in the zakup dictionary yet, no plan items`);
    for (const _keyword of keywords) collection?.complete();
    return { items: [], successfulQueries: collection ? collection.successfulQueries : keywords.length,
      skippedQueries: [], cacheStats: emptyStats() };
  }

  // Номер пункта → записи zakup и последнее ключевое слово, которым он найден (как в сборщике портала).
  const points = new Map<string, { keyword: string; rows: Map<number, ZakupPlanListRow> }>();
  for (const keyword of keywords) {
    if (collection?.skipIfOpen(queryContext(keyword))) continue;
    options.onProgress?.(`search: ${keyword}`);
    let rows: ZakupPlanListRow[];
    try {
      rows = await zakupListAll<ZakupPlanListRow>("/public/plan-items/", {
        q: keyword, system_id__in: GZ_SYSTEM_ID, plan_year_id: planYearId, month_id__in: months.join("__")
      }, api);
    } catch (error) {
      if (!collection) throw error;
      collection.fail(queryContext(keyword), 1, null, 0, attempts, error);
      continue;
    }
    collection?.complete();
    let kept = 0;
    for (const row of rows) {
      const externalId = String(row.external_id ?? "").trim();
      if (!/^\d+$/.test(externalId) || !Number.isSafeInteger(row.id)) continue;
      if (options.minPlanPointId && Number(externalId) < options.minPlanPointId) continue;
      if (row.month_id != null && !months.includes(Number(row.month_id))) continue;
      const point = points.get(externalId) ?? { keyword, rows: new Map<number, ZakupPlanListRow>() };
      point.keyword = keyword;
      point.rows.set(row.id, row);
      points.set(externalId, point);
      kept++;
    }
    console.log(`zakup plan search: keyword="${keyword}" rows=${rows.length} points=${kept}`);
  }

  const listItems: Array<GoszakupPlanListItem & { zakupId: number; organizationId: number | null }> = [];
  let conflicting = 0;
  for (const [externalId, point] of points) {
    const records = [...point.rows.values()];
    if (!records.every((row) => matchesPlanStatus(row.status_name ?? null, allowedStatusNames))) {
      // Одна запись «Утвержден», другая уже «Проект договора»: какая из них текущая, zakup не говорит.
      if (records.some((row) => matchesPlanStatus(row.status_name ?? null, allowedStatusNames))) conflicting++;
      continue;
    }
    const row = records.sort((a, b) => b.id - a.id)[0];
    listItems.push({ ...toListItem(externalId, row, point.keyword), zakupId: row.id, organizationId: row.organization_id ?? null });
  }
  if (conflicting > 0) console.log(`zakup plan search: dropped ${conflicting} points with conflicting zakup statuses`);

  const detailItems = options.prefilterDetails
    ? prefilterPlanListItems(listItems, options.minAmount ?? 0, options.excludeKeywords ?? []).items as typeof listItems
    : listItems;
  if (options.prefilterDetails) {
    console.log(`zakup plan prefilter: prefiltered=${listItems.length - detailItems.length} total=${listItems.length}`);
  }

  const detailSkips: GzSkippedQuery[] = [];
  const stats = { cacheHit: 0, cacheMiss: detailItems.length, fetched: 0, fetchFailed: 0 };
  let superseded = 0;
  const collected = await mapWithConcurrency(detailItems, DETAIL_CONCURRENCY, async ({ zakupId, organizationId, ...item }): Promise<CollectedItem | null> => {
    let detail: ZakupPlanDetail;
    try {
      // Поиск по номеру пункта возвращает и его более поздние версии: старая версия остаётся «Утвержден»,
      // но сделку по ней заводить или править нельзя (18.11.2026: 80758527 → 88607772).
      if (await hasLaterVersion(item.plan_point_id, organizationId, api)) {
        superseded++;
        return null;
      }
      detail = await zakupGet<ZakupPlanDetail>(`/public/plan-items/${zakupId}/`, {}, api);
    } catch (error) {
      stats.fetchFailed++;
      if (error instanceof ZakupRecordNotFoundError) {
        console.warn(`zakup plan: point ${item.plan_point_id} disappeared from zakup, skipped`);
        return null;
      }
      if (!collection) throw error;
      detailSkips.push({ ...queryContext(item.keyword), failedPage: null, totalPages: null, keptRows: 0, attempts,
        reason: `detail: ${collectionErrorMessage(error)}`, planPointIds: [item.plan_point_id] });
      return null;
    }
    const bin = String(detail.organization?.iin_bin ?? "").trim();
    if (String(detail.external_id) !== item.plan_point_id || !isValidBin(bin)) {
      stats.fetchFailed++;
      console.warn(`zakup plan: point ${item.plan_point_id} has an inconsistent detail card, skipped`);
      return null;
    }
    stats.fetched++;
    const unit = text(detail.measure?.name_ru) ?? text(detail.measure?.name);
    return { ...item, unit: unit ?? item.unit, detail: toPlanDetail(item.plan_point_id, bin, detail) };
  });

  if (superseded > 0) console.log(`zakup plan search: dropped ${superseded} points that already have a later version`);
  const report = collection ? collection.report() : { successfulQueries: keywords.length, skippedQueries: [] };
  return {
    items: collected.filter((item): item is CollectedItem => item !== null),
    successfulQueries: report.successfulQueries,
    skippedQueries: [...report.skippedQueries, ...detailSkips],
    cacheStats: stats
  };
}

async function hasLaterVersion(planPointId: string, organizationId: number | null, api: ZakupApiOptions): Promise<boolean> {
  const rows = await zakupListAll<ZakupPlanListRow>("/public/plan-items/", { q: planPointId, system_id: GZ_SYSTEM_ID }, api);
  return rows.some((row) => {
    const other = String(row.external_id ?? "").trim();
    if (!/^\d+$/.test(other) || Number(other) <= Number(planPointId)) return false;
    return organizationId === null || row.organization_id == null || Number(row.organization_id) === organizationId;
  });
}

async function resolvePlanYearId(year: number, api: ZakupApiOptions): Promise<number | null> {
  const dictionary = await zakupGet<YearRow[]>("/dicts/years/", {}, api);
  if (!Array.isArray(dictionary)) throw new Error("zakup: неверный справочник лет");
  return dictionary.find((row) => Number(row.year) === year)?.id ?? null;
}

function toListItem(externalId: string, row: ZakupPlanListRow, keyword: string): GoszakupPlanListItem {
  return {
    plan_point_id: externalId,
    // zakup не отдаёт номер исходного пункта у изменённых пунктов, см. комментарий в начале файла.
    plan_list_number: externalId,
    customer_name: text(row.organization_name),
    customer_url: null,
    item_name: text(row.enstru?.name_ru),
    method: text(row.purchase_method_name),
    unit: null,
    quantity: formatQuantity(row.count),
    unit_price: formatMoney(row.unit_price),
    planned_amount: formatMoney(row.total_price),
    planned_month: text(row.month_name),
    status: text(row.status_name),
    detail_url: `${ZAKUP_PLAN_PAGE_URL}/${row.id}`,
    keyword
  };
}

function toPlanDetail(planPointId: string, bin: string, detail: ZakupPlanDetail): GoszakupPlanDetail {
  const addresses = [
    text(detail.delivery_address),
    ...(detail.deliveries ?? []).map((delivery) => text(delivery.kato_full_name_ru) ?? text(delivery.kato_full_name))
  ].filter((value): value is string => Boolean(value));
  return {
    plan_point_id: planPointId,
    customer_bin: bin,
    customer_name: text(detail.organization?.name_ru) ?? text(detail.organization?.name),
    name_ru: text(detail.name_ru) ?? text(detail.enstru?.name_ru),
    ref_enstru_code: text(detail.enstru?.code),
    desc_ru: text(detail.description_ru) ?? text(detail.enstru?.short_description_ru),
    extra_desc_ru: text(detail.extra_description_ru),
    date_approved: text(detail.plan?.act_date),
    ref_abp_code: null,
    abp_name: adminName(detail.budget_planning_admin),
    delivery_address: [...new Set(addresses)].join("; ") || null,
    plan_act_number: text(detail.plan?.act_number)
  };
}

function adminName(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  if (value && typeof value === "object") {
    const admin = value as { name_ru?: unknown; full_name_ru?: unknown; name?: unknown };
    return text(admin.name_ru) ?? text(admin.full_name_ru) ?? text(admin.name);
  }
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function formatQuantity(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return String(Number(value));
}

/** Как на портале: «1 050 000.00». Запись в Bitrix разбирает суммы с пробелами. */
function formatMoney(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const [whole, fraction] = Number(value).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${fraction}`;
}

function emptyStats() {
  return { cacheHit: 0, cacheMiss: 0, fetched: 0, fetchFailed: 0 };
}
