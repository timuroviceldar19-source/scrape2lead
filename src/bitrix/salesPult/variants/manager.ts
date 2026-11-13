// Вид пульта для одного менеджера. Данные режутся до отправки в браузер: в его страницах нет
// чужих строк, а итоги отдела (плитки месяца, итоги групп) остаются как в полном пульте.
//
// Главная: своя строка, свои задачи, долги, сигналы и расхождения итогов; итоги отдела.
// «Планы»: пересобраны из его сделок. «Рынок»: целиком. «Радар»: скрыт.
// «Выручка»: пересобрана из его строк реестра; без бонуса РОП, B2B-плана отдела, сверки с порталом.

import type { PultManagerView, PultViewer, SalesPultPayload } from "../types.js";
import {
  buildPultPageView, renderPultHtmlWithView, renderRegisterHtml,
  type PultPageView, type PultView, type RegisterPagePayload
} from "../site.js";
import { buildPultSignals, formatSignals } from "../signals.js";
import { buildDepartmentCallNotes } from "../callNotes.js";
import { calculatePace, DEFAULT_HOLIDAYS } from "../pace.js";
import { escapeHtml } from "../format.js";
import { matchRegisterManager, type ContractReconciliation, type PultContractSource } from "../contracts.js";
import { buildRegisterView } from "../register/buildView.js";
import { buildPlansMonitorView } from "../plans/aggregate.js";
import type { NormalizedPlanDeal, PlansMonitorView } from "../plans/types.js";
import type {
  RegisterContract, RegisterDisciplineView, RegisterHistoryPayload, RegisterMonthSummary,
  RegisterRow, RegisterSuccessView, RegisterView
} from "../register/types.js";

export interface ManagerVariantInput {
  pult: SalesPultPayload;
  reg: RegisterPagePayload;
  /** Все сделки «Планов» (`plan-deals.json` сборки); null — «Планы» менеджеру не показываются. */
  planDeals: NormalizedPlanDeal[] | null;
  managerId: string;
  /** `register.managerAliases` из config/sales-pult.json: имя в реестре → имя в Битриксе. */
  aliases?: Record<string, string>;
}

export interface ManagerVariant {
  pult: SalesPultPayload;
  view: PultPageView;
  reg: RegisterPagePayload;
}

type RegisterSnapshot = Omit<RegisterSuccessView, "history" | "historyError">;

const PLANS_UNAVAILABLE = "Планы сейчас недоступны. Повторим при следующем обновлении.";

function managersOf(payload: SalesPultPayload): PultManagerView[] {
  return payload.groups.flatMap((g) => g.managers);
}

// ---------- главная ----------

function filterReconciliation(r: ContractReconciliation, name: string): ContractReconciliation {
  return {
    closedNotInRegister: r.closedNotInRegister.filter((x) => x.manager === name),
    possibleDuplicates: r.possibleDuplicates.filter((x) => x.manager === name)
  };
}

function filterContractSource(cs: PultContractSource, viewer: PultViewer): PultContractSource {
  // Сигналы договоров всегда начинаются с имени менеджера: «<b>Имя</b>: …».
  const prefix = `<b>${escapeHtml(viewer.name)}</b>:`;
  return {
    ...cs,
    byManager: cs.byManager.filter((m) => m.id === viewer.managerId),
    signals: cs.signals.filter((s) => s.text.startsWith(prefix)),
    reconciliation: filterReconciliation(cs.reconciliation, viewer.name)
  };
}

function filterPultPayload(p: SalesPultPayload, viewer: PultViewer): SalesPultPayload {
  const { closedMonths: _closed, plans: _plans, radar: _radar, ...rest } = p;
  return {
    ...rest,
    viewer,
    groups: p.groups.map((g) => ({ ...g, managers: g.managers.filter((m) => m.id === viewer.managerId) })),
    outcomeMismatches: (p.outcomeMismatches ?? []).filter((m) => m.managerId === viewer.managerId),
    ...(p.contractSource ? { contractSource: filterContractSource(p.contractSource, viewer) } : {}),
    radar: null
  };
}

