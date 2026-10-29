import type {
  SalesPultPayload,
  PultGroupView,
  PultManagerView,
  TargetsConfig,
  PaceContext
} from "./types.js";
import { fmtNumber, fmtNumber1, plural } from "./format.js";

export const DEFAULT_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-02", "2026-01-07",
  "2026-03-08", "2026-03-21", "2026-03-22", "2026-03-23", "2026-03-24", "2026-03-25",
  "2026-05-01", "2026-05-07", "2026-05-09",
  "2026-07-06",
  "2026-08-30",
  "2026-10-25", "2026-10-26",
  "2026-12-16"
]);

export function isWorkDay(
  year: number,
  month: number,
  day: number,
  holidays: Set<string> = DEFAULT_HOLIDAYS
): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return !holidays.has(iso);
}

export function getMonthWorkDays(
  year: number,
  month: number,
  holidays: Set<string> = DEFAULT_HOLIDAYS
): number[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const res: number[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (isWorkDay(year, month, d, holidays)) res.push(d);
  }
  return res;
}

export function parseGenHour(generatedAt: string): { genHour: number; genLabel: string } {
  const m = generatedAt.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) {
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    return {
      genHour: h,
      genLabel: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    };
  }
  const [, , , , hh, mm] = m;
  const hourNum = Number(hh) + Number(mm) / 60;
  return { genHour: hourNum, genLabel: `${hh}:${mm}` };
}

export function getAlmatyHour(generatedAt: string): number {
  return Math.floor(parseGenHour(generatedAt).genHour);
}

export function calculatePace(
  asOfDate: string,
  generatedAt: string,
  holidaysList?: string[] | Set<string>
): PaceContext {
  const holidays = holidaysList instanceof Set ? holidaysList : holidaysList ? new Set(holidaysList) : DEFAULT_HOLIDAYS;
  const [year, month, day] = asOfDate.split("-").map(Number);
  const { genHour, genLabel } = parseGenHour(generatedAt);
  const isEarly = genHour < 9;
  const todayIsWork = isWorkDay(year, month, day, holidays);

  const workStart = 9;
  const workEnd = 18;
  const dayFrac = !todayIsWork
    ? 0
    : genHour <= workStart
      ? 0
      : genHour >= workEnd
        ? 1
        : (genHour - workStart) / (workEnd - workStart);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const workDays = getMonthWorkDays(year, month, holidays);
  const wdBefore = workDays.filter((d) => d < day).length;
  const monthDone = wdBefore + dayFrac;
  const monthTotal = workDays.length;

  const current = new Date(Date.UTC(year, month - 1, day));
  const dow = current.getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(Date.UTC(year, month - 1, day + mondayOffset));
  const weekWork: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const t = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + i));
    const isWk = isWorkDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), holidays);
    if (isWk) weekWork.push(t);
  }
  const weekBefore = weekWork.filter((t) => t.getTime() < current.getTime()).length;

  return {
    year, month, day, genHour, genLabel, isEarly, todayIsWork,
    dayFrac, daysInMonth, workDays, wdBefore, monthDone, monthTotal,
    weekWork, weekBefore,
    pace: {
      day: todayIsWork ? dayFrac : 0,
      week: weekWork.length ? (weekBefore + dayFrac) / weekWork.length : 0,
      month: monthTotal ? monthDone / monthTotal : 0
    }
  };
}

export interface MetricJudgeResult {
  cls: "good" | "warn" | "bad" | "idle";
  text: string;
  expected: number;
}

export function judgeMetricStatus(
  fact: number,
  target: number,
  period: "day" | "week" | "month",
  metric?: "calls" | "proposals" | "contracts" | string,
  paceContext?: PaceContext
): MetricJudgeResult {
  const lumpy = period === "day" && metric !== undefined && metric !== "calls";
  const pace = lumpy || !paceContext ? 0 : paceContext.pace[period];
  const expected = target * pace;

  if (period === "day" && paceContext?.isEarly && fact === 0) {
    return { cls: "idle", text: "День начнётся в 09:00", expected: 0 };
  }
  if (fact >= target) {
    return { cls: "good", text: "План выполнен", expected };
  }
  if (lumpy) {
    return {
      cls: "idle",
      text: fact ? `До нормы дня ещё ${fmtNumber(target - fact)}` : "Сегодня пока ни одного",
      expected: 0
    };
  }
  if (expected < 0.5) {
    return { cls: "idle", text: "Рано судить", expected };
  }
  const ratio = fact / expected;
  if (ratio >= 1) {
    return { cls: "good", text: "Идём в темпе", expected };
  }
  const gap = Math.round(expected - fact);
  if (ratio >= 0.8) {
    return { cls: "warn", text: `Чуть отстаём, на ${fmtNumber(gap)}`, expected };
  }
  return { cls: "bad", text: `Отстаём от темпа на ${fmtNumber(gap)}`, expected };
}

