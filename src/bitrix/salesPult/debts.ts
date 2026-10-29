/**
 * Classification of open CRM activities into "debts" for the sales pult.
 *
 * Kinds (checked in this order):
 *  1. passed  — the procurement of the deal is already over (status taken from the deal's
 *               UF_CRM_PLAN_STATUS); never a debt, the deal should be closed.
 *  2. new     — robot-created activity whose deadline equals its creation time (< 5 min):
 *               a deal that has not had its first contact yet.
 *  3. overdue — the deadline has passed (no upper age limit; the top list applies its own cap).
 *  4. today   — the deadline is today and has not come yet.
 */

import type { RawTask, TopTask } from "./metrics.js";
import { cleanFirstName } from "./format.js";

export type TodoKind = "passed" | "new" | "overdue" | "today";
export type TopTaskGroup = 1 | 2 | 3 | 4;

export const NEW_TODO_MAX_GAP_MS = 5 * 60_000;
export const NEW_TODO_PROBLEM_AGE_DAYS = 1;
export const DEFAULT_MAX_OVERDUE_DAYS = 30;
export const DEFAULT_DEBT_CATEGORIES = [9, 41, 43];
export const TOP_TASKS_PER_MANAGER = 5;
/** Activities of these providers are not "calls to make" and stay out of the debt logic. */
export const EXCLUDED_ACTIVITY_PROVIDERS = ["CRM_TASKS_TASK", "VOXIMPLANT_CALL"];

const PASSED_PURCHASE_STATUSES = [
  "Проект договора",
  "Договор действует",
  "Закупка состоялась",
  "Договор заключен",
  "Исполнен",
  "Отказ от закупки",
  "Отменен",
  "Договор изменен",
  "Договор частично исполнен",
  "Договор не исполнен. Нет платежей"
];
const ONGOING_PURCHASE_STATUSES = ["Опубликован", "Заявка", "Проект заявки"];

const ALMATY_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;
const MAX_AGE_LOOP_DAYS = 3650;

/** A candidate activity joined with the data of its deal. */
export type DebtCandidate = RawTask;

export interface ClassifiedTodo {
  candidate: DebtCandidate;
  kind: TodoKind;
  /** Calendar days (Almaty) between the deadline and today; only for overdue. */
  overdueDays: number;
  /** Elapsed working time since creation, in days; only for new. */
  ageDays: number;
}

export interface ManagerDebts {
  /** Overdue activities (all ages), excluding new and passed. */
  overdue: number;
  /** Subset of `overdue` older than the month threshold. */
  overdueOverMonth: number;
  /** Overdue activities on deals with an ongoing procurement. */
  overdueOngoing: number;
  /** Deals with a new activity and no first contact (any age). */
  newDeals: number;
  /** Deals whose first contact is more than one working day late. */
  newStaleDeals: number;
  /** Working-day age of the oldest new activity, whole days. */
  newOldestAgeDays: number;
  /** Deals whose procurement has passed but still have open activities. */
  readyToCloseDealIds: string[];
}

export interface DebtTopTask extends TopTask {
  kind: Exclude<TodoKind, "passed">;
  group: TopTaskGroup;
  overdueDays: number;
  ageDays: number;
}

export interface DebtContext {
  nowIso: string;
  holidays?: readonly string[];
  maxOverdueDays?: number;
  categories?: readonly number[];
}

export const EMPTY_DEBTS: ManagerDebts = {
  overdue: 0,
  overdueOverMonth: 0,
  overdueOngoing: 0,
  newDeals: 0,
  newStaleDeals: 0,
  newOldestAgeDays: 0,
  readyToCloseDealIds: []
};

/** Bitrix dates without an offset are in portal time (UTC+3). */
export function parseBitrixTime(value: string | null | undefined): number {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(text);
  const needsZone = !hasZone && /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(text);
  return Date.parse(needsZone ? `${text.replace(" ", "T")}+03:00` : text);
}

export function toAlmatyDay(ms: number): string {
  return new Date(ms + ALMATY_OFFSET_MS).toISOString().slice(0, 10);
}

export function isWorkday(day: string, holidays: readonly string[] = []): boolean {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.includes(day);
}

/**
 * Elapsed time in days counting only working days (Mon–Fri minus holidays): time that
 * falls on a weekend or a holiday is not counted.
 */
