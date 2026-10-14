import type { LotBidWindow } from "../kz/goszakupLotWindow.js";

const LOT_ORIGIN_PREFIX = "gz-lot:";
const REGISTRY_DATE = /^(\d{4}-\d{2}-\d{2})/;
const REGISTRY_MINUTES = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/;
const DAY_MS = 86_400_000;

/** Поля сделки, нужные для разбора дат. Даты Bitrix приходят ISO-строкой со смещением. */
export interface LotDateDeal {
  ID: string | number;
  ORIGIN_ID?: string | null;
  DATE_CREATE?: string | null;
  BEGINDATE?: string | null;
  CLOSEDATE?: string | null;
}

export interface LotDateUpdate {
  dealId: string;
  lotNumber: string;
  fields: Record<string, string>;
}

export interface LotDateBackfillStats {
  total: number;
  willUpdate: number;
  /** Менеджер поменял даты сам: не трогаем. */
  editedByHand: number;
  /** В реестре те же даты, что уже стоят в сделке. */
  alreadyRight: number;
  /** Реестр не назвал дат (лота нет или даты не заполнены). */
  noWindow: number;
  /** Реестр не ответил: лот можно проверить в следующий раз. */
  lookupFailed: number;
}

export interface LotDateBackfillPlan {
  updates: LotDateUpdate[];
  stats: LotDateBackfillStats;
}

/**
 * `BEGINDATE`/`CLOSEDATE` у сделки по лоту — это срок приёма заявок. Поле Bitrix хранит только дату,
 * поэтому часы остаются в комментарии (`bidWindowComment`).
 */
export function bidWindowFields(window: LotBidWindow | null): Record<string, string> {
  const begin = REGISTRY_DATE.exec(window?.startDate ?? "")?.[1];
  const close = REGISTRY_DATE.exec(window?.endDate ?? "")?.[1];
  return { ...(begin ? { BEGINDATE: begin } : {}), ...(close ? { CLOSEDATE: close } : {}) };
}

export function bidWindowComment(window: LotBidWindow | null): string | null {
  const begin = REGISTRY_MINUTES.exec(window?.startDate ?? "");
  const close = REGISTRY_MINUTES.exec(window?.endDate ?? "");
  if (!begin && !close) return null;
  const show = (match: RegExpExecArray | null) => (match ? `${match[1]} ${match[2]}` : "-");
  return `Приём заявок: ${show(begin)} — ${show(close)} (время Алматы)`;
}

function dayOf(value: string | null | undefined): string {
  return REGISTRY_DATE.exec(String(value ?? "").trim())?.[1] ?? "";
}

function plusDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Bitrix сам ставит новой сделке `BEGINDATE` = день создания и `CLOSEDATE` = +7 дней, если импорт дат не передал.
 * Такие даты не срок закупки. Сделку, где менеджер поменял хотя бы одну из дат, считаем отредактированной.
 */
export function isPlaceholderWindow(deal: LotDateDeal): boolean {
  const begin = dayOf(deal.BEGINDATE);
  const close = dayOf(deal.CLOSEDATE);
  if (!begin && !close) return true;
  const created = dayOf(deal.DATE_CREATE);
  return Boolean(created) && begin === created && close === plusDays(created, 7);
}

function lotNumberOf(deal: LotDateDeal): string | null {
  const origin = String(deal.ORIGIN_ID ?? "");
  return origin.startsWith(LOT_ORIGIN_PREFIX) ? origin.slice(LOT_ORIGIN_PREFIX.length) : null;
}

/**
 * Какие сделки по лотам нужно исправить. Чужие поля не затрагиваются: только `BEGINDATE` и `CLOSEDATE`,
 * и только там, где они стоят «по умолчанию».
 */
export function planLotDateBackfill(
  deals: LotDateDeal[],
  windows: Map<string, LotBidWindow>,
  failed: Set<string>
): LotDateBackfillPlan {
  const stats: LotDateBackfillStats = { total: 0, willUpdate: 0, editedByHand: 0, alreadyRight: 0, noWindow: 0, lookupFailed: 0 };
  const updates: LotDateUpdate[] = [];
  for (const deal of deals) {
    const lotNumber = lotNumberOf(deal);
    if (!lotNumber) continue;
    stats.total += 1;
    if (!isPlaceholderWindow(deal)) {
      stats.editedByHand += 1;
      continue;
    }
    if (failed.has(lotNumber)) {
      stats.lookupFailed += 1;
      continue;
    }
    const fields = bidWindowFields(windows.get(lotNumber) ?? null);
    if (Object.keys(fields).length === 0) {
      stats.noWindow += 1;
      continue;
    }
    const same = Object.entries(fields).every(([name, value]) => dayOf(deal[name as "BEGINDATE" | "CLOSEDATE"]) === value);
    if (same) {
      stats.alreadyRight += 1;
      continue;
    }
    stats.willUpdate += 1;
    updates.push({ dealId: String(deal.ID), lotNumber, fields });
  }
  return { updates, stats };
}
