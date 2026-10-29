import type {
  SalesPultPayload, PaceContext, PultGroupView, PultManagerView, PultView,
  PultMonthView, PultPeriodView, PultSalesDepartmentView, PultCallsDepartmentView,
  PultTendersDepartmentView, PultSalesManagerView, PultTenderManagerView,
  PultAnatomyRowView
} from "./types.js";
import {
  DOW, MONTHS_GEN, formatMoney, formatPultMoney, fmtNumber, fmtNumber1,
  fmtNumberNbsp, pluralNbsp, initials
} from "./format.js";
import {
  calculatePace, calculateMonthForecast, judgeMetricStatus, isWorkDay,
  DEFAULT_HOLIDAYS, computeGroupTotals, getTarget, type GroupTotals
} from "./pace.js";
import { buildPultSignals, formatSignals } from "./signals.js";
import { buildCallNotes } from "./callNotes.js";

export { computeGroupTotals, getTarget, type GroupTotals };

function buildSplit(combinedGroups: PultGroupView[]) {
  const split = combinedGroups.map((g) => {
    const t = computeGroupTotals(g, "month");
    const name = g.id === "sales" ? "Продажи" : g.id === "tenders" ? "Тендеры" : g.name;
    return { name, c: t.contracts, a: t.amount, amountFormatted: formatMoney(t.amount) || "—" };
  });
  const maxC = Math.max(1, ...split.map((x) => x.c));
  return split.map((x) => ({ ...x, widthPct: (x.c / maxC) * 100 }));
}

function buildByDayAndWeekends(
  daysInMonth: number, year: number, month: number, holidays: Set<string>,
  byDayMap: Map<number, { calls: number; contracts: number; amount: number }>
) {
  const byDayList = [];
  const weekends = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (!isWorkDay(year, month, d, holidays)) weekends.push(d);
    const x = byDayMap.get(d);
    byDayList.push({ day: d, calls: x ? x.calls : 0, contracts: x ? x.contracts : 0, amount: x ? x.amount : 0 });
  }
  return { byDayList, weekends };
}

export function buildMonthView(
  payload: SalesPultPayload, ctx: PaceContext, combinedGroups: PultGroupView[]
): PultMonthView {
  const [Y, M, D] = payload.asOfDate.split("-").map(Number);
  const holidays = payload.holidays ? new Set(payload.holidays) : DEFAULT_HOLIDAYS;

  const targetMonthlyContracts = getTarget(payload.targets, "month", "contracts");
  const monthPlan = combinedGroups.reduce(
    (s, g) => s + targetMonthlyContracts * g.managers.filter((m) => m.active).length, 0
  );
  const monthFact = combinedGroups.reduce((s, g) => s + computeGroupTotals(g, "month").contracts, 0);
  const monthAmount = combinedGroups.reduce((s, g) => s + computeGroupTotals(g, "month").amount, 0);
  const forecastRes = calculateMonthForecast(monthPlan, monthFact, ctx.monthDone, ctx.monthTotal);

  const byDayMap = new Map(payload.dynamics.map((d) => [Number(d.date.slice(8, 10)), d]));
  const cum: number[] = [0];
  let cumSum = 0;
  for (let d = 1; d <= D; d++) {
    cumSum += byDayMap.get(d)?.contracts || 0;
    cum.push(cumSum);
  }

  const { byDayList, weekends } = buildByDayAndWeekends(ctx.daysInMonth, Y, M, holidays, byDayMap);

  return {
    plan: monthPlan, fact: monthFact, amount: monthAmount,
    pacePerDay: forecastRes.pacePerDay, forecast: forecastRes.forecast,
    left: forecastRes.left, daysLeft: forecastRes.daysLeft,
    pct: forecastRes.pct, fpct: forecastRes.fpct,
    hasForecast: forecastRes.hasForecast,
    monthDone: ctx.monthDone, monthTotal: ctx.monthTotal, wdBefore: ctx.wdBefore,
    daysInMonth: ctx.daysInMonth, targetContracts: targetMonthlyContracts,
    totalActiveCount: combinedGroups.reduce((s, g) => s + g.managers.filter((m) => m.active).length, 0),
    verdict: forecastRes.verdict, split: buildSplit(combinedGroups),
    points: cum, byDay: byDayList, workDays: ctx.workDays, weekends,
    nowXDay: D - 1 + ctx.dayFrac, dayFrac: ctx.dayFrac,
    asOfDate: payload.asOfDate, asOfDay: D, asOfMonth: M, asOfYear: Y
  };
}

