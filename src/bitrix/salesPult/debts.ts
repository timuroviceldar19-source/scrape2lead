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

import type { GzDealOutcome } from "../gzDealOutcome.js";
import type { RawTask, TopTask } from "./metrics.js";
import { cleanFirstName } from "./format.js";

export type TodoKind = "passed" | "new" | "overdue" | "today";
export type TopTaskGroup = 1 | 2 | 3 | 4;
export type GzDealOutcomeKind = GzDealOutcome["kind"];

export const NEW_TODO_MAX_GAP_MS = 5 * 60_000;
export const NEW_TODO_PROBLEM_AGE_DAYS = 1;
export const DEFAULT_MAX_OVERDUE_DAYS = 30;
export const DEFAULT_DEBT_CATEGORIES = [9, 41, 43];
export const TOP_TASKS_PER_MANAGER = 5;
export const CONTACTED_AFTER_DEADLINE_NOTE = "связался — закрыть дело / поставить следующий шаг";
/** Activities of these providers are not "calls to make" and stay out of the debt logic. */
export const EXCLUDED_ACTIVITY_PROVIDERS = ["CRM_TASKS_TASK", "VOXIMPLANT_CALL"];

const PASSED_OUTCOME_BY_KIND: Record<GzDealOutcomeKind, boolean> = {
  lost: true,
  failed: true,
  cancelled: true,
  repurposed: true,
  terminated: true,
  won: false,
  partner: false,
  published: false,
  "contract-draft": false,
  "plan-renumbered": false,
  "plan-moved": false
};

const PLAN_MONTH_NUMBERS: Record<string, { num: number; label: string }> = {
  январь: { num: 1, label: "январь" },
  февраль: { num: 2, label: "февраль" },
  март: { num: 3, label: "март" },
  апрель: { num: 4, label: "апрель" },
  май: { num: 5, label: "май" },
  июнь: { num: 6, label: "июнь" },
  июль: { num: 7, label: "июль" },
  август: { num: 8, label: "август" },
  сентябрь: { num: 9, label: "сентябрь" },
  октябрь: { num: 10, label: "октябрь" },
  ноябрь: { num: 11, label: "ноябрь" },
  декабрь: { num: 12, label: "декабрь" }
};

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

export interface OverdueOverMonthTask {
  id?: string;
  dealId: string;
  title: string;
  overdueDays: number;
  amount: number;
  currency?: string;
  deadline: string;
  subject?: string;
  planNumber?: string | null;
}

export interface ManagerDebts {
  /** Overdue activities (all ages), excluding new and passed. */
  overdue: number;
  /** Subset of `overdue` older than the month threshold. */
  overdueOverMonth: number;
  /** Overdue activities older than the month threshold for display under «30+ дней». */
  overdueOverMonthTasks?: OverdueOverMonthTask[];
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
  /** Deals won on portal (won: or partner:) but not closed in CRM. */
  wonOnPortalNotClosed?: number;
}

export interface DebtTopTask extends TopTask {
  kind: Exclude<TodoKind, "passed">;
  group: TopTaskGroup;
  overdueDays: number;
  ageDays: number;
  passedPlanMonthNote?: string | null;
  contactedAfterDeadlineNote?: string | null;
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
  overdueOverMonthTasks: [],
  overdueOngoing: 0,
  newDeals: 0,
  newStaleDeals: 0,
  newOldestAgeDays: 0,
  readyToCloseDealIds: [],
  wonOnPortalNotClosed: 0
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

export function isOutcomePassed(outcome: string | null | undefined): boolean {
  if (!outcome) return false;
  const kind = outcome.trim().split(":")[0].toLowerCase() as GzDealOutcomeKind;
  return PASSED_OUTCOME_BY_KIND[kind] === true;
}

export function getPassedPlanMonthNote(
  planStatus: string | null | undefined,
  planMonth: string | null | undefined,
  nowIso: string
): string | null {
  const normStatus = normalize(planStatus).replace(/ё/g, "е");
  if (normStatus !== "утвержден") return null;
  const normMonth = normalize(planMonth);
  if (!normMonth) return null;
  const entry = PLAN_MONTH_NUMBERS[normMonth];
  if (!entry) return null;
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) return null;
  const todayDay = toAlmatyDay(nowMs);
  const currentMonth = parseInt(todayDay.slice(5, 7), 10);
  if (!Number.isFinite(currentMonth) || currentMonth < 1 || currentMonth > 12) return null;
  const isPassed = currentMonth === 1 ? entry.num === 12 : entry.num < currentMonth;
  return isPassed ? `план на ${entry.label} прошёл` : null;
}