function filterPultView(view: PultView, filtered: SalesPultPayload, full: SalesPultPayload, managerId: string): PultView {
  const ctx = calculatePace(full.asOfDate, full.generatedAt, full.holidays ? new Set(full.holidays) : DEFAULT_HOLIDAYS);
  const keep = (m: { id: string }) => m.id === managerId;
  const period = (key: "day" | "week" | "month") => {
    const pv = view.periods[key];
    return {
      ...pv,
      sales: { ...pv.sales, managers: pv.sales.managers.filter(keep) },
      calls: { ...pv.calls, anatomy: pv.calls.anatomy.filter(keep), notes: buildDepartmentCallNotes(full, key, ctx) },
      ...(pv.tenders ? { tenders: { ...pv.tenders, managers: pv.tenders.managers.filter(keep) } } : {})
    };
  };
  const { signals, signalsUrgent, signalsMeta } = formatSignals(buildPultSignals(filtered), filtered.outcomeMismatches?.length ?? 0);
  return {
    ...view,
    periods: { day: period("day"), week: period("week"), month: period("month") },
    signals: filtered.closedMonth ? [] : signals,
    signalsUrgent,
    signalsMeta
  };
}

function managerPlans(input: ManagerVariantInput): PlansMonitorView {
  const asOf = input.pult.plans?.asOf ?? input.pult.asOfDate;
  if (input.pult.plans?.error) return { asOf, error: input.pult.plans.error };
  if (!input.planDeals) return { asOf, error: PLANS_UNAVAILABLE };
  return buildPlansMonitorView(input.planDeals.filter((d) => d.managerId === input.managerId), { asOfDate: asOf });
}

// ---------- «Выручка» ----------

const stripRop = (r: RegisterRow): RegisterRow => ({ ...r, bonusRop: 0 });

function rebuildSnapshot(snapshot: RegisterSnapshot, names: ReadonlySet<string>): RegisterSnapshot {
  const rows = snapshot.rows.filter((r) => names.has(r.manager)).map(stripRop);
  const plans = Object.fromEntries(snapshot.managers.filter((m) => names.has(m.name)).map((m) => [m.name, m.plan]));
  const missing = snapshot.missing.filter((m) => names.has(m.manager));
  const view = buildRegisterView({
    rows, plans, missing: missing as unknown as RegisterContract[], extraDealsCount: 0,
    fileName: snapshot.file, asOf: snapshot.asOf, month: snapshot.month, hasValColumn: snapshot.total.hasVal
  }) as RegisterSuccessView;
  const { history: _h, historyError: _e, error: _err, ...rest } = view;
  return {
    ...rest,
    total: { ...rest.total, bonusRop: 0, b2bPlan: 0, b2bSale: 0 },
    ...(rest.partner ? { partner: { ...rest.partner, bonusRop: 0 } } : {})
  };
}

function filterMonthSummary(m: RegisterMonthSummary, names: ReadonlySet<string>): RegisterMonthSummary {
  const own = m.byManager.filter((x) => names.has(x.name));
  const sale = own.reduce((s, x) => s + x.sale, 0);
  const val = m.hasVal ? own.reduce((s, x) => s + (x.val ?? 0), 0) : null;
  const plan = own.reduce((s, x) => s + x.plan, 0);
  return {
    month: m.month, label: m.label, fileName: m.fileName, hasVal: m.hasVal,
    sale, val, margin: m.hasVal && sale > 0 && val !== null ? val / sale : null,
    contracts: own.reduce((s, x) => s + x.contracts, 0),
    plan, planPct: plan > 0 ? (sale / plan) * 100 : null,
    byManager: own,
    // Суммы по дням в сводке — по всему отделу, разбить их по людям нельзя.
    dailyContracts: [],
    ...(m.missingCrm ? { missingCrm: m.missingCrm.filter((x) => names.has(x.manager)) } : {}),
    ...(m.reconciliationPerformed !== undefined ? { reconciliationPerformed: m.reconciliationPerformed } : {})
  };
}

function filterDiscipline(d: RegisterDisciplineView, names: ReadonlySet<string>): RegisterDisciplineView {
  const lagged = d.laggedByManager.filter((x) => names.has(x.manager));
  return {
    missingWorkingDays: d.missingWorkingDays,
    laggedRowsCount: lagged.reduce((s, x) => s + x.count, 0),
    laggedByManager: lagged,
    // В правке может стоять прежний менеджер — чужое имя не показываем.
    retroChanges: d.retroChanges.filter((x) => names.has(x.manager)).map((x) => {
      if (!x.diff?.manager) return x;
      const { manager: _m, ...diff } = x.diff;
      return { ...x, diff };
    }),
    salesBelowCost: d.salesBelowCost.filter((x) => names.has(x.manager))
  };
}

