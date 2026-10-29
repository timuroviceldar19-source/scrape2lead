import type { SalesPultPayload, PaceContext, PultManagerView } from "./types.js";
import { calculatePace } from "./pace.js";
import {
  cleanFirstName,
  escapeHtml,
  fmtNumber,
  fmtNumber1,
  pluralNbsp,
  formatPultMoney,
  MONTHS_GEN
} from "./format.js";

type ManagerCallItem = {
  m: PultManagerView;
  r: {
    successful: number;
    totalAttempts: number;
    durationMinutes: number;
  };
};

function periodName(p: "day" | "week" | "month"): string {
  return p === "day" ? "сегодня" : p === "week" ? "за неделю" : "за месяц";
}

function buildTopCallerNote(calling: ManagerCallItem[], pref: string): string | null {
  if (calling.length === 0) return null;
  const top = [...calling].sort((a, b) => b.r.successful - a.r.successful)[0];
  return `${pref}Больше всех дозвонов: <b>${escapeHtml(cleanFirstName(top.m.name))}</b>, ${fmtNumber(top.r.successful)} из ${fmtNumber(top.r.totalAttempts)} наборов.`;
}

function buildQualityNotes(calling: ManagerCallItem[]): string[] {
  if (calling.length === 0) return [];
  const notes: string[] = [];
  const conv = (x: ManagerCallItem) => x.r.successful / x.r.totalAttempts;
  const low = [...calling].sort((a, b) => conv(a) - conv(b))[0];
  const talkers = calling.filter((x) => x.r.successful >= 5);
  const short = talkers.length > 0
    ? [...talkers].sort(
        (a, b) => a.r.durationMinutes / a.r.successful - b.r.durationMinutes / b.r.successful
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
  return notes;
}

function buildZeroCallsNote(
  zero: ManagerCallItem[],
  period: "day" | "week" | "month",
  isEarly: boolean
): string | null {
  if (zero.length === 0 || (period === "day" && isEarly)) return null;
  const names = zero.map((x) => `<b>${escapeHtml(cleanFirstName(x.m.name))}</b>`).join(", ");
  return `${names}: ни одного звонка через Битрикс ${periodName(period)}. Если звонят с мобильного, в пульт это не попадает.`;
}

function buildDeptPaceNote(
  totalCalls: number,
  n: number,
  period: "day" | "week" | "month",
  ctx: PaceContext,
  targetCalls: number
): string | null {
  if (period === "day" || totalCalls === 0) return null;
  const days = period === "week"
    ? Math.max(1, ctx.weekBefore + (ctx.dayFrac > 0 ? 1 : 0))
    : Math.max(1, ctx.wdBefore + (ctx.dayFrac > 0 ? 1 : 0));
  const per = totalCalls / days;
  const norm = targetCalls * n;
  return `Отдел делает ${fmtNumber1(per)} дозвона в рабочий день при норме ${fmtNumber(norm)}, это ${Math.round((per / norm) * 100)}% нормы.`;
}

export function buildCallNotesForPeriod(
  payload: SalesPultPayload,
  period: "day" | "week" | "month",
  ctx: PaceContext
): string[] {
  const sales = payload.groups.find((g) => g.id === "sales");
  const activeSales = sales ? sales.managers.filter((m) => m.active) : [];
  const ms: ManagerCallItem[] = activeSales.map((m) => ({ m, r: m.rollups[period].calls }));
  const notes: string[] = [];
  const n = ms.length || 1;

  let totalCalls = 0;
  for (const item of ms) totalCalls += item.r.successful;

  const pref = period === "month" && ctx.isEarly ? "За месяц. " : "";
  const zero = ms.filter((x) => !x.r.totalAttempts);
  const calling = ms.filter((x) => x.r.totalAttempts >= 10);

  const topNote = buildTopCallerNote(calling, pref);
  if (topNote) notes.push(topNote);

  notes.push(...buildQualityNotes(calling));

  const zeroNote = buildZeroCallsNote(zero, period, ctx.isEarly);
  if (zeroNote) notes.push(zeroNote);

  const deptNote = buildDeptPaceNote(totalCalls, n, period, ctx, payload.targets.daily.calls);
  if (deptNote) notes.push(deptNote);

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