export function getContactedAfterDeadlineNote(item: ClassifiedTodo): string | null {
  if (item.kind !== "overdue") return null;
  const c = item.candidate;
  if (c.hasContactAfterDeadline === true) return CONTACTED_AFTER_DEADLINE_NOTE;
  const deadlineMs = parseBitrixTime(c.deadline);
  if (Number.isNaN(deadlineMs)) return null;
  const commentMs = parseBitrixTime(c.lastHumanCommentAt);
  if (!Number.isNaN(commentMs) && commentMs > deadlineMs) return CONTACTED_AFTER_DEADLINE_NOTE;
  const callMs = parseBitrixTime(c.lastCallAt);
  if (!Number.isNaN(callMs) && callMs > deadlineMs) return CONTACTED_AFTER_DEADLINE_NOTE;
  return null;
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
  if (isPurchasePassed(candidate.planStatus) || isOutcomePassed(candidate.outcome)) {
    return { ...base, kind: "passed" };
  }

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
  const overMonthItems = overdue.filter((item) => isOverMonth(item, context, maxOverdueDays));
  const overdueOverMonthTasks: OverdueOverMonthTask[] = [...overMonthItems]
    .sort(
      (a, b) =>
        b.candidate.amount - a.candidate.amount ||
        b.overdueDays - a.overdueDays ||
        deadlineOf(a) - deadlineOf(b) ||
        a.candidate.id.localeCompare(b.candidate.id)
    )
    .map((item) => ({
      id: item.candidate.id,
      dealId: item.candidate.dealId,
      title: item.candidate.title,
      overdueDays: item.overdueDays,
      amount: item.candidate.amount,
      deadline: item.candidate.deadline,
      subject: item.candidate.subject,
      planNumber: item.candidate.planNumber ?? null
    }));
  const newTodos = classified.filter((item) => item.kind === "new");
  const dealIds = (items: readonly ClassifiedTodo[]) => [...new Set(items.map((item) => item.candidate.dealId))];

  return {
    overdue: overdue.length,
    overdueOverMonth: overMonthItems.length,
    overdueOverMonthTasks,
    overdueOngoing: overdue.filter((item) => isPurchaseOngoing(item.candidate.planStatus)).length,
    newDeals: dealIds(newTodos).length,
    newStaleDeals: dealIds(newTodos.filter((item) => item.ageDays > NEW_TODO_PROBLEM_AGE_DAYS)).length,
    newOldestAgeDays: Math.floor(Math.max(0, ...newTodos.map((item) => item.ageDays))),
    readyToCloseDealIds: dealIds(classified.filter((item) => item.kind === "passed")),
    wonOnPortalNotClosed: 0
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
 * inside a group: current/future plan months first (passed plan months after), then by deal amount desc, then by deadline asc.
 * Passed procurements and month-old overdue stay out.
 */
export function rankDebtTopTasks(classified: readonly ClassifiedTodo[], context: DebtContext): DebtTopTask[] {
  const maxOverdueDays = context.maxOverdueDays ?? DEFAULT_MAX_OVERDUE_DAYS;
  const entries = classified.flatMap((item) => {
    const group = topGroup(item, context, maxOverdueDays);
    if (group === null || item.kind === "passed") return [];
    const passedPlanMonthNote = getPassedPlanMonthNote(
      item.candidate.planStatus,
      item.candidate.planMonth,
      context.nowIso
    );
    const contactedAfterDeadlineNote = getContactedAfterDeadlineNote(item);
    return [{ item, group, passedPlanMonthNote, contactedAfterDeadlineNote }];
  });
  const byPriority = [...entries].sort(
    (a, b) =>
      a.group - b.group ||
      (a.passedPlanMonthNote ? 1 : 0) - (b.passedPlanMonthNote ? 1 : 0) ||
      deadlineOf(a.item) - deadlineOf(b.item) ||
      a.item.candidate.id.localeCompare(b.item.candidate.id)
  );
  const bestPerDeal = new Map<string, (typeof entries)[number]>();
  for (const entry of byPriority) {
    if (!bestPerDeal.has(entry.item.candidate.dealId)) bestPerDeal.set(entry.item.candidate.dealId, entry);
  }

  return [...bestPerDeal.values()]
    .sort(
      (a, b) =>
        a.group - b.group ||
        (a.passedPlanMonthNote ? 1 : 0) - (b.passedPlanMonthNote ? 1 : 0) ||
        b.item.candidate.amount - a.item.candidate.amount ||
        deadlineOf(a.item) - deadlineOf(b.item) ||
        a.item.candidate.id.localeCompare(b.item.candidate.id)
    )
    .slice(0, TOP_TASKS_PER_MANAGER)
    .map(({ item, group, passedPlanMonthNote, contactedAfterDeadlineNote }) => ({
      ...item.candidate,
      isOverdue: item.kind === "overdue",
      rank: group,
      kind: item.kind as DebtTopTask["kind"],
      group,
      overdueDays: item.overdueDays,
      ageDays: item.ageDays,
      passedPlanMonthNote,
      contactedAfterDeadlineNote
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
