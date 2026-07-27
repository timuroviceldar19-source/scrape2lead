import { computeRollingPeriod } from "../../automation/core.js";
import type { ProcurementRecord } from "./types.js";

/**
 * Поля периода плана для записей, у которых его нет: тендеры EPZ и всё, что приходит из Tizilim.
 * Держим одной константой, чтобы форма записи не расползалась по парсерам и тестам.
 */
export const EMPTY_PLAN_PERIOD = {
  planYear: null,
  planMonth: null,
  planYearId: null,
  approvedAt: null,
  collectionPlanYear: null,
  collectionPlanYearId: null
} as const satisfies Pick<
  ProcurementRecord,
  "planYear" | "planMonth" | "planYearId" | "approvedAt" | "collectionPlanYear" | "collectionPlanYearId"
>;

export interface PlanPeriodWindow {
  /** Календарные годы, попадающие в окно. */
  years: number[];
  /** Разрешённые пары год-месяц в виде `YYYY-M`. */
  yearMonths: Set<string>;
}

export type PlanPeriodVerdict =
  | { status: "ok"; monthKnown: boolean }
  | { status: "year_conflict"; expected: number; actual: number }
  | { status: "year_outside_window"; actual: number }
  | { status: "period_outside_window"; year: number; month: number };

/** Окно «текущий месяц плюс следующие N-1» поверх той же логики, что используют GZ-процессы. */
export function buildPlanPeriodWindow(now: Date, months: number): PlanPeriodWindow {
  const periods = computeRollingPeriod(now, months);
  const yearMonths = new Set<string>();
  for (const period of periods) {
    for (const month of period.months) yearMonths.add(`${period.year}-${month}`);
  }
  return { years: periods.map((period) => period.year), yearMonths };
}

/**
 * Сверяет период записи с окном сбора.
 *
 * Месяц EPZ отдаёт далеко не всегда, поэтому его отсутствие — не причина отбраковки:
 * запись принимается, а неизвестный месяц отмечается отдельным счётчиком.
 */
export function evaluatePlanPeriod(record: ProcurementRecord, window: PlanPeriodWindow): PlanPeriodVerdict {
  if (record.recordKind !== "plan") return { status: "ok", monthKnown: true };

  const expected = record.collectionPlanYear;
  const actual = record.planYear;
  if (expected !== null && actual !== null && expected !== actual) {
    return { status: "year_conflict", expected, actual };
  }
  if (actual !== null && !window.years.includes(actual)) {
    return { status: "year_outside_window", actual };
  }
  if (actual !== null && record.planMonth !== null && !window.yearMonths.has(`${actual}-${record.planMonth}`)) {
    return { status: "period_outside_window", year: actual, month: record.planMonth };
  }
  return { status: "ok", monthKnown: record.planMonth !== null };
}
