export interface CallRecord {
  id: string;
  userId: string;
  statusCode: string;
  durationSeconds: number;
  startDate: string;
}

export interface StageTransition {
  id: string;
  dealId: string;
  stageId: string;
  createdTime: string;
}

export interface DealInfo {
  id: string;
  title: string;
  amount: number;
  assignedById: string;
  planNumber?: string | null;
  categoryId?: string | number | null;
  stageId?: string | null;
}

export interface DailyActivityMetrics {
  managerId: string;
  date: string;
  calls: {
    successful: number;
    totalAttempts: number;
    durationSeconds: number;
    durationMinutes: number;
    hasBitrixCalls: boolean;
  };
  proposals: {
    uniqueDealsCount: number;
    dealIds: string[];
  };
  contracts: {
    uniqueDealsCount: number;
    totalAmount: number;
    dealIds: string[];
  };
}

export interface RawTask {
  id: string;
  dealId: string;
  title: string;
  deadline: string;
  amount: number;
  lastComment?: string | null;
  planNumber?: string | null;
  categoryId?: string | number | null;
  stageId?: string | null;
}

export interface TopTask extends RawTask {
  isOverdue: boolean;
  rank: number;
}

export interface TargetsConfig {
  daily: { calls: number; proposals: number; contracts: number };
  weekly: { calls: number; proposals: number; contracts: number };
  monthly: { calls: number; proposals: number; contracts: number };
}

export type MetricStatus = "green" | "yellow" | "red";

export interface PeriodSummary {
  calls: {
    successful: number;
    totalAttempts: number;
    durationSeconds: number;
    durationMinutes: number;
    status: MetricStatus;
  };
  proposals: {
    uniqueDealsCount: number;
    dealIds: string[];
    status: MetricStatus;
  };
  contracts: {
    uniqueDealsCount: number;
    totalAmount: number;
    dealIds: string[];
    status: MetricStatus;
  };
}

export interface ManagerRollups {
  managerId: string;
  asOfDate: string;
  day: PeriodSummary;
  week: PeriodSummary;
  month: PeriodSummary;
  signals: {
    zeroBitrixCallsToday: boolean;
    zeroKpThreeDays: boolean;
  };
}

/**
 * Returns date formatted as YYYY-MM-DD in UTC+5 timezone (Asia/Almaty).
 */
