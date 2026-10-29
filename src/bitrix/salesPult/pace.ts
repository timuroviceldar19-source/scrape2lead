import type { ManagerRollups, TopTask, TargetsConfig } from "./metrics.js";
import type { ManagerDebts } from "./debts.js";

export interface PultManagerView {
  id: string;
  name: string;
  active: boolean;
  rollups: ManagerRollups;
  topTasks: TopTask[];
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

export const DEFAULT_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-02", "2026-01-07", "2026-03-08", "2026-03-21",
  "2026-03-22", "2026-03-23", "2026-03-24", "2026-03-25", "2026-05-01",
  "2026-05-07", "2026-05-09", "2026-07-06", "2026-08-30", "2026-10-25",
  "2026-10-26", "2026-12-16"
]);

export const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря"
];

export const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
];

export const DOW = [
  "воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"
];

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

export function isWorkDay(
  year: number,
  month: number,
  day: number,
  holidays: Set<string> = DEFAULT_HOLIDAYS
): boolean {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const dt = new Date(Date.UTC(year, month - 1, day));
  const dow = dt.getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(iso);
}

export function getMonthWorkDays(
  year: number,
  month: number,
  holidays: Set<string> = DEFAULT_HOLIDAYS
): number[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const workDays: number[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (isWorkDay(year, month, d, holidays)) {
      workDays.push(d);
    }
  }
  return workDays;
}

export function parseGenHour(generatedAt: string): { genHour: number; genLabel: string } {
  const match = /(\d{2}):(\d{2})/.exec(generatedAt);
  if (!match) {
    return { genHour: 12, genLabel: "12:00" };
  }
  return {
    genHour: Number(match[1]) + Number(match[2]) / 60,
    genLabel: `${match[1]}:${match[2]}`
  };
}

export function calculatePace(
  asOfDate: string,
  generatedAt: string,
  customHolidays?: Set<string> | string[]
): PaceContext {
  const holidays = customHolidays
    ? (customHolidays instanceof Set ? customHolidays : new Set(customHolidays))
    : DEFAULT_HOLIDAYS;

  const [Y, M, D] = asOfDate.split("-").map(Number);
  const { genHour, genLabel } = parseGenHour(generatedAt);

  const daysInMonth = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const workDays = getMonthWorkDays(Y, M, holidays);
  const todayIsWork = isWorkDay(Y, M, D, holidays);
  const dayFrac = !todayIsWork ? 0 : Math.max(0, Math.min(1, (genHour - 9) / 9));
  const wdBefore = workDays.filter((d) => d < D).length;
  const monthDone = wdBefore + dayFrac;
  const monthTotal = workDays.length;

  const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay() || 7;
  const weekDays: Date[] = [];
  for (let i = 1; i <= 7; i++) {
    weekDays.push(new Date(Date.UTC(Y, M - 1, D - dow + i)));
  }
  const weekWork = weekDays.filter((dt) =>
    isWorkDay(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), holidays)
  );
  const weekBefore = weekWork.filter(
    (dt) => dt.getUTCDate() < D || dt.getUTCMonth() + 1 < M
  ).length;

  const isEarly = todayIsWork && genHour < 10;

  return {
    year: Y,
    month: M,
    day: D,
    genHour,
    genLabel,
    isEarly,
    todayIsWork,
    dayFrac,
    daysInMonth,
    workDays,
    wdBefore,
    monthDone,
    monthTotal,
    weekWork,
    weekBefore,
    pace: {
      day: todayIsWork ? dayFrac : 0,
      week: weekWork.length ? (weekBefore + dayFrac) / weekWork.length : 0,
      month: monthTotal ? monthDone / monthTotal : 0
    }
  };
}

export interface MetricJudgeResult {
  cls: "good" | "warn" | "bad" | "idle";
  text: string;
  expected: number;
}

