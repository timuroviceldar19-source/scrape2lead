import fs from "node:fs";
import {
  buildPultView,
  buildPultSignals,
  safeJson,
  calculatePace,
  calculateMonthForecast,
  judgeMetricStatus,
  buildCallNotes,
  formatMoney,
  plural,
  pluralDeals,
  pluralDays,
  decodeHtmlEntities,
  escapeHtml,
  cleanFirstName,
  cleanFullName,
  initials,
  cleanTaskTitle,
  getTaskStatus,
  formatDebtLines,
  formatTaskLine,
  formatTaskDeadline,
  formatOverdue,
  formatUpdatedTime,
  getAlmatyHour,
  isWorkDay,
  getMonthWorkDays,
  DEFAULT_HOLIDAYS,
  type SalesPultPayload,
  type PultGroupView,
  type PultManagerView,
  type DayDynamic,
  type SignalItem,
  type DebtLine,
  type PultView,
  type PultPeriodView,
  type PultMonthView,
  type PultMetricStatusView,
  type PultSalesManagerView,
  type PultTenderManagerView
} from "./pace.js";

import type { RegisterView } from "./register/types.js";

const pultHtml = fs.readFileSync(new URL("./page/pult.html", import.meta.url), "utf8");
const regHtml = fs.readFileSync(new URL("./page/reg.html", import.meta.url), "utf8");
const pultCss = fs.readFileSync(new URL("./page/pult.css", import.meta.url), "utf8");
const pultClientJs = fs.readFileSync(new URL("./page/pult.client.js", import.meta.url), "utf8");
const registerClientJs = fs.readFileSync(new URL("./page/register.client.js", import.meta.url), "utf8");
const regRunnerClientJs = fs.readFileSync(new URL("./page/reg.client.js", import.meta.url), "utf8");
const marketClientJs = fs.readFileSync(new URL("./page/market.client.js", import.meta.url), "utf8");

const pultPageClientJs = `${marketClientJs}\n${pultClientJs}`;
const regPageClientJs = `${registerClientJs}\n${regRunnerClientJs}`;

const PLACEHOLDER_RE = /\/\*__CSS__\*\/|__PAYLOAD__|__VIEW__|\/\*__CLIENT_JS__\*\//g;

export interface RegisterPagePayload {
  asOfDate: string;
  generatedAt: string;
  portal?: string;
  pultUrl?: string;
  register: RegisterView;
}

export function buildSignals(payload: SalesPultPayload): SignalItem[] {
  return buildPultSignals(payload);
}

export function renderPultHtml(payload: SalesPultPayload): string {
  const safePayload = { ...payload };
  if ("register" in safePayload) {
    delete (safePayload as Record<string, unknown>).register;
  }
  const view = buildPultView(safePayload);
  const replacements: Record<string, string> = {
    "/*__CSS__*/": pultCss,
    "__PAYLOAD__": safeJson(safePayload),
    "__VIEW__": safeJson(view),
    "/*__CLIENT_JS__*/": pultPageClientJs
  };

  return pultHtml.replace(PLACEHOLDER_RE, (match) => replacements[match] ?? match);
}

export function renderRegisterHtml(payload: RegisterPagePayload): string {
  const replacements: Record<string, string> = {
    "/*__CSS__*/": pultCss,
    "__PAYLOAD__": safeJson(payload),
    "/*__CLIENT_JS__*/": regPageClientJs
  };

  return regHtml.replace(PLACEHOLDER_RE, (match) => replacements[match] ?? match);
}

export {
  buildPultView,
  buildPultSignals,
  safeJson,
  calculatePace,
  calculateMonthForecast,
  judgeMetricStatus,
  buildCallNotes,
  formatMoney,
  plural,
  pluralDeals,
  pluralDays,
  decodeHtmlEntities,
  escapeHtml,
  cleanFirstName,
  cleanFullName,
  initials,
  cleanTaskTitle,
  getTaskStatus,
  formatDebtLines,
  formatTaskLine,
  formatTaskDeadline,
  formatOverdue,
  formatUpdatedTime,
  getAlmatyHour,
  isWorkDay,
  getMonthWorkDays,
  DEFAULT_HOLIDAYS,
  type SalesPultPayload,
  type PultGroupView,
  type PultManagerView,
  type DayDynamic,
  type SignalItem,
  type DebtLine,
  type PultView,
  type PultPeriodView,
  type PultMonthView,
  type PultMetricStatusView,
  type PultSalesManagerView,
  type PultTenderManagerView
};

