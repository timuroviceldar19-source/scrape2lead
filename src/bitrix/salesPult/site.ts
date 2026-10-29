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

const pultHtml = fs.readFileSync(new URL("./page/pult.html", import.meta.url), "utf8");
const pultCss = fs.readFileSync(new URL("./page/pult.css", import.meta.url), "utf8");
const pultClientJs = fs.readFileSync(new URL("./page/pult.client.js", import.meta.url), "utf8");
const registerClientJs = fs.readFileSync(new URL("./page/register.client.js", import.meta.url), "utf8");
const marketClientJs = fs.readFileSync(new URL("./page/market.client.js", import.meta.url), "utf8");

const fullClientJs = `${registerClientJs}\n${marketClientJs}\n${pultClientJs}`;

const PLACEHOLDER_RE = /\/\*__CSS__\*\/|__PAYLOAD__|__VIEW__|\/\*__CLIENT_JS__\*\//g;

export function buildSignals(payload: SalesPultPayload): SignalItem[] {
  return buildPultSignals(payload);
}

export function renderPultHtml(payload: SalesPultPayload): string {
  const view = buildPultView(payload);
  const replacements: Record<string, string> = {
    "/*__CSS__*/": pultCss,
    "__PAYLOAD__": safeJson(payload),
    "__VIEW__": safeJson(view),
    "/*__CLIENT_JS__*/": fullClientJs
  };

  return pultHtml.replace(PLACEHOLDER_RE, (match) => replacements[match] ?? match);
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