function buildSalesManager(
  m: PultManagerView, period: "day" | "week" | "month", isEarly: boolean,
  ctx: PaceContext, payload: SalesPultPayload
): PultSalesManagerView {
  const r = m.rollups[period];
  const targetCalls = getTarget(payload.targets, period, "calls");
  const targetKp = getTarget(payload.targets, period, "proposals");
  const targetContracts = getTarget(payload.targets, period, "contracts");

  const mjc = judgeMetricStatus(r.calls.successful, targetCalls, period, "calls", ctx);
  const mjk = judgeMetricStatus(r.proposals.uniqueDealsCount, targetKp, period, "proposals", ctx);
  const mjg = judgeMetricStatus(r.contracts.uniqueDealsCount, targetContracts, period, "contracts", ctx);

  const mCallsSub = r.calls.totalAttempts
    ? `набрал ${fmtNumberNbsp(r.calls.totalAttempts)} · ${fmtNumberNbsp(r.calls.durationMinutes)} мин`
    : "пока не звонил";
  const mContractsSub = r.contracts.uniqueDealsCount ? (formatPultMoney(r.contracts.totalAmount) || "сумма не указана") : "";
  const tasksCount = (m.topTasks || []).length;
  const tasksCountText = tasksCount ? pluralNbsp(tasksCount, ["срочная задача", "срочные задачи", "срочных задач"]) : "срочных задач нет";

  return {
    id: m.id, name: m.name, initials: initials(m.name), tasksCountText,
    calls: {
      fact: r.calls.successful, target: targetCalls, expected: mjc.expected,
      cls: mjc.cls, label: mjc.text, text: mjc.text, sub: mCallsSub,
      totalAttempts: r.calls.totalAttempts, durationMinutes: r.calls.durationMinutes,
      hasBitrixCalls: r.calls.totalAttempts > 0,
      noCallsFlag: r.calls.totalAttempts === 0 && !(period === "day" && ctx.isEarly),
      isEarlyEmpty: isEarly && r.calls.successful === 0
    },
    proposals: {
      fact: r.proposals.uniqueDealsCount, target: targetKp, expected: mjk.expected,
      cls: mjk.cls, label: mjk.text, text: mjk.text, untracked: !payload.proposalsTracked,
      isEarlyEmpty: isEarly && r.proposals.uniqueDealsCount === 0
    },
    contracts: {
      fact: r.contracts.uniqueDealsCount, target: targetContracts, expected: mjg.expected,
      cls: mjg.cls, label: mjg.text, text: mjg.text, sub: mContractsSub,
      totalAmount: r.contracts.totalAmount, isEarlyEmpty: isEarly && r.contracts.uniqueDealsCount === 0
    },
    debts: m.debts, topTasks: m.topTasks || []
  };
}

