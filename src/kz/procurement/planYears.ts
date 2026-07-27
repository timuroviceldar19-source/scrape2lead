import { isNotFound, type ProcurementJsonFetcher } from "./http.js";
import type { EpzPlanYear } from "./types.js";

const EPZ_PLAN_ITEMS = "https://zakup.gov.kz/api/core/api/public/plan-items";
const DEFAULT_PROBE_RANGE: readonly [number, number] = [1, 32];
const DEFAULT_SAMPLE_SIZE = 5;
const APPROVED_STATUS_ID = 2;

export interface PlanYearResolution {
  resolved: EpzPlanYear[];
  /** Запрошенные годы, которым не нашлось `plan_year_id` при исправных пробах. */
  unresolvedFutureYears: number[];
  /** Override из конфига, опровергнутый пробой источника. Блокирует production. */
  conflicts: string[];
  /** Сетевые и серверные сбои проб. Блокируют сбор: «года нет» из них не следует. */
  probeErrors: string[];
}

export interface PlanYearResolverOptions {
  fetchJson: ProcurementJsonFetcher;
  /** Подсказки из конфига вида `{"2026": 12}`. Проверяются, а не принимаются на веру. */
  overrides?: Record<string, number>;
  probeRange?: readonly [number, number];
  sampleSize?: number;
}

/**
 * Сопоставляет календарные годы с `plan_year_id` EPZ.
 *
 * Справочник не линеен (id 11 не используется), поэтому арифметика по id запрещена:
 * единственный достоверный источник — поле `year.year` в карточке позиции.
 */
export async function resolveEpzPlanYearIds(
  targetYears: number[],
  options: PlanYearResolverOptions
): Promise<PlanYearResolution> {
  const wanted = [...new Set(targetYears)].sort((a, b) => a - b);
  const resolution: PlanYearResolution = { resolved: [], unresolvedFutureYears: [], conflicts: [], probeErrors: [] };
  const sampleSize = Math.max(1, options.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  const [from, to] = options.probeRange ?? DEFAULT_PROBE_RANGE;
  const found = new Map<number, number>();

  for (const candidate of candidateIds(wanted, options.overrides, from, to)) {
    if (found.size === wanted.length) break;
    let year: number | null;
    try {
      year = await probePlanYear(candidate, sampleSize, options.fetchJson);
    } catch (error) {
      resolution.probeErrors.push(`plan-year:${candidate}:${message(error)}`);
      continue;
    }
    if (year !== null && wanted.includes(year) && !found.has(year)) found.set(year, candidate);
  }

  for (const [key, id] of Object.entries(options.overrides ?? {})) {
    const year = Number(key);
    if (!wanted.includes(year)) continue;
    const probed = found.get(year);
    if (probed !== undefined && probed !== id) {
      resolution.conflicts.push(`plan-year:${year}:override_${id}_resolved_${probed}`);
    }
  }

  for (const year of wanted) {
    const id = found.get(year);
    if (id === undefined) resolution.unresolvedFutureYears.push(year);
    else resolution.resolved.push({ year, planYearId: id });
  }
  return resolution;
}

/**
 * Возвращает календарный год, к которому относится `plan_year_id`, или null, если id не используется.
 *
 * Часть карточек отдаётся пустым телом или 404 — это не сбой, поэтому пробуем несколько записей,
 * прежде чем признать id непригодным.
 */
async function probePlanYear(
  planYearId: number,
  sampleSize: number,
  fetchJson: ProcurementJsonFetcher
): Promise<number | null> {
  const params = new URLSearchParams({
    limit: String(sampleSize), offset: "0", system_id__in: "2__3",
    status_id__in: String(APPROVED_STATUS_ID), plan_year_id: String(planYearId)
  });
  const listing = object(await fetchJson(`${EPZ_PLAN_ITEMS}/?${params.toString()}`));
  const rows = Array.isArray(listing.results) ? listing.results : [];
  if (!rows.length) return null;

  for (const row of rows) {
    const id = object(row).id;
    if (id === null || id === undefined) continue;
    let detail: Record<string, unknown>;
    try {
      detail = object(await fetchJson(`${EPZ_PLAN_ITEMS}/${encodeURIComponent(String(id))}/`));
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    const year = Number(object(detail.year).year);
    if (Number.isFinite(year)) return year;
  }
  return null;
}

/** Сначала подсказки из конфига, затем остальной диапазон — так типовой прогон стоит несколько запросов. */
function candidateIds(
  wanted: number[],
  overrides: Record<string, number> | undefined,
  from: number,
  to: number
): number[] {
  const hinted = wanted
    .map((year) => overrides?.[String(year)])
    .filter((id): id is number => Number.isInteger(id));
  const rest: number[] = [];
  for (let id = to; id >= from; id--) if (!hinted.includes(id)) rest.push(id);
  return [...new Set([...hinted, ...rest])];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