export function workingAgeDays(fromMs: number, toMs: number, holidays: readonly string[] = []): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let total = 0;
  let day = toAlmatyDay(fromMs);
  const lastDay = toAlmatyDay(toMs);
  for (let i = 0; i < MAX_AGE_LOOP_DAYS; i++) {
    if (isWorkday(day, holidays)) {
      const start = Date.parse(`${day}T00:00:00+05:00`);
      total += Math.max(0, Math.min(toMs, start + DAY_MS) - Math.max(fromMs, start));
    }
    if (day >= lastDay) break;
    day = toAlmatyDay(Date.parse(`${day}T12:00:00+05:00`) + DAY_MS);
  }
  return total / DAY_MS;
}

export function isPurchasePassed(planStatus: string | null | undefined): boolean {
  return includesStatus(PASSED_PURCHASE_STATUSES, planStatus);
}

export function isPurchaseOngoing(planStatus: string | null | undefined): boolean {
  return includesStatus(ONGOING_PURCHASE_STATUSES, planStatus);
}

function includesStatus(list: readonly string[], status: string | null | undefined): boolean {
  const normalized = normalize(status);
  return normalized !== "" && list.some((entry) => normalize(entry) === normalized);
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLocaleLowerCase("ru");
}

export function toPrepositional(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const first = cleanFirstName(trimmed);
  if (/ия$/i.test(first)) {
    return first.slice(0, -1) + "и";
  }
  if (/[ая]$/i.test(first)) {
    return first.slice(0, -1) + "е";
  }
  if (/[йь]$/i.test(first)) {
    return first.slice(0, -1) + "е";
  }
  if (/[бвгджзклмнпрстфхцчшщ]$/i.test(first)) {
    return first + "е";
  }
  return first;
}

export function formatResponsibleNote(name: string): string {
  const prep = toPrepositional(name);
  return `дело на ${prep}`;
}

export function isExcludedProvider(providerId: string | null | undefined): boolean {
  return EXCLUDED_ACTIVITY_PROVIDERS.includes(String(providerId ?? "").trim().toUpperCase());
}

export function isOpenDebtDeal(
  deal: {
    categoryId?: string | number | null;
    stageId?: string | null;
    closed?: string | boolean | null;
    stageSemanticId?: string | null;
  },
  categories: readonly number[] = DEFAULT_DEBT_CATEGORIES
): boolean {
  const allowed = new Set(categories.map(Number));
  const stage = String(deal.stageId ?? "");
  const stageCategory = stage.match(/^C(\d+):/i);
  const isAllowed =
    allowed.has(Number(deal.categoryId)) || (stageCategory !== null && allowed.has(Number(stageCategory[1])));
  if (!isAllowed) return false;

  if (deal.closed === true || deal.closed === "Y" || deal.closed === "1") {
    return false;
  }
  const semantic = String(deal.stageSemanticId ?? "").toUpperCase();
  if (semantic === "S" || semantic === "F") {
    return false;
  }

  const upper = stage.toUpperCase();
  const isClosed =
    upper.endsWith(":WON") ||
    upper === "WON" ||
    upper.endsWith(":LOSE") ||
    upper === "LOSE" ||
    upper.includes("APOLOGY");
  return !isClosed;
}

/** Returns null for activities outside the logic (no deadline, or a future day). */
export function classifyTodo(candidate: DebtCandidate, context: DebtContext): ClassifiedTodo | null {
  const nowMs = Date.parse(context.nowIso);
  const deadlineMs = parseBitrixTime(candidate.deadline);
  if (Number.isNaN(deadlineMs)) return null;

  const base = { candidate, overdueDays: 0, ageDays: 0 };
  if (isPurchasePassed(candidate.planStatus)) return { ...base, kind: "passed" };

  const createdMs = parseBitrixTime(candidate.created);
  if (!Number.isNaN(createdMs) && Math.abs(deadlineMs - createdMs) < NEW_TODO_MAX_GAP_MS) {
    return { ...base, kind: "new", ageDays: workingAgeDays(createdMs, nowMs, context.holidays) };
  }
  if (deadlineMs < nowMs) {
    const overdueDays = Math.round(
      (Date.parse(toAlmatyDay(nowMs)) - Date.parse(toAlmatyDay(deadlineMs))) / DAY_MS
    );
    return { ...base, kind: "overdue", overdueDays };
  }
  return toAlmatyDay(deadlineMs) === toAlmatyDay(nowMs) ? { ...base, kind: "today" } : null;
}