function filterHistory(h: RegisterHistoryPayload, names: ReadonlySet<string>): RegisterHistoryPayload {
  return {
    ...(h.version !== undefined ? { version: h.version } : {}),
    asOf: h.asOf,
    ...(h.cachedAt ? { cachedAt: h.cachedAt } : {}),
    months: h.months.map((m) => filterMonthSummary(m, names)),
    ...(h.monthViews ? {
      monthViews: Object.fromEntries(Object.entries(h.monthViews).map(([k, v]) => [k, rebuildSnapshot(v, names)]))
    } : {}),
    ...(h.discipline ? { discipline: filterDiscipline(h.discipline, names) } : {}),
    ...(h.failedFiles ? { failedFiles: h.failedFiles } : {}),
    ...(h.error ? { error: h.error } : {})
  };
}

function filterRegisterView(view: RegisterView, names: ReadonlySet<string>): RegisterView {
  const history = view.history ? filterHistory(view.history, names) : undefined;
  if (view.error !== undefined) {
    return { error: view.error, ...(view.file ? { file: view.file } : {}), ...(view.month ? { month: view.month } : {}), ...(history ? { history } : {}) };
  }
  const { history: _h, historyError, ...snapshot } = view;
  return { ...rebuildSnapshot(snapshot, names), ...(history ? { history } : {}), ...(historyError ? { historyError } : {}) };
}

/** Имена этого менеджера в реестре ОП: по уже найденным соответствиям и по правилам сопоставления. */
function registerNamesFor(input: ManagerVariantInput, managers: PultManagerView[]): Set<string> {
  const candidates = new Set<string>();
  const add = (name: string | undefined) => { if (name) candidates.add(name); };
  const view = input.reg.register;
  type Named = { rows?: RegisterRow[]; managers?: Array<{ name: string }>; missing?: Array<{ manager: string }> };
  const snapshots: Named[] = [view as Named, ...Object.values(view.history?.monthViews ?? {})];
  for (const s of snapshots) {
    s.rows?.forEach((r) => add(r.manager));
    s.managers?.forEach((m) => add(m.name));
    s.missing?.forEach((m) => add(m.manager));
  }
  for (const m of view.history?.months ?? []) {
    m.byManager.forEach((x) => add(x.name));
    m.missingCrm?.forEach((x) => add(x.manager));
  }
  const d = view.history?.discipline;
  d?.laggedByManager.forEach((x) => add(x.manager));
  d?.retroChanges.forEach((x) => add(x.manager));
  d?.salesBelowCost.forEach((x) => add(x.manager));

  const names = new Set<string>();
  for (const name of candidates) {
    if (matchRegisterManager(name, managers, input.aliases)?.id === input.managerId) names.add(name);
  }
  const sources = [input.pult, ...Object.values(input.pult.closedMonths ?? {})];
  for (const p of sources) p?.contractSource?.byManager.forEach((m) => { if (m.id === input.managerId) names.add(m.name); });
  return names;
}

// ---------- сборка ----------

export function buildManagerVariant(input: ManagerVariantInput): ManagerVariant | null {
  const managers = managersOf(input.pult);
  const me = managers.find((m) => m.id === input.managerId);
  if (!me) return null;
  const viewer: PultViewer = { kind: "manager", managerId: me.id, name: me.name };

  const fullView = buildPultPageView(input.pult);
  const closedMonths: Record<string, SalesPultPayload | null> = {};
  const closedViews: Record<string, PultView | null> = {};
  for (const [key, closed] of Object.entries(input.pult.closedMonths ?? {})) {
    const fullClosedView = fullView.closedMonths[key];
    closedMonths[key] = closed ? filterPultPayload(closed, viewer) : null;
    closedViews[key] = closed && fullClosedView ? filterPultView(fullClosedView, closedMonths[key]!, closed, me.id) : null;
  }
  const pult: SalesPultPayload = {
    ...filterPultPayload(input.pult, viewer),
    plans: managerPlans(input),
    ...(input.pult.closedMonths ? { closedMonths } : {})
  };
  const view: PultPageView = { ...filterPultView(fullView, pult, input.pult, me.id), closedMonths: closedViews };

  const names = registerNamesFor(input, managers);
  const reg: RegisterPagePayload = {
    ...input.reg,
    viewer,
    register: filterRegisterView(input.reg.register, names),
    ...(input.reg.reconciliation ? { reconciliation: filterReconciliation(input.reg.reconciliation, me.name) } : {})
  };
  return { pult, view, reg };
}

export function renderManagerVariant(variant: ManagerVariant): { index: string; reg: string } {
  return { index: renderPultHtmlWithView(variant.pult, variant.view), reg: renderRegisterHtml(variant.reg) };
}
