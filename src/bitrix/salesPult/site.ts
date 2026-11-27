import { buildFinanceInsights } from "./finance/insights.js";
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
import type { FinanceView } from "./finance/types.js";
import type { OpiuView } from "./finance/opiuTypes.js";

const pultHtml = fs.readFileSync(new URL("./page/pult.html", import.meta.url), "utf8");
const regHtml = fs.readFileSync(new URL("./page/reg.html", import.meta.url), "utf8");
const finHtml = fs.readFileSync(new URL("./page/fin.html", import.meta.url), "utf8");
const finCss = fs.readFileSync(new URL("./page/fin.css", import.meta.url), "utf8");
const finClientJs = fs.readFileSync(new URL("./page/fin.client.js", import.meta.url), "utf8");
const finReportsHtml = fs.readFileSync(new URL("./page/fin-reports.html", import.meta.url), "utf8");
const finReportsCss = fs.readFileSync(new URL("./page/fin-reports.css", import.meta.url), "utf8");
const finReportsClientJs = fs.readFileSync(new URL("./page/fin-reports.client.js", import.meta.url), "utf8");
const pultCss = fs.readFileSync(new URL("./page/pult.css", import.meta.url), "utf8");
const pultClientJs = fs.readFileSync(new URL("./page/pult.client.js", import.meta.url), "utf8");
const registerClientJs = fs.readFileSync(new URL("./page/register.client.js", import.meta.url), "utf8");
const regRunnerClientJs = fs.readFileSync(new URL("./page/reg.client.js", import.meta.url), "utf8");
const marketClientJs = fs.readFileSync(new URL("./page/market.client.js", import.meta.url), "utf8");

const plansClientJs = fs.readFileSync(new URL("./page/plans.client.js", import.meta.url), "utf8");
const radarClientJs = fs.readFileSync(new URL("./page/radar.client.js", import.meta.url), "utf8");
const competitorsClientJs = fs.readFileSync(new URL("./page/competitors.client.js", import.meta.url), "utf8");
const stockClientJs = fs.readFileSync(new URL("./page/stock.client.js", import.meta.url), "utf8");
const pultPageClientJs = `${marketClientJs}\n${stockClientJs}\n${plansClientJs}\n${radarClientJs}\n${competitorsClientJs}\n${pultClientJs}`;
const regPageClientJs = `${registerClientJs}\n${regRunnerClientJs}`;

const PLACEHOLDER_RE = /\/\*__CSS__\*\/|__PAYLOAD__|__VIEW__|__INSIGHTS__|\/\*__CLIENT_JS__\*\//g;

export interface RegisterPagePayload {
  viewer?: import("./types.js").PultViewer;
  reconciliation?: import("./contracts.js").ContractReconciliation;
  asOfDate: string;
  generatedAt: string;
  portal?: string;
  pultUrl?: string;
  register: RegisterView;
}

/** Страница «Финансы»: только полный вариант пульта, менеджеру и на ТВ не собирается. */
export interface FinancePagePayload {
  asOfDate: string;
  generatedAt: string;
  finance: FinanceView;
  /** Спрос открытых лотов и планов по строкам склада: строка «спрос: …» у позиций без расхода. */
  stockDemand?: import("./stock/availability.js").StockDemandRow[];
}

/** Страница «Фин. отчёты» (ОПиУ): только полный вариант пульта, скрыта от РОП, РТО, менеджеров и ТВ. */
export interface FinReportsPagePayload {
  asOfDate: string;
  generatedAt: string;
  opiu: OpiuView;
}

export function buildSignals(payload: SalesPultPayload): SignalItem[] {
  return buildPultSignals(payload);
}

export type PultPageView = PultView & { closedMonths: Record<string, PultView | null> };

/** Представление главной вместе с закрытыми месяцами — то, что страница получает как VIEW. */
export function buildPultPageView(payload: SalesPultPayload): PultPageView {
  return { ...buildPultView(payload), closedMonths: Object.fromEntries(
    Object.entries(payload.closedMonths || {}).map(([key, month]) => [key, month ? buildPultView(month) : null])
  ) };
}

export function renderPultHtml(payload: SalesPultPayload): string {
  const safePayload = { ...payload };
  if ("register" in safePayload) {
    delete (safePayload as Record<string, unknown>).register;
  }
  return renderPultHtmlWithView(safePayload, buildPultPageView(safePayload));
}

/** Страница из готового представления: вариант роли считает его сам из полного пульта. */
export function renderPultHtmlWithView(payload: SalesPultPayload, view: PultPageView): string {
  const safePayload = { ...payload };
  if ("register" in safePayload) {
    delete (safePayload as Record<string, unknown>).register;
  }
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

export function renderFinanceHtml(payload: FinancePagePayload): string {
  // ОПиУ живёт на отдельной странице fin-reports.html — в fin.html его не встраиваем.
  const { opiu: _opiu, ...financeWithoutOpiu } = payload.finance;
  const safePayload: FinancePagePayload = { ...payload, finance: financeWithoutOpiu };
  const replacements: Record<string, string> = {
    "/*__CSS__*/": `${pultCss}\n${finCss}`,
    "__PAYLOAD__": safeJson(safePayload),
    "__INSIGHTS__": safeJson(buildFinanceInsights(safePayload.finance, safePayload.asOfDate)),
    "/*__CLIENT_JS__*/": finClientJs
  };

  return finHtml.replace(PLACEHOLDER_RE, (match) => replacements[match] ?? match);
}

export function renderFinReportsHtml(payload: FinReportsPagePayload): string {
  // Не дублируем первый отчёт в JSON, если уже передан массив reports (экономия ~1 МБ в HTML).
  const opiu = payload.opiu?.reports?.length
    ? (({ report: _dup, ...rest }) => rest)(payload.opiu)
    : payload.opiu;
  const safePayload: FinReportsPagePayload = { ...payload, opiu };
  const replacements: Record<string, string> = {
    "/*__CSS__*/": `${pultCss}\n${finCss}\n${finReportsCss}`,
    "__PAYLOAD__": safeJson(safePayload),
    "/*__CLIENT_JS__*/": finReportsClientJs
  };

  return finReportsHtml.replace(PLACEHOLDER_RE, (match) => replacements[match] ?? match);
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