export function summarizeDebts(classified: readonly ClassifiedTodo[], context: DebtContext): ManagerDebts {
  const maxOverdueDays = context.maxOverdueDays ?? DEFAULT_MAX_OVERDUE_DAYS;
  const overdue = classified.filter((item) => item.kind === "overdue");
  const newTodos = classified.filter((item) => item.kind === "new");
  const dealIds = (items: readonly ClassifiedTodo[]) => [...new Set(items.map((item) => item.candidate.dealId))];

  return {
    overdue: overdue.length,
    overdueOverMonth: overdue.filter((item) => isOverMonth(item, context, maxOverdueDays)).length,
    overdueOngoing: overdue.filter((item) => isPurchaseOngoing(item.candidate.planStatus)).length,
    newDeals: dealIds(newTodos).length,
    newStaleDeals: dealIds(newTodos.filter((item) => item.ageDays > NEW_TODO_PROBLEM_AGE_DAYS)).length,
    newOldestAgeDays: Math.floor(Math.max(0, ...newTodos.map((item) => item.ageDays))),
    readyToCloseDealIds: dealIds(classified.filter((item) => item.kind === "passed"))
  };
}

function isOverMonth(item: ClassifiedTodo, context: DebtContext, maxOverdueDays: number): boolean {
  const deadlineMs = parseBitrixTime(item.candidate.deadline);
  return (Date.parse(context.nowIso) - deadlineMs) / DAY_MS > maxOverdueDays;
}

function topGroup(item: ClassifiedTodo, context: DebtContext, maxOverdueDays: number): TopTaskGroup | null {
  if (item.kind === "overdue") {
    if (isOverMonth(item, context, maxOverdueDays)) return null;
    return isPurchaseOngoing(item.candidate.planStatus) ? 1 : 2;
  }
  if (item.kind === "today") return 3;
  if (item.kind === "new" && item.ageDays > NEW_TODO_PROBLEM_AGE_DAYS) return 4;
  return null;
}

/**
 * "What to do today": at most 5 per manager, one activity per deal.
 * Order: 1) overdue on ongoing procurements, 2) other overdue up to the month cap,
 * 3) due today, 4) new without a first contact for more than one working day;
 * inside a group by deal amount. Passed procurements and month-old overdue stay out.
 */
export function rankDebtTopTasks(classified: readonly ClassifiedTodo[], context: DebtContext): DebtTopTask[] {
  const maxOverdueDays = context.maxOverdueDays ?? DEFAULT_MAX_OVERDUE_DAYS;
  const entries = classified.flatMap((item) => {
    const group = topGroup(item, context, maxOverdueDays);
    return group === null || item.kind === "passed" ? [] : [{ item, group }];
  });
  const byPriority = [...entries].sort(
    (a, b) => a.group - b.group || deadlineOf(a.item) - deadlineOf(b.item) || a.item.candidate.id.localeCompare(b.item.candidate.id)
  );
  const bestPerDeal = new Map<string, (typeof entries)[number]>();
  for (const entry of byPriority) {
    if (!bestPerDeal.has(entry.item.candidate.dealId)) bestPerDeal.set(entry.item.candidate.dealId, entry);
  }

  return [...bestPerDeal.values()]
    .sort(
      (a, b) =>
        a.group - b.group ||
        b.item.candidate.amount - a.item.candidate.amount ||
        deadlineOf(a.item) - deadlineOf(b.item) ||
        a.item.candidate.id.localeCompare(b.item.candidate.id)
    )
    .slice(0, TOP_TASKS_PER_MANAGER)
    .map(({ item, group }) => ({
      ...item.candidate,
      isOverdue: item.kind === "overdue",
      rank: group,
      kind: item.kind as DebtTopTask["kind"],
      group,
      overdueDays: item.overdueDays,
      ageDays: item.ageDays
    }));
}

function deadlineOf(item: ClassifiedTodo): number {
  return parseBitrixTime(item.candidate.deadline) || 0;
}

export function buildManagerDebts(
  candidates: readonly DebtCandidate[],
  context: DebtContext
): { debts: ManagerDebts; top: DebtTopTask[] } {
  const categories = context.categories ?? DEFAULT_DEBT_CATEGORIES;
  const classified = candidates
    .filter((candidate) => candidate.dealId && isOpenDebtDeal(candidate, categories))
    .flatMap((candidate) => {
      const result = classifyTodo(candidate, context);
      return result ? [result] : [];
    });
  return { debts: summarizeDebts(classified, context), top: rankDebtTopTasks(classified, context) };
}
