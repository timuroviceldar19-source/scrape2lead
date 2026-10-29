import type { ManagerRollups, TopTask, TargetsConfig } from "./metrics.js";
import type { ManagerDebts } from "./debts.js";
import { generatePultTemplate } from "./template.js";
import {
  buildPultSignals,
  type SignalItem,
  type DebtLine,
  calculatePace,
  calculateMonthForecast,
  judgeMetricStatus,
  buildCallNotes,
  formatMoney,
  plural,
  pluralDeals,
  pluralDays,
  decodeHtmlEntities,
  cleanFirstName,
  cleanFullName,
  initials,
  cleanTaskTitle,
  getTaskStatus,
  formatDebtLines,
  formatTaskLine,
  formatUpdatedTime,
  getAlmatyHour,
  formatTaskDeadline,
  formatOverdue,
  isWorkDay,
  getMonthWorkDays,
  DEFAULT_HOLIDAYS
} from "./pace.js";

export interface PultManagerView {
  id: string;
  name: string;
  active: boolean;
  rollups: ManagerRollups;
  topTasks: TopTask[];
  /** Today's debts; independent of the selected period. */
  debts?: ManagerDebts;
}

export interface PultGroupView {
  id: string;
  name: string;
  managers: PultManagerView[];
}

export interface DayDynamic {
  date: string;
  calls: number;
  proposals: number;
  contracts: number;
  amount: number;
}

export interface SalesPultPayload {
  asOfDate: string;
  generatedAt: string;
  portal: string;
  pultUrl: string;
  targets: TargetsConfig;
  callsAvailable: boolean;
  callsError?: string;
  groups: PultGroupView[];
  dynamics: DayDynamic[];
  proposalsTracked?: boolean;
  holidays?: string[];
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

export function buildSignals(payload: SalesPultPayload): SignalItem[] {
  return buildPultSignals(payload);
}

export function renderPultHtml(payload: SalesPultPayload): string {
  const json = safeJson(payload);
  const template = generatePultTemplate();
  return template.replace("__PAYLOAD__", () => json);
}

export {
  buildPultSignals,
  calculatePace,
  calculateMonthForecast,
  judgeMetricStatus,
  buildCallNotes,
  formatMoney,
  plural,
  pluralDeals,
  pluralDays,
  decodeHtmlEntities,
  cleanFirstName,
  cleanFullName,
  initials,
  cleanTaskTitle,
  getTaskStatus,
  formatDebtLines,
  formatTaskLine,
  formatUpdatedTime,
  getAlmatyHour,
  formatTaskDeadline,
  formatOverdue,
  isWorkDay,
  getMonthWorkDays,
  DEFAULT_HOLIDAYS,
  type SignalItem,
  type DebtLine
};