export function judgeMetricStatus(
  fact: number,
  target: number,
  period: "day" | "week" | "month",
  metric?: "calls" | "proposals" | "contracts" | string,
  paceContext?: PaceContext
): MetricJudgeResult {
  const lumpy = period === "day" && metric !== undefined && metric !== "calls";
  const pace = lumpy || !paceContext ? 0 : paceContext.pace[period];
  const expected = target * pace;

  if (period === "day" && paceContext?.isEarly && fact === 0) {
    return { cls: "idle", text: "День начнётся в 09:00", expected: 0 };
  }
  if (fact >= target) {
    return { cls: "good", text: "План выполнен", expected };
  }
  if (lumpy) {
    return {
      cls: "idle",
      text: fact ? `До нормы дня ещё ${fmtNumber(target - fact)}` : "Сегодня пока ни одного",
      expected: 0
    };
  }
  if (expected < 0.5) {
    return { cls: "idle", text: "Рано судить", expected };
  }
  const ratio = fact / expected;
  if (ratio >= 1) {
    return { cls: "good", text: "Идём в темпе", expected };
  }
  const gap = Math.round(expected - fact);
  if (ratio >= 0.8) {
    return { cls: "warn", text: `Чуть отстаём, на ${fmtNumber(gap)}`, expected };
  }
  return { cls: "bad", text: `Отстаём от темпа на ${fmtNumber(gap)}`, expected };
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

export function calculateMonthForecast(
  plan: number,
  fact: number,
  monthDone: number,
  monthTotal: number
): MonthForecastResult {
  const pacePerDay = monthDone > 0 ? fact / monthDone : 0;
  const daysLeft = Math.max(0, monthTotal - monthDone);
  const forecast = Math.round(fact + pacePerDay * daysLeft);
  const left = Math.max(0, plan - fact);
  const need = daysLeft > 0 ? left / daysLeft : 0;
  const pct = plan ? Math.round((fact / plan) * 100) : 0;
  const fpct = plan ? Math.round((forecast / plan) * 100) : 0;

  let verdict: string;
  if (fact >= plan) {
    verdict = "План месяца <b>выполнен</b>. Всё, что подпишем дальше, сверху.";
  } else if (forecast >= plan) {
    verdict = `Идём в темпе: при нынешней скорости к концу месяца будет <b>≈ ${fmtNumber(forecast)}</b>, план закроем.`;
  } else {
    verdict = `При нынешнем темпе к концу месяца будет <b>≈ ${fmtNumber(forecast)} из ${fmtNumber(plan)}</b>, это ${fpct}% плана. Чтобы закрыть план, нужно <b>${fmtNumber1(need)} в день</b> вместо ${fmtNumber1(pacePerDay)}.`;
  }

  return {
    pacePerDay,
    daysLeft,
    forecast,
    left,
    need,
    pct,
    fpct,
    verdict
  };
}

export interface SignalItem {
  color: "red" | "yellow" | "green" | "gray";
  text: string;
}

export interface DebtLine {
  color: "red" | "yellow" | "gray";
  text: string;
}

export function formatDebtLines(debts: ManagerDebts | undefined): DebtLine[] {
  if (!debts) return [];
  const lines: DebtLine[] = [];
  if (debts.overdue > 0) {
    const parts = [`просрочено ${debts.overdue}`];
    if (debts.overdueOverMonth > 0) parts.push(`больше месяца ${debts.overdueOverMonth}`);
    lines.push({ color: "red", text: parts.join(" · ") });
  }
  if (debts.newDeals > 0) {
    const oldest = debts.newOldestAgeDays >= 1 ? ` (самой старой ${pluralDays(debts.newOldestAgeDays)})` : "";
    lines.push({ color: "yellow", text: `новых без звонка ${debts.newDeals}${oldest}` });
  }
  if (debts.readyToCloseDealIds && debts.readyToCloseDealIds.length > 0) {
    lines.push({ color: "gray", text: `пора закрыть ${debts.readyToCloseDealIds.length}` });
  }
  return lines;
}

export function getAlmatyHour(generatedAt: string): number {
  return Math.floor(parseGenHour(generatedAt).genHour);
}

function parseBitrixDate(str: string): number {
  let s = str.trim();
  if (s && !/[Z+-]\d{2}(?::?\d{2})?$/i.test(s)) {
    if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(s)) {
      s = s.replace(" ", "T") + "+03:00";
    }
  }
  return Date.parse(s);
}

export function formatTaskDeadline(deadlineStr?: string | null): string {
  if (!deadlineStr) return "";
  const ms = parseBitrixDate(deadlineStr);
  if (Number.isNaN(ms)) {
    return `до ${deadlineStr}`;
  }

  const shifted = new Date(ms + 5 * 3600000);
  const iso = shifted.toISOString();
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 16);

  const [, m, d] = datePart.split("-");
  const monthName = MONTHS_GEN[parseInt(m, 10) - 1] || m;
  const dayNum = parseInt(d, 10);

  const hasTime = deadlineStr.includes(":") || timePart !== "00:00";
  if (hasTime) {
    return `до ${dayNum} ${monthName}, ${timePart}`;
  }
  return `до ${dayNum} ${monthName}`;
}

export function formatOverdue(deadlineStr: string, asOfDate: string): string {
  if (!deadlineStr) return "";
  const ms = parseBitrixDate(deadlineStr);
  let deadlineAlmatyDate = "";
  if (!Number.isNaN(ms)) {
    deadlineAlmatyDate = new Date(ms + 5 * 3600000).toISOString().slice(0, 10);
  } else {
    deadlineAlmatyDate = deadlineStr.slice(0, 10);
  }

  const diffMs = new Date(asOfDate).getTime() - new Date(deadlineAlmatyDate).getTime();
  const diffDays = Math.round(diffMs / 86400000);

  if (diffDays <= 0) {
    return "просрочено сегодня";
  }
  return `просрочено на ${pluralDays(diffDays)}`;
}

export function formatTaskLine(
  task: {
    subject?: string;
    title: string;
    amount?: number;
    deadline?: string;
    isOverdue?: boolean;
    kind?: string;
    ageDays?: number;
  },
  asOfDate: string
): string {
  let statusText = "";
  if (task.kind === "new") {
    const age = Math.floor(task.ageDays || 0);
    statusText = age >= 1 ? `новая, без звонка ${pluralDays(age)}` : "новая, без звонка сегодня";
  } else if (task.isOverdue && task.deadline) {
    statusText = formatOverdue(task.deadline, asOfDate);
  } else if (task.deadline) {
    statusText = formatTaskDeadline(task.deadline);
  }
  const parts = [task.subject?.trim(), task.title, formatMoney(task.amount || 0), statusText];
  return parts.filter(Boolean).join(" · ");
}

