import type { TargetsConfig, ManagerRollups, TopTask } from "./metrics.js";
import type { ManagerDebts } from "./debts.js";
import type { RegisterView } from "./register/types.js";
import type { MarketView } from "../../kz/market/types.js";

export interface DayDynamic {
  date: string;
  calls: number;
  contracts: number;
  amount: number;
  proposals?: number;
}

export type { TargetsConfig, ManagerRollups, TopTask, ManagerDebts };

export interface PultManagerRollups extends ManagerRollups {}

export interface PultManagerView {
  id: string;
  name: string;
  active: boolean;
  rollups: PultManagerRollups;
  topTasks?: TopTask[];
  debts?: ManagerDebts;
}

export interface PultGroupView {
  id: "sales" | "tenders" | string;
  name: string;
  managers: PultManagerView[];
}

export interface SalesPultPayload {
  asOfDate: string;
  generatedAt: string;
  portal: string;
  pultUrl?: string;
  targets: TargetsConfig;
  callsAvailable: boolean;
  callsError?: string;
  proposalsTracked?: boolean;
  groups: PultGroupView[];
  dynamics: DayDynamic[];
  holidays?: string[];
  register?: RegisterView | null;
  market?: MarketView | null;
}

export interface PaceContext {
  year: number;
  month: number;
  day: number;
  genHour: number;
  genLabel: string;
  isEarly: boolean;
  todayIsWork: boolean;
  dayFrac: number;
  daysInMonth: number;
  workDays: number[];
  wdBefore: number;
  monthDone: number;
  monthTotal: number;
  weekWork: Date[];
  weekBefore: number;
  pace: {
    day: number;
    week: number;
    month: number;
  };
}

export interface MetricJudgeResult {
  cls: "good" | "warn" | "bad" | "idle";
  text: string;
  expected: number;
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
}

export interface SignalItem {
  color: "red" | "yellow" | "green" | "gray";
  text: string;
}

export interface DebtLine {
  color: "red" | "yellow" | "gray";
  text: string;
}

/* ================= View Model Types ================= */

export interface PultMetricStatusView {
  fact: number;
  target: number;
  expected: number;
  cls: "good" | "warn" | "bad" | "idle";
  label: string;
  text: string;
  sub?: string;
  untracked?: boolean;
}

export interface PultManagerCallsView extends PultMetricStatusView {
  totalAttempts: number;
  durationMinutes: number;
  hasBitrixCalls: boolean;
  noCallsFlag: boolean;
  isEarlyEmpty: boolean;
}

export interface PultManagerContractsView extends PultMetricStatusView {
  totalAmount: number;
  isEarlyEmpty: boolean;
}

export interface PultManagerProposalsView extends PultMetricStatusView {
  isEarlyEmpty: boolean;
}

export interface PultSalesManagerView {
  id: string;
  name: string;
  initials: string;
  tasksCountText: string;
  calls: PultManagerCallsView;
  proposals: PultManagerProposalsView;
  contracts: PultManagerContractsView;
  debts?: ManagerDebts;
  topTasks: TopTask[];
}

export interface PultTenderManagerView {
  id: string;
  name: string;
  initials: string;
  contracts: PultManagerContractsView;
  debts?: ManagerDebts;
  topTasks: TopTask[];
}

export interface PultAnatomyRowView {
  id: string;
  name: string;
  initials: string;
  successful: number;
  totalAttempts: number;
  durationMinutes: number;
  okPct: number;
  missPct: number;
  tgtPct: number;
  convStr: string;
  avgStr: string;
  isEarlyEmpty: boolean;
}

export interface PultPeriodView {
  period: "day" | "week" | "month";
  periodName: string;
  isEarly: boolean;
  yesterdayLine: string;
  sales: {
    name: string;
    periodName: string;
    meta: string;
    isEarly: boolean;
    earlyText: string;
    totals: {
      calls: PultMetricStatusView;
      proposals: PultMetricStatusView;
      contracts: PultMetricStatusView & { totalAmount: number };
      attempts: number;
      minutes: number;
    };
    managers: PultSalesManagerView[];
    activeCount: number;
  };
  calls: {
    periodName: string;
    meta: string;
    strip: {
      calls: number;
      attempts: number;
      conv: number;
      avg: number;
      normLabel: string;
      normValue: string;
      normSub: string;
      norm: number;
    };
    notes: string[];
    anatomy: PultAnatomyRowView[];
  };
  tenders?: {
    name: string;
    periodName: string;
    meta: string;
    totals: {
      contracts: PultMetricStatusView & { totalAmount: number };
    };
    managers: PultTenderManagerView[];
    activeCount: number;
  };
}

export type PultSalesDepartmentView = PultPeriodView["sales"];
export type PultCallsDepartmentView = PultPeriodView["calls"];
export type PultTendersDepartmentView = NonNullable<PultPeriodView["tenders"]>;

export interface PultMonthView {
  plan: number;
  fact: number;
  amount: number;
  pacePerDay: number;
  forecast: number;
  left: number;
  daysLeft: number;
  pct: number;
  fpct: number;
  hasForecast: boolean;
  monthDone: number;
  monthTotal: number;
  wdBefore: number;
  daysInMonth: number;
  targetContracts: number;
  totalActiveCount: number;
  verdict: string;
  split: Array<{
    name: string;
    c: number;
    a: number;
    widthPct: number;
    amountFormatted: string;
  }>;
  points: number[];
  byDay: Array<{
    day: number;
    calls: number;
    contracts: number;
    amount: number;
  }>;
  workDays: number[];
  weekends: number[];
  nowXDay: number;
  dayFrac: number;
  asOfDate: string;
  asOfDay: number;
  asOfMonth: number;
  asOfYear: number;
}

export interface PultView {
  signals: Array<{ cls: string; text: string; color: "red" | "yellow" | "green" | "gray" }>;
  signalsUrgent: number;
  signalsMeta: string;
  month: PultMonthView;
  periods: {
    day: PultPeriodView;
    week: PultPeriodView;
    month: PultPeriodView;
  };
  dateLabel: string;
  wdLabel: string;
  monthFillPct: number;
  todayIsWork: boolean;
  genLabel: string;
  genHour: number;
}