function formatDailyRate(rate: number): string {
  const rounded10 = Math.round(rate * 10);
  const isFraction = rounded10 % 10 !== 0;
  if (isFraction) {
    return `${fmtNumber1(rate)} договора`;
  }
  return plural(Math.round(rate), ["договор", "договора", "договоров"]);
}

export interface MonthForecastResult {
  pacePerDay: number;
  daysLeft: number;
  forecast: number;
  left: number;
  need: number;
  pct: number;
  fpct: number;
  verdict: string;
  hasForecast: boolean;
}

export function calculateMonthForecast(
  plan: number,
  fact: number,
  monthDone: number,
  monthTotal: number
): MonthForecastResult {
  const pacePerDay = monthDone > 0 ? fact / monthDone : 0;
  const daysLeft = Math.max(0, monthTotal - monthDone);
  const forecast = Math.round(fact + pacePerDay * daysLeft);
  const left = Math.max(0, plan - fact);
  const need = daysLeft > 0 ? left / daysLeft : 0;
  const pct = plan ? Math.round((fact / plan) * 100) : 0;
  const fpct = plan ? Math.round((forecast / plan) * 100) : 0;
  const hasForecast = monthDone >= 3;

  let verdict: string;
  if (fact >= plan) {
    verdict = "План месяца <b>выполнен</b>. Всё, что подпишем дальше, сверху.";
  } else if (daysLeft <= 0) {
    verdict = `Рабочие дни месяца закончились: подписано ${fmtNumber(fact)} из ${fmtNumber(plan)}, это ${pct}% плана.`;
  } else if (monthDone < 3) {
    const startRate = daysLeft > 0 ? left / daysLeft : 0;
    verdict = `Месяц только начался. Чтобы закрыть план, нужно ${formatDailyRate(startRate)} в рабочий день.`;
  } else if (forecast >= plan) {
    verdict = `Идём в темпе: при нынешней скорости к концу месяца будет <b>≈ ${fmtNumber(forecast)}</b>, план закроем.`;
  } else {
    const daysLeftWords = Math.ceil(daysLeft);
    if (daysLeftWords <= 5 && daysLeftWords > 0 && pacePerDay > 0 && need > 2 * pacePerDay) {
      verdict = `План месяца уже не закрыть: осталось ${plural(left, ["договор", "договора", "договоров"])} за ${plural(daysLeftWords, ["рабочий день", "рабочих дня", "рабочих дней"])}.`;
    } else {
      verdict = `При нынешнем темпе к концу месяца будет <b>≈ ${fmtNumber(forecast)} из ${fmtNumber(plan)}</b>, это ${fpct}% плана. Чтобы закрыть план, нужно <b>${fmtNumber1(need)} в день</b> вместо ${fmtNumber1(pacePerDay)}.`;
    }
  }

  return { pacePerDay, daysLeft, forecast, left, need, pct, fpct, verdict, hasForecast };
}

export interface GroupTotals {
  calls: number;
  attempts: number;
  minutes: number;
  kp: number;
  contracts: number;
  amount: number;
}

export function computeGroupTotals(group: PultGroupView, period: "day" | "week" | "month"): GroupTotals {
  const t: GroupTotals = { calls: 0, attempts: 0, minutes: 0, kp: 0, contracts: 0, amount: 0 };
  for (const m of group.managers) {
    if (!m.active) continue;
    const r = m.rollups[period];
    t.calls += r.calls.successful;
    t.attempts += r.calls.totalAttempts;
    t.minutes += r.calls.durationMinutes;
    t.kp += r.proposals.uniqueDealsCount;
    t.contracts += r.contracts.uniqueDealsCount;
    t.amount += r.contracts.totalAmount;
  }
  return t;
}

const TARGET_KEYS = { day: "daily", week: "weekly", month: "monthly" } as const;
export function getTarget(
  targets: TargetsConfig,
  period: "day" | "week" | "month",
  metric: "calls" | "proposals" | "contracts"
): number {
  return targets[TARGET_KEYS[period]][metric];
}

// Re-exports
export * from "./types.js";
export * from "./format.js";
export * from "./signals.js";
export * from "./callNotes.js";
export * from "./view.js";
