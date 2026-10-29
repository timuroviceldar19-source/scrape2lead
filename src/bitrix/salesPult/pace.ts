import type { TargetsConfig } from "./metrics.js";
import type { ManagerDebts } from "./debts.js";
import type { PultGroupView, SalesPultPayload, PultManagerView } from "./site.js";

export const DEFAULT_HOLIDAYS = new Set([
  "2026-01-01",
  "2026-01-02",
  "2026-01-07",
  "2026-03-09",
  "2026-03-20",
  "2026-03-23",
  "2026-03-24",
  "2026-05-01",
  "2026-05-07",
  "2026-05-11",
  "2026-07-06",
  "2026-08-31",
  "2026-10-26",
  "2026-12-16"
]);

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
  forecast: number;
  left: number;
  daysLeft: number;
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

export function toIsoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function isWorkDay(
  y: number,
  m: number,
  d: number,
  holidays: Set<string> = DEFAULT_HOLIDAYS
): boolean {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.has(toIsoDate(y, m, d));
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
    forecast,
    left,
    daysLeft,
    need,
    pct,
    fpct,
    verdict
  };
}

export function buildPultSignals(
  payload: SalesPultPayload,
  paceContext?: PaceContext
): SignalItem[] {
  const ctx = paceContext ?? calculatePace(payload.asOfDate, payload.generatedAt, payload.holidays);
  const bad: string[] = [];
  const warn: string[] = [];
  const good: string[] = [];
  const info: string[] = [];

  const sales = payload.groups.find((g) => g.id === "sales");
  const activeSales = sales ? sales.managers.filter((m) => m.active) : [];

  // Zero Bitrix calls: show only if callsAvailable, not early morning, and hour >= 11
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
      const firstName = escapeHtml(cleanFirstName(m.name));
      if (d.newStaleDeals > 0) {
        const deals = plural(d.newStaleDeals, ["новая сделка", "новые сделки", "новых сделок"]);
        const age = d.newOldestAgeDays >= 2
          ? `, самой старой ${plural(d.newOldestAgeDays, ["день", "дня", "дней"])}`
          : "";
        bad.push(`<b>${firstName}</b>: ${deals} без звонка больше суток${age}`);
      }
      if (d.overdueOngoing > 0) {
        const deeds = plural(d.overdueOngoing, ["дело", "дела", "дел"]);
        bad.push(`<b>${firstName}</b>: ${deeds} по идущим закупкам просрочено`);
      }
      if (d.overdueOverMonth >= 5) {
        const deeds = plural(d.overdueOverMonth, ["дело", "дела", "дел"]);
        warn.push(`<b>${firstName}</b>: ${deeds} просрочено больше месяца`);
      }
      readyToClose += d.readyToCloseDealIds.length;
    }
  }

  if (payload.callsAvailable && ctx.genHour >= 14) {
    const low = activeSales
      .filter(
        (m) =>
          !m.rollups.signals?.zeroBitrixCallsToday &&
          m.rollups.day.calls.successful < payload.targets.daily.calls * 0.6
      )
      .map(
        (m) =>
          `<b>${escapeHtml(cleanFirstName(m.name))}</b> <span class=num>${m.rollups.day.calls.successful}</span>`
      );
    if (low.length > 0) {
      warn.push(
        `Мало дозвонов к ${ctx.genLabel}: ${low.join(", ")} при норме ${payload.targets.daily.calls}`
      );
    }
  }

  for (const g of payload.groups) {
    for (const m of g.managers) {
      const c = m.rollups.day.contracts;
      if (c.uniqueDealsCount > 0) {
        const text = c.uniqueDealsCount === 1
          ? "подписан договор"
          : `подписано ${plural(c.uniqueDealsCount, ["договор", "договора", "договоров"])}`;
        const amtPart = c.totalAmount ? ` на ${formatMoney(c.totalAmount)}` : "";
        good.push(`<b>${escapeHtml(cleanFirstName(m.name))}</b>: ${text}${amtPart}`);
      }
    }
  }

  if (readyToClose > 0) {
    info.push(
      `Пора закрыть ${plural(readyToClose, ["сделку", "сделки", "сделок"])}: закупка уже прошла, а сделки ещё в работе`
    );
  }
  if (!payload.callsAvailable) {
    info.push("Звонки сейчас не загружаются, цифры по звонкам неполные");
  }

  const items: SignalItem[] = [
    ...bad.map((t): SignalItem => ({ color: "red", text: t })),
    ...warn.map((t): SignalItem => ({ color: "yellow", text: t })),
    ...good.map((t): SignalItem => ({ color: "green", text: t })),
    ...info.map((t): SignalItem => ({ color: "gray", text: t }))
  ];

  if (items.length === 0) {
    items.push({ color: "green", text: "Сегодня без происшествий" });
  }

  return items;
}

