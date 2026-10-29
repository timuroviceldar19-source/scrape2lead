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
  stageSemanticId?: string | null;
  closed?: string | boolean | null;
  /** Real procurement status, taken from the deal field UF_CRM_PLAN_STATUS. */
  planStatus?: string | null;
  /** Planned procurement month name from UF_CRM_1715597726664. */
  planMonth?: string | null;
  outcome?: string | null;
  portalSignDate?: string | null;
  closeDate?: string | null;
  dateCreate?: string | null;
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
  stageSemanticId?: string | null;
  closed?: string | boolean | null;
  /** The essence of the activity ("Перезвонить", "Связаться с клиентом"). */
  subject?: string;
  /** Activity creation time as returned by Bitrix. */
  created?: string;
  planStatus?: string | null;
  planMonth?: string | null;
  /** Deal creation time (DATE_CREATE); its year is the year of the plan month. */
  dealCreated?: string | null;
  outcome?: string | null;
  hasContactAfterDeadline?: boolean;
  lastHumanCommentAt?: string | null;
  lastCallAt?: string | null;
  responsibleNote?: string | null;
}

export interface TopTask extends RawTask {
  isOverdue: boolean;
  rank: number;
  /** overdue / today / new — see debts.ts. */
  kind?: "overdue" | "today" | "new";
  group?: 1 | 2 | 3 | 4;
  overdueDays?: number;
  ageDays?: number;
  passedPlanMonthNote?: string | null;
  contactedAfterDeadlineNote?: string | null;
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
/**
 * Returns time formatted as HH:mm in UTC+5 timezone (Asia/Almaty).
 */
export function formatAlmatyTime(isoOrDate: string | Date): string {
  const ms = typeof isoOrDate === "string" ? Date.parse(isoOrDate) : isoOrDate.getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date value: ${String(isoOrDate)}`);
  }
  return new Date(ms + 5 * 3600000).toISOString().slice(11, 16);
}

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

/**
 * Calculates metrics for one manager on a single day.
 */
export function calculateDailyMetrics(params: {
  managerId: string;
  date: string;
  calls: CallRecord[];
  kpTransitions: StageTransition[];
  contractTransitions: StageTransition[];
  deals: Map<string, DealInfo>;
}): DailyActivityMetrics {
  const { managerId, date, calls, kpTransitions, contractTransitions, deals } = params;

  // 1. Calls
  const dayCalls = calls.filter(
    (c) => String(c.userId) === String(managerId) && toAlmatyDate(c.startDate) === date
  );
  const totalAttempts = dayCalls.length;
  const successfulCalls = dayCalls.filter((c) => String(c.statusCode) === "200");
  const durationSeconds = successfulCalls.reduce((sum, c) => sum + (c.durationSeconds || 0), 0);
  const durationMinutes = Math.round(durationSeconds / 60);

  // 2. Proposals (unique deals transitioned into proposal stages)
  const dayKpTransitions = kpTransitions.filter((t) => {
    if (toAlmatyDate(t.createdTime) !== date) return false;
    const deal = deals.get(String(t.dealId));
    return deal && String(deal.assignedById) === String(managerId);
  });
  const uniqueKpDealIds = [...new Set(dayKpTransitions.map((t) => String(t.dealId)))];

  // 3. Contracts
  // 3a. From CRM stage transitions to WON (unless overridden by a different portal sign date)
  const contractDealIdSet = new Set<string>();

  for (const t of contractTransitions) {
    if (toAlmatyDate(t.createdTime) !== date) continue;
    const deal = deals.get(String(t.dealId));
    if (!deal || String(deal.assignedById) !== String(managerId)) continue;
    if (deal.stageSemanticId === "F") continue;
    // If the deal has a portal sign date that is different from this date,
    // it will be counted on that portal sign date instead.
    if (deal.portalSignDate && deal.portalSignDate !== date) continue;
    contractDealIdSet.add(String(t.dealId));
  }

  // 3b. From portal contracts (won: or partner:) where portal sign date is today
  for (const deal of deals.values()) {
    if (String(deal.assignedById) !== String(managerId)) continue;
    if (deal.stageSemanticId === "F") continue;
    const outcome = String(deal.outcome ?? "");
    const isPortalWon = outcome.startsWith("won:") || outcome.startsWith("partner:");
    if (!isPortalWon) continue;
    if (deal.portalSignDate === date) {
      contractDealIdSet.add(deal.id);
    }
  }

  const uniqueContractDealIds = [...contractDealIdSet];
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