export function buildSalesView(
  payload: SalesPultPayload, sales: PultGroupView, salesActive: PultManagerView[],
  period: "day" | "week" | "month", periodLabel: string, isEarly: boolean,
  yesterdayLine: string, ctx: PaceContext
): PultSalesDepartmentView {
  const sTotals = computeGroupTotals(sales, period);
  const sActiveCount = salesActive.length || 1;
  const tc = getTarget(payload.targets, period, "calls") * sActiveCount;
  const tk = getTarget(payload.targets, period, "proposals") * sActiveCount;
  const tg = getTarget(payload.targets, period, "contracts") * sActiveCount;

  const jc = judgeMetricStatus(sTotals.calls, tc, period, "calls", ctx);
  const callsSub = !payload.callsAvailable
    ? "Звонки сейчас не загружаются"
    : sTotals.attempts
      ? `Набрали ${pluralNbsp(sTotals.attempts, ["раз", "раза", "раз"])}, проговорили ${fmtNumberNbsp(sTotals.minutes)} мин`
      : isEarly ? yesterdayLine : "Звонков через Битрикс нет";

  const jk = !payload.proposalsTracked
    ? { cls: "idle" as const, text: "В CRM пока не отмечают", expected: 0 }
    : judgeMetricStatus(sTotals.kp, tk, period, "proposals", ctx);
  const kpSub = !payload.proposalsTracked
    ? `Отмечено ${pluralNbsp(sTotals.kp, ["КП", "КП", "КП"])}. Менеджеры не переводят сделки в стадию «КП отправлено», поэтому цифра занижена`
    : `Норма ${getTarget(payload.targets, period, "proposals")} на менеджера`;

  const jg = judgeMetricStatus(sTotals.contracts, tg, period, "contracts", ctx);
  const contractsSub = sTotals.contracts ? `На ${formatPultMoney(sTotals.amount) || "сумму, которая не указана"}` : "Пока ни одного";
  const salesMeta = `${pluralNbsp(salesActive.length, ["менеджер", "менеджера", "менеджеров"])} · норма на человека: ${pluralNbsp(getTarget(payload.targets, period, "calls"), ["дозвон", "дозвона", "дозвонов"])}, ${getTarget(payload.targets, period, "proposals")} КП, ${pluralNbsp(getTarget(payload.targets, period, "contracts"), ["договор", "договора", "договоров"])}`;

  const managers = salesActive.map((m) => buildSalesManager(m, period, isEarly, ctx, payload));
  const sortWeight: Record<string, number> = { bad: 0, warn: 1, idle: 2, good: 3 };
  managers.sort((a, b) => (sortWeight[a.calls.cls] ?? 2) - (sortWeight[b.calls.cls] ?? 2) || (a.calls.fact - b.calls.fact));

  return {
    name: sales.name, periodName: periodLabel, meta: salesMeta, isEarly,
    earlyText: "Рабочий день ещё не начался: звонки и договоры за сегодня появятся после 09:00. Долги справа уже на сегодня.",
    totals: {
      calls: { fact: sTotals.calls, target: tc, expected: jc.expected, cls: jc.cls, label: jc.text, text: jc.text, sub: callsSub },
      proposals: { fact: sTotals.kp, target: tk, expected: jk.expected, cls: jk.cls, label: jk.text, text: jk.text, sub: kpSub, untracked: !payload.proposalsTracked },
      contracts: { fact: sTotals.contracts, target: tg, expected: jg.expected, cls: jg.cls, label: jg.text, text: jg.text, sub: contractsSub, totalAmount: sTotals.amount },
      attempts: sTotals.attempts, minutes: sTotals.minutes
    },
    managers, activeCount: salesActive.length
  };
}

function buildAnatomyRow(
  m: PultManagerView, period: "day" | "week" | "month",
  scale: number, tgtCalls: number, ctx: PaceContext
): PultAnatomyRowView {
  const c = m.rollups[period].calls;
  return {
    id: m.id, name: m.name, initials: initials(m.name),
    successful: c.successful, totalAttempts: c.totalAttempts, durationMinutes: c.durationMinutes,
    okPct: (c.successful / scale) * 100,
    missPct: ((c.totalAttempts - c.successful) / scale) * 100,
    tgtPct: (tgtCalls / scale) * 100,
    convStr: c.totalAttempts ? `${Math.round((c.successful / c.totalAttempts) * 100)}%` : "—",
    avgStr: c.successful ? `${fmtNumber1(c.durationMinutes / c.successful)} мин` : "—",
    isEarlyEmpty: period === "day" && ctx.isEarly
  };
}