export function formatUpdatedTime(generatedAt: string): string {
  const match = /(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/.exec(generatedAt);
  if (match) {
    const [, , m, d, hh, mm] = match;
    const months = [
      "января", "февраля", "марта", "апреля", "мая", "июня",
      "июля", "августа", "сентября", "октября", "ноября", "декабря"
    ];
    const monthName = months[parseInt(m, 10) - 1] || m;
    const dayNum = parseInt(d, 10);
    return `Обновлено ${dayNum} ${monthName} в ${hh}:${mm}`;
  }
  return `Обновлено ${generatedAt}`;
}

export function buildPultSignals(payload: SalesPultPayload, paceContext?: PaceContext): SignalItem[] {
  const holidays = payload.holidays ? new Set(payload.holidays) : DEFAULT_HOLIDAYS;
  const ctx = paceContext || calculatePace(payload.asOfDate, payload.generatedAt, holidays);

  const bad: string[] = [];
  const warn: string[] = [];
  const good: string[] = [];
  const info: string[] = [];

  const sales = payload.groups.find((g) => g.id === "sales");
  const activeSales = sales ? sales.managers.filter((m) => m.active) : [];

  if (payload.callsAvailable && !ctx.isEarly && ctx.genHour >= 11) {
    const zero = activeSales
      .filter((m) => m.rollups.signals?.zeroBitrixCallsToday)
      .map((m) => `<b>${escapeHtml(cleanFirstName(m.name))}</b>`);
    if (zero.length > 0) {
      bad.push(`${zero.join(", ")}: сегодня ни одного звонка через Битрикс`);
    }
  }

  let readyToClose = 0;
  for (const g of payload.groups) {
    for (const m of g.managers) {
      const d = m.debts;
      if (!d) continue;

      if (d.newStaleDeals > 0) {
        const extra = d.newOldestAgeDays >= 2
          ? `, самой старой ${pluralNbsp(d.newOldestAgeDays, ["день", "дня", "дней"])}`
          : "";
        bad.push(
          `<b>${escapeHtml(cleanFirstName(m.name))}</b>: ${pluralNbsp(d.newStaleDeals, ["новая сделка", "новые сделки", "новых сделок"])} без звонка больше суток${extra}`
        );
      }
      if (d.overdueOngoing > 0) {
        bad.push(
          `<b>${escapeHtml(cleanFirstName(m.name))}</b>: ${pluralNbsp(d.overdueOngoing, ["дело", "дела", "дел"])} по идущим закупкам просрочено`
        );
      }
      if (d.overdueOverMonth >= 5) {
        warn.push(
          `<b>${escapeHtml(cleanFirstName(m.name))}</b>: ${pluralNbsp(d.overdueOverMonth, ["дело", "дела", "дел"])} просрочено больше месяца`
        );
      }
      readyToClose += (d.readyToCloseDealIds || []).length;
    }
  }

  if (payload.callsAvailable && ctx.genHour >= 14) {
    const dailyTarget = payload.targets.daily.calls;
    const low = activeSales
      .filter(
        (m) =>
          !m.rollups.signals?.zeroBitrixCallsToday &&
          m.rollups.day.calls.successful < dailyTarget * 0.6
      )
      .map(
        (m) =>
          `<b>${escapeHtml(cleanFirstName(m.name))}</b> <span class=num>${m.rollups.day.calls.successful}</span>`
      );

    if (low.length > 0) {
      warn.push(
        `Мало дозвонов к ${ctx.genLabel}: ${low.join(", ")} при норме ${dailyTarget}`
      );
    }
  }

  for (const g of payload.groups) {
    for (const m of g.managers) {
      const c = m.rollups.day.contracts;
      if (c.uniqueDealsCount > 0) {
        const contractsText = c.uniqueDealsCount === 1
          ? "подписан договор"
          : `подписано ${pluralNbsp(c.uniqueDealsCount, ["договор", "договора", "договоров"])}`;
        const amountText = c.totalAmount ? ` на ${formatPultMoney(c.totalAmount)}` : "";
        good.push(`<b>${escapeHtml(cleanFirstName(m.name))}</b>: ${contractsText}${amountText}`);
      }
    }
  }

  if (readyToClose > 0) {
    info.push(
      `Пора закрыть ${pluralNbsp(readyToClose, ["сделку", "сделки", "сделок"])}: закупка уже прошла, а сделки ещё в работе`
    );
  }
  if (!payload.callsAvailable) {
    info.push("Звонки сейчас не загружаются, цифры по звонкам неполные");
  }

  if (bad.length === 0 && warn.length === 0 && good.length === 0 && info.length === 0) {
    return [{ color: "green", text: "Сегодня без происшествий" }];
  }

  return [
    ...bad.map((t) => ({ color: "red" as const, text: t })),
    ...warn.map((t) => ({ color: "yellow" as const, text: t })),
    ...good.map((t) => ({ color: "green" as const, text: t })),
    ...info.map((t) => ({ color: "gray" as const, text: t }))
  ];
}

function periodName(p: "day" | "week" | "month"): string {
  return p === "day" ? "сегодня" : p === "week" ? "за неделю" : "за месяц";
}

function buildCallNotesForPeriod(
  payload: SalesPultPayload,
  period: "day" | "week" | "month",
  ctx: PaceContext
): string[] {
  const sales = payload.groups.find((g) => g.id === "sales");
  const activeSales = sales ? sales.managers.filter((m) => m.active) : [];
  const ms = activeSales.map((m) => ({ m, r: m.rollups[period].calls }));
  const notes: string[] = [];
  const n = ms.length || 1;

  let totalCalls = 0;
  for (const item of ms) totalCalls += item.r.successful;

  const pref = period === "month" && ctx.isEarly ? "За месяц. " : "";
  const zero = ms.filter((x) => !x.r.totalAttempts);
  const calling = ms.filter((x) => x.r.totalAttempts >= 10);

  if (calling.length > 0) {
    const top = [...calling].sort((a, b) => b.r.successful - a.r.successful)[0];
    notes.push(
      `${pref}Больше всех дозвонов: <b>${escapeHtml(cleanFirstName(top.m.name))}</b>, ${fmtNumber(top.r.successful)} из ${fmtNumber(top.r.totalAttempts)} наборов.`
    );

    const conv = (x: { r: { successful: number; totalAttempts: number } }) =>
      x.r.successful / x.r.totalAttempts;
    const low = [...calling].sort((a, b) => conv(a) - conv(b))[0];
    const talkers = calling.filter((x) => x.r.successful >= 5);
    const short = talkers.length > 0
      ? [...talkers].sort(
          (a, b) =>
            a.r.durationMinutes / a.r.successful - b.r.durationMinutes / b.r.successful
        )[0]
      : null;
    const av = short ? short.r.durationMinutes / short.r.successful : 99;
    const lowHit = conv(low) < 0.5;
    const shortHit = av < 1.5;

    if (lowHit && shortHit && short && short.m.id === low.m.id) {
      notes.push(
        `<b>${escapeHtml(cleanFirstName(low.m.name))}</b>: дозвон только в ${Math.round(conv(low) * 100)}% наборов, а средний разговор ${fmtNumber1(av)} мин, самый короткий в отделе. Стоит проверить базу номеров и послушать пару записей.`
      );
    } else {
      if (lowHit) {
        notes.push(
          `<b>${escapeHtml(cleanFirstName(low.m.name))}</b>: дозвон только в ${Math.round(conv(low) * 100)}% наборов. Стоит проверить базу номеров: возможно, много нерабочих.`
        );
      }
      if (shortHit && short) {
        notes.push(
          `<b>${escapeHtml(cleanFirstName(short.m.name))}</b>: средний разговор ${fmtNumber1(av)} мин, самый короткий в отделе. Разговор по делу обычно длиннее, стоит послушать пару записей.`
        );
      }
    }
  }

  if (zero.length > 0 && !(period === "day" && ctx.isEarly)) {
    notes.push(
      `${zero.map((x) => `<b>${escapeHtml(cleanFirstName(x.m.name))}</b>`).join(", ")}: ни одного звонка через Битрикс ${periodName(period)}. Если звонят с мобильного, в пульт это не попадает.`
    );
  }

  if (period !== "day" && totalCalls > 0) {
    const days = period === "week"
      ? Math.max(1, ctx.weekBefore + (ctx.dayFrac > 0 ? 1 : 0))
      : Math.max(1, ctx.wdBefore + (ctx.dayFrac > 0 ? 1 : 0));
    const per = totalCalls / days;
    const norm = payload.targets.daily.calls * n;
    notes.push(
      `Отдел делает ${fmtNumber1(per)} дозвона в рабочий день при норме ${fmtNumber(norm)}, это ${Math.round((per / norm) * 100)}% нормы.`
    );
  }

  return notes.slice(0, 5);
}

export function buildCallNotes(
  payload: SalesPultPayload,
  period: "day" | "week" | "month",
  paceContext?: PaceContext
): string[] {
  const ctx = paceContext || calculatePace(payload.asOfDate, payload.generatedAt, payload.holidays);
  const sales = payload.groups.find((g) => g.id === "sales");
  const activeSales = sales ? sales.managers.filter((m) => m.active) : [];
  const ms = activeSales.map((m) => ({ m, r: m.rollups[period].calls }));

  if (period === "day" && ctx.isEarly && ms.every((x) => !x.r.totalAttempts)) {
    const prev = [...payload.dynamics].reverse().find((d) => d.date < payload.asOfDate && (d.calls || d.contracts));
    let yesterdayLine = "";
    if (prev) {
      const dd = Number(prev.date.slice(8, 10));
      yesterdayLine = `В прошлый рабочий день, ${dd} ${MONTHS_GEN[ctx.month - 1]}: ${pluralNbsp(prev.calls, ["дозвон", "дозвона", "дозвонов"])}, ${pluralNbsp(prev.contracts, ["договор", "договора", "договоров"])}${prev.amount ? " на " + formatPultMoney(prev.amount) : ""}.`;
    }
    const monthNotes = buildCallNotesForPeriod(payload, "month", ctx);
    return [`Рабочий день ещё не начался, звонков пока нет.`]
      .concat(yesterdayLine ? [yesterdayLine] : [])
      .concat(monthNotes);
  }

  return buildCallNotesForPeriod(payload, period, ctx);
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 })
    .format(Math.round(n || 0))
    .replace(/\u00A0/g, " ");
}