export function buildCallNotes(
  payload: SalesPultPayload,
  period: "day" | "week" | "month",
  paceContext?: PaceContext
): string[] {
  const ctx = paceContext ?? calculatePace(payload.asOfDate, payload.generatedAt, payload.holidays);
  const sales = payload.groups.find((g) => g.id === "sales");
  const activeSales = sales ? sales.managers.filter((m) => m.active) : [];

  const ms = activeSales.map((m) => ({ m, r: m.rollups[period].calls }));

  if (period === "day" && ctx.isEarly && ms.every((x) => !x.r.totalAttempts)) {
    const yLine = getYesterdayDynamicsLine(payload, ctx);
    const notes = ["Рабочий день ещё не начался, звонков пока нет."];
    if (yLine) notes.push(yLine);
    return notes.concat(buildCallNotesForPeriod(payload, "month", ctx)).slice(0, 5);
  }

  return buildCallNotesForPeriod(payload, period, ctx);
}

function getYesterdayDynamicsLine(payload: SalesPultPayload, ctx: PaceContext): string {
  const prev = [...payload.dynamics]
    .reverse()
    .find((d) => d.date < payload.asOfDate && (d.calls > 0 || d.contracts > 0));
  if (!prev) return "";
  const dd = Number(prev.date.slice(8, 10));
  const monthGen = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"
  ][ctx.month - 1];
  const amt = prev.amount ? ` на ${formatMoney(prev.amount)}` : "";
  return `В прошлый рабочий день, ${dd} ${monthGen}: ${plural(prev.calls, ["дозвон", "дозвона", "дозвонов"])}, ${plural(prev.contracts, ["договор", "договора", "договоров"])}${amt}.`;
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

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 })
    .format(Math.round(n || 0))
    .replace(/\u00A0/g, " ");
}

export function fmtNumber1(n: number): string {
  const rounded = Math.round(n * 10) / 10;
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

export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(Math.round(n));
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
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
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

export function getTaskStatus(task: {
  kind?: string;
  ageDays?: number;
  isOverdue?: boolean;
  overdueDays?: number;
}): { cls: string; text: string } {
  if (task.kind === "new") {
    const a = Math.floor(task.ageDays || 0);
    return {
      cls: "warn",
      text: a >= 1 ? `Новая, без звонка ${plural(a, ["день", "дня", "дней"])}` : "Новая, без звонка с сегодня"
    };
  }
  if (task.isOverdue) {
    return {
      cls: "bad",
      text: `Просрочено на ${plural(task.overdueDays || 0, ["день", "дня", "дней"])}`
    };
  }
  return { cls: "", text: "Срок сегодня" };
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
  const readyToClose = debts.readyToCloseDealIds.length;
  if (readyToClose > 0) lines.push({ color: "gray", text: `пора закрыть ${readyToClose}` });
  return lines;
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
    const age = Math.floor(task.ageDays ?? 0);
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
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"
  ];
  const monthName = months[parseInt(m, 10) - 1] || m;
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

  const diffDays = Math.round(
    (Date.parse(asOfDate) - Date.parse(deadlineAlmatyDate)) / 86400000
  );

  if (diffDays <= 0) {
    return "просрочено сегодня";
  }
  return `просрочено на ${plural(diffDays, ["день", "дня", "дней"])}`;
}