export function buildCallsView(
  payload: SalesPultPayload, salesActive: PultManagerView[], sTotals: GroupTotals,
  period: "day" | "week" | "month", periodLabel: string, ctx: PaceContext
): PultCallsDepartmentView {
  const conv = sTotals.attempts ? Math.round((sTotals.calls / sTotals.attempts) * 100) : 0;
  const avg = sTotals.calls ? sTotals.minutes / sTotals.calls : 0;
  const days = period === "day" ? 1 : period === "week"
    ? Math.max(1, ctx.weekBefore + (ctx.dayFrac > 0 ? 1 : 0))
    : Math.max(1, ctx.wdBefore + (ctx.dayFrac > 0 ? 1 : 0));
  const perDay = sTotals.calls / days;
  const norm = payload.targets.daily.calls * (salesActive.length || 1);

  const tgtCalls = getTarget(payload.targets, period, "calls");
  const scale = Math.max(tgtCalls, ...salesActive.map((m) => m.rollups[period].calls.totalAttempts)) * 1.04;
  const sortedByAttempts = [...salesActive].sort(
    (a, b) => b.rollups[period].calls.totalAttempts - a.rollups[period].calls.totalAttempts
  );
  const anatomy = sortedByAttempts.map((m) => buildAnatomyRow(m, period, scale, tgtCalls, ctx));

  return {
    periodName: periodLabel,
    meta: payload.callsAvailable ? "телефония Битрикс24 · дозвон = разговор состоялся" : "телефония сейчас недоступна",
    strip: {
      calls: sTotals.calls, attempts: sTotals.attempts, conv, avg,
      normLabel: period === "day" ? "Норма на день" : "Дозвонов в день",
      normValue: period === "day" ? fmtNumber(norm) : fmtNumber1(perDay),
      normSub: period === "day" ? "" : `при норме ${fmtNumber(norm)}`,
      norm
    },
    notes: buildCallNotes(payload, period, ctx),
    anatomy
  };
}

function buildTenderManager(
  m: PultManagerView, period: "day" | "week" | "month",
  ctx: PaceContext, payload: SalesPultPayload
): PultTenderManagerView {
  const r = m.rollups[period];
  const targetContracts = getTarget(payload.targets, period, "contracts");
  const tmJudge = judgeMetricStatus(r.contracts.uniqueDealsCount, targetContracts, period, "contracts", ctx);
  const sub = r.contracts.uniqueDealsCount ? (formatPultMoney(r.contracts.totalAmount) || "сумма не указана") : "";
  return {
    id: m.id, name: m.name, initials: initials(m.name),
    contracts: {
      fact: r.contracts.uniqueDealsCount, target: targetContracts,
      expected: tmJudge.expected, cls: tmJudge.cls, label: tmJudge.text, text: tmJudge.text,
      sub, totalAmount: r.contracts.totalAmount,
      isEarlyEmpty: period === "day" && ctx.isEarly && r.contracts.uniqueDealsCount === 0
    },
    debts: m.debts, topTasks: m.topTasks || []
  };
}

export function buildTendersView(
  payload: SalesPultPayload, tenders: PultGroupView, tendersActive: PultManagerView[],
  period: "day" | "week" | "month", periodLabel: string, ctx: PaceContext
): PultTendersDepartmentView {
  const tTotals = computeGroupTotals(tenders, period);
  const tActiveCount = tendersActive.length || 1;
  const tTarget = getTarget(payload.targets, period, "contracts") * tActiveCount;
  const tJudge = judgeMetricStatus(tTotals.contracts, tTarget, period, "contracts", ctx);
  const tSub = tTotals.contracts ? `На ${formatPultMoney(tTotals.amount) || "сумму, которая не указана"}` : "Пока ни одного";

  const managers = tendersActive.map((m) => buildTenderManager(m, period, ctx, payload));
  managers.sort((a, b) => b.contracts.fact - a.contracts.fact);

  return {
    name: tenders.name, periodName: periodLabel,
    meta: `${pluralNbsp(tendersActive.length, ["специалист", "специалиста", "специалистов"])} · только договоры`,
    totals: {
      contracts: {
        fact: tTotals.contracts, target: tTarget, expected: tJudge.expected,
        cls: tJudge.cls, label: tJudge.text, text: tJudge.text,
        sub: tSub, totalAmount: tTotals.amount
      }
    },
    managers, activeCount: tendersActive.length
  };
}

