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

export function buildSignals(payload: SalesPultPayload): SignalItem[] {
  return buildPultSignals(payload);
}

export function renderPultHtml(payload: SalesPultPayload): string {
  const view = buildPultView(payload);
  const jsonPayload = safeJson(payload);
  const jsonView = safeJson(view);

  return pultHtml
    .replace("/*__CSS__*/", () => pultCss)
    .replace("__PAYLOAD__", () => jsonPayload)
    .replace("__VIEW__", () => jsonView)
    .replace("/*__CLIENT_JS__*/", () => pultClientJs);
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