export function fmtNumber1(n: number): string {
  const rounded = Math.round((n || 0) * 10) / 10;
  return rounded.toFixed(1).replace(".", ",");
}

export function formatMoney(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1e9) {
    const billions = n / 1e9;
    const rounded = Math.round(billions * 10) / 10;
    const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
    return `${str} млрд ₸`;
  }
  if (n >= 1e6) {
    const millions = n / 1e6;
    const rounded = Math.round(millions * 10) / 10;
    const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
    return `${str} млн ₸`;
  }
  return `${fmtNumber(n)} ₸`;
}

export function fmtNumberNbsp(n: number): string {
  return Math.round(n || 0).toLocaleString("ru-RU").replace(/\s/g, "\u00A0");
}

export function pluralNbsp(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(Math.round(n || 0));
  const a = abs % 100;
  const b = a % 10;
  let word: string;
  if (a > 10 && a < 20) {
    word = forms[2];
  } else if (b > 1 && b < 5) {
    word = forms[1];
  } else if (b === 1) {
    word = forms[0];
  } else {
    word = forms[2];
  }
  return `${fmtNumberNbsp(n)}\u00A0${word}`;
}

export function formatPultMoney(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1e9) {
    return `${fmtNumber1(n / 1e9)} млрд ₸`;
  }
  if (n >= 1e6) {
    return `${fmtNumber1(n / 1e6)} млн ₸`;
  }
  if (n >= 1e3) {
    return `${fmtNumberNbsp(n / 1e3)} тыс ₸`;
  }
  return `${fmtNumberNbsp(n)} ₸`;
}