export function buildPeriodView(
  payload: SalesPultPayload, sales: PultGroupView, tenders: PultGroupView | undefined,
  salesActive: PultManagerView[], tendersActive: PultManagerView[],
  period: "day" | "week" | "month", yesterdayLine: string, ctx: PaceContext
): PultPeriodView {
  const periodLabel = period === "day" ? "сегодня" : period === "week" ? "за неделю" : "за месяц";
  const isEarly = period === "day" && ctx.isEarly;
  const sTotals = computeGroupTotals(sales, period);

  const salesView = buildSalesView(payload, sales, salesActive, period, periodLabel, isEarly, yesterdayLine, ctx);
  const callsView = buildCallsView(payload, salesActive, sTotals, period, periodLabel, ctx);
  const tendersView = tenders ? buildTendersView(payload, tenders, tendersActive, period, periodLabel, ctx) : undefined;

  return {
    period, periodName: periodLabel, isEarly, yesterdayLine,
    sales: salesView, calls: callsView, tenders: tendersView
  };
}

export function buildPultView(payload: SalesPultPayload): PultView {
  const holidays = payload.holidays ? new Set(payload.holidays) : DEFAULT_HOLIDAYS;
  const ctx = calculatePace(payload.asOfDate, payload.generatedAt, holidays);

  const [Y, M, D] = payload.asOfDate.split("-").map(Number);
  const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
  const dateLabel = `${DOW[dow]}, ${D} ${MONTHS_GEN[M - 1]} ${Y}`;
  const passedWd = Math.floor(ctx.monthDone);
  const wdLabel = `Рабочих дней прошло ${passedWd} из ${ctx.monthTotal}`;
  const monthFillPct = (ctx.monthDone / ctx.monthTotal) * 100;

  const { signals, signalsUrgent, signalsMeta } = formatSignals(buildPultSignals(payload));

  const sales = payload.groups.find((g) => g.id === "sales") || payload.groups[0];
  const tenders = payload.groups.find((g) => g.id === "tenders");
  const salesActive = sales ? sales.managers.filter((m) => m.active) : [];
  const tendersActive = tenders ? tenders.managers.filter((m) => m.active) : [];
  const combinedGroups = [sales, tenders].filter((g): g is PultGroupView => Boolean(g));

  const monthView = buildMonthView(payload, ctx, combinedGroups);

  const prev = [...payload.dynamics].reverse().find((d) => d.date < payload.asOfDate && (d.calls || d.contracts));
  let yesterdayLine = "";
  if (prev) {
    const dd = Number(prev.date.slice(8, 10));
    yesterdayLine = `В прошлый рабочий день, ${dd} ${MONTHS_GEN[M - 1]}: ${pluralNbsp(prev.calls, ["дозвон", "дозвона", "дозвонов"])}, ${pluralNbsp(prev.contracts, ["договор", "договора", "договоров"])}${prev.amount ? " на " + formatPultMoney(prev.amount) : ""}.`;
  }

  const dayView = buildPeriodView(payload, sales, tenders, salesActive, tendersActive, "day", yesterdayLine, ctx);
  const weekView = buildPeriodView(payload, sales, tenders, salesActive, tendersActive, "week", yesterdayLine, ctx);
  const monthPeriodView = buildPeriodView(payload, sales, tenders, salesActive, tendersActive, "month", yesterdayLine, ctx);

  return {
    signals, signalsUrgent, signalsMeta,
    month: monthView,
    periods: { day: dayView, week: weekView, month: monthPeriodView },
    dateLabel, wdLabel, monthFillPct, todayIsWork: ctx.todayIsWork,
    genLabel: ctx.genLabel, genHour: ctx.genHour
  };
}
