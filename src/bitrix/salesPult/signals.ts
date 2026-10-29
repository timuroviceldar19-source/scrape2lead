import type { SalesPultPayload, PaceContext, SignalItem } from "./types.js";
import { calculatePace } from "./pace.js";
import {
  escapeHtml,
  cleanFirstName,
  plural,
  pluralNbsp,
  formatPultMoney
} from "./format.js";

function collectDebtSignals(
  payload: SalesPultPayload,
  bad: string[],
  warn: string[]
): number {
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
  return readyToClose;
}

function collectCallSignals(
  payload: SalesPultPayload,
  ctx: PaceContext,
  bad: string[],
  warn: string[]
): void {
  const sales = payload.groups.find((g) => g.id === "sales");
  const activeSales = sales ? sales.managers.filter((m) => m.active) : [];

  if (payload.callsAvailable && ctx.genHour >= 11) {
    for (const m of activeSales) {
      if (
        m.rollups.signals?.zeroBitrixCallsToday ||
        (m.rollups.day.calls.totalAttempts === 0 && !ctx.isEarly)
      ) {
        bad.push(`<b>${escapeHtml(cleanFirstName(m.name))}</b>: сегодня ни одного звонка через Битрикс`);
      }
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
}

function collectContractSignals(payload: SalesPultPayload, good: string[]): void {
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
}

export function buildPultSignals(
  payload: SalesPultPayload,
  paceContext?: PaceContext
): SignalItem[] {
  const ctx = paceContext || calculatePace(payload.asOfDate, payload.generatedAt, payload.holidays);
  const bad: string[] = [];
  const warn: string[] = [];
  const good: string[] = [];
  const info: string[] = [];

  collectCallSignals(payload, ctx, bad, warn);
  const readyToClose = collectDebtSignals(payload, bad, warn);
  collectContractSignals(payload, good);

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

export const buildSignals = buildPultSignals;

export function formatSignals(rawSignals: SignalItem[]) {
  const signalsUrgent = rawSignals.filter((s) => s.color === "red").length;
  const signalsMeta = signalsUrgent
    ? plural(signalsUrgent, ["срочный пункт", "срочных пункта", "срочных пунктов"])
    : "срочного нет";
  const signals = rawSignals.map((s) => ({
    cls: s.color === "red" ? "s-bad" : s.color === "yellow" ? "s-warn" : s.color === "green" ? "s-good" : "",
    text: s.text,
    color: s.color
  }));
  return { signals, signalsUrgent, signalsMeta };
}