export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(Math.round(n || 0));
  const a = abs % 100;
  const b = a % 10;
  let word: string;
  if (a > 10 && a < 20) {
    word = forms[2];
  } else if (b > 1 && b < 5) {
    word = forms[1];
  } else if (b === 1) {
    word = forms[0];
  } else {
    word = forms[2];
  }
  return `${fmtNumber(n)} ${word}`;
}

export function pluralDeals(n: number): string {
  return plural(n, ["договор", "договора", "договоров"]);
}

export function pluralDays(n: number): string {
  return plural(n, ["день", "дня", "дней"]);
}

export function decodeHtmlEntities(str: string): string {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = Number(dec);
      if (Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      const code = parseInt(hex, 16);
      if (Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    })
    .replace(/&amp;/g, "&");
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c] || c));
}

export function cleanFirstName(fullName: string): string {
  const clean = String(fullName ?? "").replace(/<[^>]*>/g, "").trim();
  return clean.split(/\s+/)[0] || clean;
}

export function cleanFullName(fullName: string): string {
  return String(fullName ?? "").replace(/<[^>]*>/g, "").trim();
}

export function initials(fullName: string): string {
  return String(fullName ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function cleanTaskTitle(task: { title?: string; planNumber?: string }): { title: string; plan: string } {
  let s = decodeHtmlEntities(task.title || "");
  let plan = task.planNumber || "";
  const m = /^\[GZ (\d+)\]\s*/.exec(s);
  if (m) {
    plan = plan || m[1];
    s = s.slice(m[0].length);
  }
  const m2 = /^(\d{7,9})\s+/.exec(s);
  if (m2) {
    plan = plan || m2[1];
    s = s.slice(m2[0].length);
  }
  return { title: s, plan };
}

export function getTaskStatus(task: Partial<TopTask>): { cls: string; text: string } {
  if (task.kind === "new") {
    const a = Math.floor(task.ageDays || 0);
    return {
      cls: "warn",
      text: a >= 1 ? `Новая, без звонка ${pluralDays(a)}` : "Новая, без звонка с сегодня"
    };
  }
  if (task.isOverdue) {
    return {
      cls: "bad",
      text: `Просрочено на ${pluralDays(task.overdueDays || 0)}`
    };
  }
  return { cls: "", text: "Срок сегодня" };
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
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
  day: PultPeriodView;
  week: PultPeriodView;
  monthPeriod: PultPeriodView;
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

function computeGroupTotals(group: PultGroupView | undefined, period: "day" | "week" | "month") {
  const t = { calls: 0, attempts: 0, minutes: 0, kp: 0, contracts: 0, amount: 0 };
  if (!group) return t;
  for (const m of group.managers) {
    if (!m.active) continue;
    const r = m.rollups[period];
    t.calls += r.calls.successful;
    t.attempts += r.calls.totalAttempts;
    t.minutes += r.calls.durationMinutes;
    t.kp += r.proposals.uniqueDealsCount;
    t.contracts += r.contracts.uniqueDealsCount;
    t.amount += r.contracts.totalAmount;
  }
  return t;
}

const TARGET_KEYS = { day: "daily", week: "weekly", month: "monthly" } as const;
function getTarget(targets: TargetsConfig, period: "day" | "week" | "month", metric: "calls" | "proposals" | "contracts"): number {
  return targets[TARGET_KEYS[period]][metric];
}

export function buildPultView(payload: SalesPultPayload): PultView {
  const holidays = payload.holidays ? new Set(payload.holidays) : DEFAULT_HOLIDAYS;
  const ctx = calculatePace(payload.asOfDate, payload.generatedAt, holidays);

  const [Y, M, D] = payload.asOfDate.split("-").map(Number);
  const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
  const dateLabel = `${DOW[dow]}, ${D} ${MONTHS_GEN[M - 1]} ${Y}`;
  const wdLabel = `Рабочих дней прошло ${ctx.wdBefore} из ${ctx.monthTotal}`;
  const monthFillPct = (ctx.monthDone / ctx.monthTotal) * 100;

  // Signals
  const rawSignals = buildPultSignals(payload);
  const signalsUrgent = rawSignals.filter((s) => s.color === "red").length;
  const signalsMeta = signalsUrgent
    ? plural(signalsUrgent, ["срочный пункт", "срочных пункта", "срочных пунктов"])
    : "срочного нет";
  const signals = rawSignals.map((s) => ({
    cls: s.color === "red" ? "s-bad" : s.color === "yellow" ? "s-warn" : s.color === "green" ? "s-good" : "",
    text: s.text,
    color: s.color
  }));

  // Groups
  const sales = payload.groups.find((g) => g.id === "sales") || payload.groups[0];
  const tenders = payload.groups.find((g) => g.id === "tenders");
  const salesActive = sales ? sales.managers.filter((m) => m.active) : [];
  const tendersActive = tenders ? tenders.managers.filter((m) => m.active) : [];
  const combinedGroups = [sales, tenders].filter((g): g is PultGroupView => Boolean(g));

  // Month hero calculations
  const monthPlan = combinedGroups.reduce(
    (s, g) => s + getTarget(payload.targets, "month", "contracts") * g.managers.filter((m) => m.active).length,
    0
  );
  const monthFact = combinedGroups.reduce((s, g) => s + computeGroupTotals(g, "month").contracts, 0);
  const monthAmount = combinedGroups.reduce((s, g) => s + computeGroupTotals(g, "month").amount, 0);
  const forecastRes = calculateMonthForecast(monthPlan, monthFact, ctx.monthDone, ctx.monthTotal);

  const split = combinedGroups.map((g) => {
    const t = computeGroupTotals(g, "month");
    return {
      name: g.id === "sales" ? "Продажи" : g.id === "tenders" ? "Тендеры" : g.name,
      c: t.contracts,
      a: t.amount,
      amountFormatted: formatMoney(t.amount) || "—"
    };
  });
  const maxC = Math.max(1, ...split.map((x) => x.c));
  const splitWithWidth = split.map((x) => ({
    ...x,
    widthPct: (x.c / maxC) * 100
  }));

  // Dynamics and points
  const byDayMap = new Map(payload.dynamics.map((d) => [Number(d.date.slice(8, 10)), d]));
  const cum: number[] = [0];
  let cumSum = 0;
  for (let d = 1; d <= D; d++) {
    const x = byDayMap.get(d);
    cumSum += x ? x.contracts : 0;
    cum.push(cumSum);
  }

  const byDayList = [];
  const weekends = [];
  for (let d = 1; d <= ctx.daysInMonth; d++) {
    const isWork = isWorkDay(Y, M, d, holidays);
    if (!isWork) weekends.push(d);
    const x = byDayMap.get(d);
    byDayList.push({
      day: d,
      calls: x ? x.calls : 0,
      contracts: x ? x.contracts : 0,
      amount: x ? x.amount : 0
    });
  }

  const monthView: PultMonthView = {
    plan: monthPlan,
    fact: monthFact,
    amount: monthAmount,
    pacePerDay: forecastRes.pacePerDay,
    forecast: forecastRes.forecast,
    left: forecastRes.left,
    daysLeft: forecastRes.daysLeft,
    pct: forecastRes.pct,
    fpct: forecastRes.fpct,
    monthDone: ctx.monthDone,
    monthTotal: ctx.monthTotal,
    wdBefore: ctx.wdBefore,
    daysInMonth: ctx.daysInMonth,
    targetContracts: getTarget(payload.targets, "month", "contracts"),
    totalActiveCount: combinedGroups.reduce((s, g) => s + g.managers.filter((m) => m.active).length, 0),
    verdict: forecastRes.verdict,
    split: splitWithWidth,
    points: cum,
    byDay: byDayList,
    workDays: ctx.workDays,
    weekends,
    nowXDay: D - 1 + ctx.dayFrac,
    dayFrac: ctx.dayFrac,
    asOfDate: payload.asOfDate,
    asOfDay: D,
    asOfMonth: M,
    asOfYear: Y
  };

  // Yesterday line
  const prev = [...payload.dynamics].reverse().find((d) => d.date < payload.asOfDate && (d.calls || d.contracts));
  let yesterdayLine = "";
  if (prev) {
    const dd = Number(prev.date.slice(8, 10));
    yesterdayLine = `В прошлый рабочий день, ${dd} ${MONTHS_GEN[M - 1]}: ${pluralNbsp(prev.calls, ["дозвон", "дозвона", "дозвонов"])}, ${pluralNbsp(prev.contracts, ["договор", "договора", "договоров"])}${prev.amount ? " на " + formatPultMoney(prev.amount) : ""}.`;
  }

  // Periods builder
  function buildPeriod(period: "day" | "week" | "month"): PultPeriodView {
    const periodLabel = period === "day" ? "сегодня" : period === "week" ? "за неделю" : "за месяц";
    const isEarly = period === "day" && ctx.isEarly;

    // Sales totals
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
        : isEarly
          ? yesterdayLine
          : "Звонков через Битрикс нет";

    const jk = !payload.proposalsTracked
      ? { cls: "idle" as const, text: "В CRM пока не отмечают", expected: 0 }
      : judgeMetricStatus(sTotals.kp, tk, period, "proposals", ctx);
    const kpSub = !payload.proposalsTracked
      ? `Отмечено ${pluralNbsp(sTotals.kp, ["КП", "КП", "КП"])}. Менеджеры не переводят сделки в стадию «КП отправлено», поэтому цифра занижена`
      : `Норма ${getTarget(payload.targets, period, "proposals")} на менеджера`;

    const jg = judgeMetricStatus(sTotals.contracts, tg, period, "contracts", ctx);
    const contractsSub = sTotals.contracts
      ? `На ${formatPultMoney(sTotals.amount) || "сумму, которая не указана"}`
      : "Пока ни одного";

    const salesMeta = `${pluralNbsp(salesActive.length, ["менеджер", "менеджера", "менеджеров"])} · норма на человека: ${pluralNbsp(getTarget(payload.targets, period, "calls"), ["дозвон", "дозвона", "дозвонов"])}, ${getTarget(payload.targets, period, "proposals")} КП, ${pluralNbsp(getTarget(payload.targets, period, "contracts"), ["договор", "договора", "договоров"])}`;

    // Sales managers
    const salesManagers: PultSalesManagerView[] = salesActive.map((m) => {
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
      const mContractsSub = r.contracts.uniqueDealsCount
        ? (formatPultMoney(r.contracts.totalAmount) || "сумма не указана")
        : "";

      const noCallsFlag = r.calls.totalAttempts === 0 && !(period === "day" && ctx.isEarly);
      const isEarlyCallsEmpty = isEarly && r.calls.successful === 0;
      const isEarlyKpEmpty = isEarly && r.proposals.uniqueDealsCount === 0;
      const isEarlyContractsEmpty = isEarly && r.contracts.uniqueDealsCount === 0;

      const tasksCount = (m.topTasks || []).length;
      const tasksCountText = tasksCount
        ? pluralNbsp(tasksCount, ["срочная задача", "срочные задачи", "срочных задач"])
        : "срочных задач нет";

      return {
        id: m.id,
        name: m.name,
        initials: initials(m.name),
        tasksCountText,
        calls: {
          fact: r.calls.successful,
          target: targetCalls,
          expected: mjc.expected,
          cls: mjc.cls,
          label: mjc.text,
          text: mjc.text,
          sub: mCallsSub,
          totalAttempts: r.calls.totalAttempts,
          durationMinutes: r.calls.durationMinutes,
          hasBitrixCalls: r.calls.totalAttempts > 0,
          noCallsFlag,
          isEarlyEmpty: isEarlyCallsEmpty
        },
        proposals: {
          fact: r.proposals.uniqueDealsCount,
          target: targetKp,
          expected: mjk.expected,
          cls: mjk.cls,
          label: mjk.text,
          text: mjk.text,
          untracked: !payload.proposalsTracked,
          isEarlyEmpty: isEarlyKpEmpty
        },
        contracts: {
          fact: r.contracts.uniqueDealsCount,
          target: targetContracts,
          expected: mjg.expected,
          cls: mjg.cls,
          label: mjg.text,
          text: mjg.text,
          sub: mContractsSub,
          totalAmount: r.contracts.totalAmount,
          isEarlyEmpty: isEarlyContractsEmpty
        },
        debts: m.debts,
        topTasks: m.topTasks || []
      };
    });

    // Sort managers by status weight then successful calls
    const sortWeight: Record<string, number> = { bad: 0, warn: 1, idle: 2, good: 3 };
    const sortedSalesManagers = [...salesManagers].sort((a, b) => {
      const wa = sortWeight[a.calls.cls] ?? 2;
      const wb = sortWeight[b.calls.cls] ?? 2;
      return (wa - wb) || (a.calls.fact - b.calls.fact);
    });

    // Calls strip
    const conv = sTotals.attempts ? Math.round((sTotals.calls / sTotals.attempts) * 100) : 0;
    const avg = sTotals.calls ? sTotals.minutes / sTotals.calls : 0;
    const days = period === "day"
      ? 1
      : period === "week"
        ? Math.max(1, ctx.weekBefore + (ctx.dayFrac > 0 ? 1 : 0))
        : Math.max(1, ctx.wdBefore + (ctx.dayFrac > 0 ? 1 : 0));
    const perDay = sTotals.calls / days;
    const norm = payload.targets.daily.calls * sActiveCount;

    // Calls anatomy
    const tgtCalls = getTarget(payload.targets, period, "calls");
    const scale = Math.max(tgtCalls, ...salesActive.map((m) => m.rollups[period].calls.totalAttempts)) * 1.04;
    const sortedByAttempts = [...salesActive].sort(
      (a, b) => b.rollups[period].calls.totalAttempts - a.rollups[period].calls.totalAttempts
    );
    const anatomy: PultAnatomyRowView[] = sortedByAttempts.map((m) => {
      const c = m.rollups[period].calls;
      const ok = (c.successful / scale) * 100;
      const miss = ((c.totalAttempts - c.successful) / scale) * 100;
      const tp = (tgtCalls / scale) * 100;
      const convStr = c.totalAttempts ? `${Math.round((c.successful / c.totalAttempts) * 100)}%` : "—";
      const avgStr = c.successful ? `${fmtNumber1(c.durationMinutes / c.successful)} мин` : "—";
      return {
        id: m.id,
        name: m.name,
        initials: initials(m.name),
        successful: c.successful,
        totalAttempts: c.totalAttempts,
        durationMinutes: c.durationMinutes,
        okPct: ok,
        missPct: miss,
        tgtPct: tp,
        convStr,
        avgStr,
        isEarlyEmpty: period === "day" && ctx.isEarly
      };
    });

    // Tenders department
    let tendersView: PultPeriodView["tenders"] = undefined;
    if (tenders) {
      const tTotals = computeGroupTotals(tenders, period);
      const tActiveCount = tendersActive.length || 1;
      const tTarget = getTarget(payload.targets, period, "contracts") * tActiveCount;
      const tJudge = judgeMetricStatus(tTotals.contracts, tTarget, period, "contracts", ctx);
      const tSub = tTotals.contracts
        ? `На ${formatPultMoney(tTotals.amount) || "сумму, которая не указана"}`
        : "Пока ни одного";

      const tManagers: PultTenderManagerView[] = tendersActive.map((m) => {
        const r = m.rollups[period];
        const targetContracts = getTarget(payload.targets, period, "contracts");
        const tmJudge = judgeMetricStatus(r.contracts.uniqueDealsCount, targetContracts, period, "contracts", ctx);
        const sub = r.contracts.uniqueDealsCount ? (formatPultMoney(r.contracts.totalAmount) || "сумма не указана") : "";
        return {
          id: m.id,
          name: m.name,
          initials: initials(m.name),
          contracts: {
            fact: r.contracts.uniqueDealsCount,
            target: targetContracts,
            expected: tmJudge.expected,
            cls: tmJudge.cls,
            label: tmJudge.text,
            text: tmJudge.text,
            sub,
            totalAmount: r.contracts.totalAmount,
            isEarlyEmpty: period === "day" && ctx.isEarly && r.contracts.uniqueDealsCount === 0
          },
          debts: m.debts,
          topTasks: m.topTasks || []
        };
      });

      const sortedTendersManagers = [...tManagers].sort(
        (a, b) => b.contracts.fact - a.contracts.fact
      );

      tendersView = {
        name: tenders.name,
        periodName: periodLabel,
        meta: `${pluralNbsp(tendersActive.length, ["специалист", "специалиста", "специалистов"])} · только договоры`,
        totals: {
          contracts: {
            fact: tTotals.contracts,
            target: tTarget,
            expected: tJudge.expected,
            cls: tJudge.cls,
            label: tJudge.text,
            text: tJudge.text,
            sub: tSub,
            totalAmount: tTotals.amount
          }
        },
        managers: sortedTendersManagers,
        activeCount: tendersActive.length
      };
    }

    return {
      period,
      periodName: periodLabel,
      isEarly,
      yesterdayLine,
      sales: {
        name: sales.name,
        periodName: periodLabel,
        meta: salesMeta,
        isEarly,
        earlyText: "Рабочий день ещё не начался: звонки и договоры за сегодня появятся после 09:00. Долги справа уже на сегодня.",
        totals: {
          calls: {
            fact: sTotals.calls,
            target: tc,
            expected: jc.expected,
            cls: jc.cls,
            label: jc.text,
            text: jc.text,
            sub: callsSub
          },
          proposals: {
            fact: sTotals.kp,
            target: tk,
            expected: jk.expected,
            cls: jk.cls,
            label: jk.text,
            text: jk.text,
            sub: kpSub,
            untracked: !payload.proposalsTracked
          },
          contracts: {
            fact: sTotals.contracts,
            target: tg,
            expected: jg.expected,
            cls: jg.cls,
            label: jg.text,
            text: jg.text,
            sub: contractsSub,
            totalAmount: sTotals.amount
          },
          attempts: sTotals.attempts,
          minutes: sTotals.minutes
        },
        managers: sortedSalesManagers,
        activeCount: salesActive.length
      },
      calls: {
        periodName: periodLabel,
        meta: payload.callsAvailable ? "телефония Битрикс24 · дозвон = разговор состоялся" : "телефония сейчас недоступна",
        strip: {
          calls: sTotals.calls,
          attempts: sTotals.attempts,
          conv,
          avg,
          normLabel: period === "day" ? "Норма на день" : "Дозвонов в день",
          normValue: period === "day" ? fmtNumber(norm) : fmtNumber1(perDay),
          normSub: period === "day" ? "" : `при норме ${fmtNumber(norm)}`,
          norm
        },
        notes: buildCallNotes(payload, period, ctx),
        anatomy
      },
      tenders: tendersView
    };
  }

  const dayView = buildPeriod("day");
  const weekView = buildPeriod("week");
  const monthPeriodView = buildPeriod("month");

  return {
    signals,
    signalsUrgent,
    signalsMeta,
    month: monthView,
    day: dayView,
    week: weekView,
    monthPeriod: monthPeriodView,
    periods: {
      day: dayView,
      week: weekView,
      month: monthPeriodView
    },
    dateLabel,
    wdLabel,
    monthFillPct,
    todayIsWork: ctx.todayIsWork,
    genLabel: ctx.genLabel,
    genHour: ctx.genHour
  };
}
