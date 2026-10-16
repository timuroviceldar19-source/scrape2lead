// Заказчик может заменить в пункте плана сам товар (код ЕНС ТРУ и название), оставив сумму и количество: номер пункта на портале
// прежний, запись в реестре новая. gzPlanRevision.ts замечает только смену суммы и количества, поэтому в сделке оставался старый товар.
// Здесь сравнивается товар сделки с действующей версией пункта и готовится правка полей и комментарий.

import type { CurrentPlanItem } from "../kz/goszakupPlanItems.js";

export type { CurrentPlanItem };

const CODE_FIELDS = ["UF_CRM_REF_ENSTRU_CODE", "UF_CRM_6A436D5A19612"] as const;
const NAME_FIELDS = ["UF_CRM_6627AEBD54B8D", "UF_CRM_ENSTRU_NAME"] as const;
const BIN_FIELD = "UF_CRM_6627AEBD7C2D2";
const PLAN_LINK_FIELD = "UF_CRM_PLAN_LINK";
const ORIGIN_PREFIX = "gz-plan:";
const TITLE_MAX = 250;

/** Поля сделки, нужные для сверки (все приходят из crm.deal.list строками). */
export interface PlanItemDeal {
  ID: string | number;
  ORIGIN_ID?: string | null;
  TITLE?: string | null;
  COMMENTS?: string | null;
  DATE_CREATE?: string | null;
  UF_CRM_REF_ENSTRU_CODE?: string | null;
  UF_CRM_6A436D5A19612?: string | null;
  UF_CRM_6627AEBD54B8D?: string | null;
  UF_CRM_ENSTRU_NAME?: string | null;
  UF_CRM_6627AEBD7C2D2?: string | null;
  UF_CRM_PLAN_LINK?: string | null;
}

export const PLAN_ITEM_DEAL_SELECT = [
  "ID",
  "ORIGIN_ID",
  "TITLE",
  "COMMENTS",
  "DATE_CREATE",
  ...CODE_FIELDS,
  ...NAME_FIELDS,
  BIN_FIELD,
  PLAN_LINK_FIELD
];

export interface PlanItemChange {
  dealId: string;
  previous: { code: string; name: string };
  current: { code: string; name: string };
  fields: Record<string, string>;
  comment: string;
}

export interface PlanItemSyncStats {
  total: number;
  willUpdate: number;
  alreadyRight: number;
  /** Реестр такого пункта не отдал (в его индексе есть не все пункты). */
  notInRegistry: number;
  /** Реестр не ответил: сделку можно проверить в следующий раз. */
  lookupFailed: number;
  /** Запись реестра не прошла проверку (другой заказчик, старая запись, БИН не проверить): сделку не трогаем. */
  skipped: number;
}

export interface PlanItemSyncPlan {
  updates: PlanItemChange[];
  stats: PlanItemSyncStats;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function firstFilled(deal: PlanItemDeal, fields: readonly string[]): string {
  for (const field of fields) {
    const value = text((deal as unknown as Record<string, unknown>)[field]);
    if (value) return value;
  }
  return "";
}

function rootOf(deal: PlanItemDeal): number | null {
  const match = /^gz-plan:(\d+)$/.exec(text(deal.ORIGIN_ID));
  return match ? Number(match[1]) : null;
}

function dealBin(deal: PlanItemDeal): string | null {
  const own = text(deal[BIN_FIELD]);
  if (/^\d{12}$/.test(own)) return own;
  return /BIN:\s*(\d{12})/.exec(text(deal.COMMENTS))?.[1] ?? null;
}

const day = (value: string): string => value.slice(0, 10);

/**
 * Что поправить в сделке, если заказчик заменил товар в пункте. `null`, если товар тот же или запись реестра не подходит:
 * чужой заказчик, версия старше сделки (старая запись с тем же номером), год раньше сделки, БИН не проверить.
 */
export function planItemChange(deal: PlanItemDeal, current: CurrentPlanItem): PlanItemChange | null {
  const root = rootOf(deal);
  if (root === null || root !== current.rootId) return null;
  if (!current.code || !current.name) return null;

  const previousCode = firstFilled(deal, CODE_FIELDS);
  if (!previousCode || previousCode === current.code) return null;

  const bin = dealBin(deal);
  if (!bin || !current.bin || bin !== current.bin) return null;
  const created = day(text(deal.DATE_CREATE));
  if (created && current.createdAt && day(current.createdAt) < created) return null;
  const dealYear = Number(created.slice(0, 4)) || 0;
  if (current.year !== null && dealYear && current.year < dealYear) return null;

  const previousName = firstFilled(deal, NAME_FIELDS);
  const wanted: Record<string, string> = {};
  for (const field of CODE_FIELDS) wanted[field] = current.code;
  for (const field of NAME_FIELDS) wanted[field] = current.name;

  // Название и комментарий меняем, только если они ещё в том виде, в каком их написал робот.
  const title = text(deal.TITLE);
  if (previousName && title.endsWith(` - ${previousName}`)) {
    wanted.TITLE = `${title.slice(0, title.length - previousName.length)}${current.name}`.slice(0, TITLE_MAX);
  }
  const comments = String(deal.COMMENTS ?? "");
  if (previousName && comments.includes(`Item: ${previousName}`)) {
    wanted.COMMENTS = comments.replace(`Item: ${previousName}`, `Item: ${current.name}`);
  }

  const fields = Object.fromEntries(Object.entries(wanted).filter(([field, value]) => text((deal as unknown as Record<string, unknown>)[field]) !== value));
  const link = text(deal[PLAN_LINK_FIELD]);
  const comment = [
    `План изменён заказчиком ${day(current.createdAt)}.`,
    `Товар: ${previousName || "не указан"} (${previousCode}) → ${current.name} (${current.code})`,
    ...(link ? [`Новая версия пункта плана: ${link}`] : [])
  ].join("\n");

  return {
    dealId: String(deal.ID),
    previous: { code: previousCode, name: previousName },
    current: { code: current.code, name: current.name },
    fields,
    comment
  };
}

/** Какие сделки по плану нужно поправить. Остальное считается для отчёта. */
export function planItemSync(deals: PlanItemDeal[], items: Map<number, CurrentPlanItem>, failedRoots: Set<number>): PlanItemSyncPlan {
  const stats: PlanItemSyncStats = { total: 0, willUpdate: 0, alreadyRight: 0, notInRegistry: 0, lookupFailed: 0, skipped: 0 };
  const updates: PlanItemChange[] = [];
  for (const deal of deals) {
    const root = rootOf(deal);
    if (root === null) continue;
    stats.total += 1;
    if (failedRoots.has(root)) {
      stats.lookupFailed += 1;
      continue;
    }
    const item = items.get(root);
    if (!item) {
      stats.notInRegistry += 1;
      continue;
    }
    const change = planItemChange(deal, item);
    if (change) {
      stats.willUpdate += 1;
      updates.push(change);
    } else if (firstFilled(deal, CODE_FIELDS) === item.code) {
      stats.alreadyRight += 1;
    } else {
      stats.skipped += 1;
    }
  }
  return { updates, stats };
}