export function toAlmatyDate(isoOrDate: string | Date): string {
  const ms = typeof isoOrDate === "string" ? Date.parse(isoOrDate) : isoOrDate.getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date value: ${String(isoOrDate)}`);
  }
  return new Date(ms + 5 * 3600000).toISOString().slice(0, 10);
}

/**
 * Returns end of day ISO string in UTC+5 for a given date YYYY-MM-DD.
 */
export function toAlmatyEndOfDay(dateStr: string): string {
  return `${dateStr}T23:59:59+05:00`;
}

/**
 * Returns start of day ISO string in UTC+5 for a given date YYYY-MM-DD.
 */
export function toAlmatyStartOfDay(dateStr: string): string {
  return `${dateStr}T00:00:00+05:00`;
}

/**
 * Get metric status based on fact vs target.
 * >= 100%: green
 * >= 60%: yellow
 * < 60%: red
 */
export function getMetricStatus(fact: number, target: number): MetricStatus {
  if (target <= 0) return "green";
  if (fact >= target) return "green";
  if (fact >= Math.ceil(target * 0.6)) return "yellow";
  return "red";
}

/** Default minimum talk time for a call to count towards the calls target. */
export const DEFAULT_MIN_CALL_SECONDS = 30;

/**
 * Calculates metrics for one manager on a single day.
 * Calls target counts only answered calls (CALL_FAILED_CODE=200) lasting at least minCallSeconds;
 * attempts and minutes on the line include every call / every answered call as before.
 */
export function calculateDailyMetrics(params: {
  managerId: string;
  date: string;
  calls: CallRecord[];
  kpTransitions: StageTransition[];
  contractTransitions: StageTransition[];
  deals: Map<string, DealInfo>;
  minCallSeconds?: number;
}): DailyActivityMetrics {
  const { managerId, date, calls, kpTransitions, contractTransitions, deals } = params;
  const minCallSeconds = params.minCallSeconds ?? DEFAULT_MIN_CALL_SECONDS;

  // 1. Calls
  const dayCalls = calls.filter(
    (c) => String(c.userId) === String(managerId) && toAlmatyDate(c.startDate) === date
  );
  const totalAttempts = dayCalls.length;
  const answeredCalls = dayCalls.filter((c) => String(c.statusCode) === "200");
  const successfulCalls = answeredCalls.filter((c) => (c.durationSeconds || 0) >= minCallSeconds);
  const durationSeconds = answeredCalls.reduce((sum, c) => sum + (c.durationSeconds || 0), 0);
  const durationMinutes = Math.round(durationSeconds / 60);

  // 2. Proposals (unique deals transitioned into proposal stages)
  const dayKpTransitions = kpTransitions.filter((t) => {
    if (toAlmatyDate(t.createdTime) !== date) return false;
    const deal = deals.get(String(t.dealId));
    return deal && String(deal.assignedById) === String(managerId);
  });
  const uniqueKpDealIds = [...new Set(dayKpTransitions.map((t) => String(t.dealId)))];

  // 3. Contracts (unique deals transitioned into won stages)
  const dayContractTransitions = contractTransitions.filter((t) => {
    if (toAlmatyDate(t.createdTime) !== date) return false;
    const deal = deals.get(String(t.dealId));
    return deal && String(deal.assignedById) === String(managerId);
  });
  const uniqueContractDealIds = [...new Set(dayContractTransitions.map((t) => String(t.dealId)))];
  const totalContractAmount = uniqueContractDealIds.reduce((sum, dealId) => {
    const deal = deals.get(dealId);
    return sum + (deal ? deal.amount : 0);
  }, 0);

  return {
    managerId,
    date,
    calls: {
      successful: successfulCalls.length,
      totalAttempts,
      durationSeconds,
      durationMinutes,
      hasBitrixCalls: totalAttempts > 0
    },
    proposals: {
      uniqueDealsCount: uniqueKpDealIds.length,
      dealIds: uniqueKpDealIds
    },
    contracts: {
      uniqueDealsCount: uniqueContractDealIds.length,
      totalAmount: totalContractAmount,
      dealIds: uniqueContractDealIds
    }
  };
}

/**
 * Calculates Monday..Friday dates for the week containing asOfDate.
 */
export function getWorkweekDates(asOfDate: string): string[] {
  const d = new Date(`${asOfDate}T12:00:00Z`);
  const dayOfWeek = d.getUTCDay(); // 0 is Sunday, 1 is Monday ... 6 is Saturday
  // Monday offset:
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(d.getTime() + diffToMonday * 86400000);

  const dates: string[] = [];
  for (let i = 0; i < 5; i++) {
    const day = new Date(monday.getTime() + i * 86400000);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Calculates dates from 1st of the month to asOfDate.
 */
export function getMonthDates(asOfDate: string): string[] {
  const yearMonth = asOfDate.slice(0, 7);
  const dayNum = parseInt(asOfDate.slice(8, 10), 10);
  const dates: string[] = [];
  for (let i = 1; i <= dayNum; i++) {
    dates.push(`${yearMonth}-${String(i).padStart(2, "0")}`);
  }
  return dates;
}

/**
 * Start date for data collection: min(1st of month, Monday of current week).
 * Ensures that if 1st of month is Wed/Thu, Monday and Tuesday from previous month are loaded.
 */
export function getPultCollectionStartDate(asOfDate: string): string {
  const monthStart = `${asOfDate.slice(0, 7)}-01`;
  const weekDates = getWorkweekDates(asOfDate);
  const monday = weekDates[0];
  return monday < monthStart ? monday : monthStart;
}

/**
 * Returns all dates between startDate and endDate inclusive.
 */
export function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cur = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86400000);
  }
  return dates;
}

/**
 * Calculates day, week and month rollups for a manager.
 */
export function calculateRollups(params: {
  managerId: string;
  asOfDate: string;
  dailyMetrics: DailyActivityMetrics[];
  deals: Map<string, DealInfo>;
  targets: TargetsConfig;
}): ManagerRollups {
  const { managerId, asOfDate, dailyMetrics, deals, targets } = params;

  const managerDays = dailyMetrics.filter((m) => String(m.managerId) === String(managerId));
  const dayMetricsMap = new Map<string, DailyActivityMetrics>(managerDays.map((m) => [m.date, m]));

  const getMetricForDate = (date: string): DailyActivityMetrics =>
    dayMetricsMap.get(date) ?? {
      managerId,
      date,
      calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, hasBitrixCalls: false },
      proposals: { uniqueDealsCount: 0, dealIds: [] },
      contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [] }
    };

  // 1. Day
  const today = getMetricForDate(asOfDate);
  const daySummary: PeriodSummary = {
    calls: {
      ...today.calls,
      status: getMetricStatus(today.calls.successful, targets.daily.calls)
    },
    proposals: {
      ...today.proposals,
      status: getMetricStatus(today.proposals.uniqueDealsCount, targets.daily.proposals)
    },
    contracts: {
      ...today.contracts,
      status: getMetricStatus(today.contracts.uniqueDealsCount, targets.daily.contracts)
    }
  };

  // 2. Week (Monday to asOfDate)
  const workweekDates = getWorkweekDates(asOfDate).filter((d) => d <= asOfDate);
  const weekDays = workweekDates.map(getMetricForDate);
  const weekCallsSucc = weekDays.reduce((s, d) => s + d.calls.successful, 0);
  const weekCallsAtt = weekDays.reduce((s, d) => s + d.calls.totalAttempts, 0);
  const weekCallsDur = weekDays.reduce((s, d) => s + d.calls.durationSeconds, 0);
  const weekKpDealIds = [...new Set(weekDays.flatMap((d) => d.proposals.dealIds))];
  const weekContractDealIds = [...new Set(weekDays.flatMap((d) => d.contracts.dealIds))];
  const weekContractAmount = weekContractDealIds.reduce((sum, id) => sum + (deals.get(id)?.amount ?? 0), 0);

  const weekSummary: PeriodSummary = {
    calls: {
      successful: weekCallsSucc,
      totalAttempts: weekCallsAtt,
      durationSeconds: weekCallsDur,
      durationMinutes: Math.round(weekCallsDur / 60),
      status: getMetricStatus(weekCallsSucc, targets.weekly.calls)
    },
    proposals: {
      uniqueDealsCount: weekKpDealIds.length,
      dealIds: weekKpDealIds,
      status: getMetricStatus(weekKpDealIds.length, targets.weekly.proposals)
    },
    contracts: {
      uniqueDealsCount: weekContractDealIds.length,
      totalAmount: weekContractAmount,
      dealIds: weekContractDealIds,
      status: getMetricStatus(weekContractDealIds.length, targets.weekly.contracts)
    }
  };

  // 3. Month (1st to asOfDate)
  const monthDates = getMonthDates(asOfDate);
  const monthDays = monthDates.map(getMetricForDate);
  const monthCallsSucc = monthDays.reduce((s, d) => s + d.calls.successful, 0);
  const monthCallsAtt = monthDays.reduce((s, d) => s + d.calls.totalAttempts, 0);
  const monthCallsDur = monthDays.reduce((s, d) => s + d.calls.durationSeconds, 0);
  const monthKpDealIds = [...new Set(monthDays.flatMap((d) => d.proposals.dealIds))];
  const monthContractDealIds = [...new Set(monthDays.flatMap((d) => d.contracts.dealIds))];
  const monthContractAmount = monthContractDealIds.reduce((sum, id) => sum + (deals.get(id)?.amount ?? 0), 0);

  const monthSummary: PeriodSummary = {
    calls: {
      successful: monthCallsSucc,
      totalAttempts: monthCallsAtt,
      durationSeconds: monthCallsDur,
      durationMinutes: Math.round(monthCallsDur / 60),
      status: getMetricStatus(monthCallsSucc, targets.monthly.calls)
    },
    proposals: {
      uniqueDealsCount: monthKpDealIds.length,
      dealIds: monthKpDealIds,
      status: getMetricStatus(monthKpDealIds.length, targets.monthly.proposals)
    },
    contracts: {
      uniqueDealsCount: monthContractDealIds.length,
      totalAmount: monthContractAmount,
      dealIds: monthContractDealIds,
      status: getMetricStatus(monthContractDealIds.length, targets.monthly.contracts)
    }
  };

  // Signals:
  // - 0 calls in Bitrix today
  const zeroBitrixCallsToday = today.calls.successful === 0 && today.calls.totalAttempts === 0;

  // - 0 proposals for 3 consecutive working days
  const last3Workdays = workweekDates.slice(-3);
  const zeroKpThreeDays =
    last3Workdays.length >= 3 &&
    last3Workdays.every((d) => (dayMetricsMap.get(d)?.proposals.uniqueDealsCount ?? 0) === 0);

  return {
    managerId,
    asOfDate,
    day: daySummary,
    week: weekSummary,
    month: monthSummary,
    signals: {
      zeroBitrixCallsToday,
      zeroKpThreeDays
    }
  };
}

export interface RankTopTasksOptions {
  maxOverdueDays?: number;
  topTaskCategories?: number[];
}

/**
 * Ranks tasks for Top-5:
 * 1. Filter: open deals in funnels specified by topTaskCategories (default 9, 41, 43); overdue not older than maxOverdueDays.
 * 2. Overdue first, then upcoming; inside each group sort by deal amount descending.
 * 3. Deduplicate by dealId (only 1 task per deal).
 * 4. Return at most 5 tasks.
 */
export function rankTopTasks(
  tasks: RawTask[],
  nowIso: string,
  options: RankTopTasksOptions = {}
): TopTask[] {
  const nowMs = Date.parse(nowIso);
  const maxOverdueDays = options.maxOverdueDays ?? 30;
  const allowedCategories = options.topTaskCategories ?? [9, 41, 43];
  const allowedCategoriesSet = new Set(allowedCategories.map(Number));

  const validTasks = tasks.filter((t) => {
    if (!t.dealId) return false;

    // Check category: must match allowed funnels
    const cat = Number(t.categoryId);
    const stage = String(t.stageId ?? "");
    const stagePrefixMatch = stage.match(/^C(\d+):/i);
    const stageCat = stagePrefixMatch ? Number(stagePrefixMatch[1]) : null;

    const isValidCategory =
      allowedCategoriesSet.has(cat) ||
      (stageCat !== null && allowedCategoriesSet.has(stageCat));
    if (!isValidCategory) return false;

    // Check open deal: not WON, not LOSE, not APOLOGY
    const stageUpper = stage.toUpperCase();
    const isClosed =
      stageUpper.endsWith(":WON") ||
      stageUpper === "WON" ||
      stageUpper.endsWith(":LOSE") ||
      stageUpper === "LOSE" ||
      stageUpper.includes("APOLOGY");
    if (isClosed) return false;

    // Check overdue threshold (not older than maxOverdueDays)
    if (t.deadline) {
      const deadlineMs = Date.parse(t.deadline);
      if (!Number.isNaN(deadlineMs) && deadlineMs < nowMs) {
        const overdueDays = (nowMs - deadlineMs) / 86400000;
        if (overdueDays > maxOverdueDays) {
          return false;
        }
      }
    }

    return true;
  });

  const enriched: TopTask[] = validTasks.map((t) => {
    const deadlineMs = Date.parse(t.deadline);
    const isOverdue = !Number.isNaN(deadlineMs) && deadlineMs < nowMs;
    const rank = isOverdue ? 0 : 1;
    return {
      ...t,
      isOverdue,
      rank
    };
  });

  enriched.sort((a, b) => {
    // 1. Overdue first (rank 0 before rank 1)
    if (a.rank !== b.rank) return a.rank - b.rank;
    // 2. Amount descending
    if (b.amount !== a.amount) return b.amount - a.amount;
    // 3. Deadline ascending
    const aDead = Date.parse(a.deadline) || 0;
    const bDead = Date.parse(b.deadline) || 0;
    if (aDead !== bDead) return aDead - bDead;
    // 4. Stable by id
    return a.id.localeCompare(b.id);
  });

  // Deduplicate by dealId
  const seenDeals = new Set<string>();
  const topTasks: TopTask[] = [];
  for (const t of enriched) {
    if (seenDeals.has(t.dealId)) {
      continue;
    }
    seenDeals.add(t.dealId);
    topTasks.push(t);
    if (topTasks.length === 5) {
      break;
    }
  }

  return topTasks;
}
