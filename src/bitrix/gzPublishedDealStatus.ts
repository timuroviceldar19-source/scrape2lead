export const GZ_PUBLISHED_AT_FIELD = "UF_CRM_S2L_GZ_PUBLISHED_AT";
export const GZ_PLAN_STATUS_FIELD = "UF_CRM_PLAN_STATUS";
export const GZ_PLAN_STATUS_LEGACY_FIELD = "UF_CRM_6627AEBD85B4D";
export const GZ_APPROVED_STATUS_NAME = "Утвержден";
export const GZ_PUBLISHED_STATUS_NAME = "Опубликован";

export interface PublishedDealSnapshot {
  UF_CRM_PLAN_STATUS?: string | null;
  UF_CRM_6627AEBD85B4D?: string | null;
  UF_CRM_S2L_GZ_PUBLISHED_AT?: string | null;
}

export interface PanelsGzPlanSnapshot {
  TITLE?: string | null;
  CATEGORY_ID?: string | number | null;
  UF_CRM_1713874845756?: string | null;
  UF_CRM_S2L_GZ_KEYWORD?: string | null;
}

export type PublishedDealAction = "update-status" | "skipped";

export interface PublishedDealUpdate {
  fields: Record<string, string>;
  action: PublishedDealAction;
  skipReason: string | null;
}

export interface PublishedDealUpdateClient {
  updateDeal(id: string, fields: Record<string, string>): Promise<void>;
}

export function selectPublishedDealBatch<T>(deals: T[], offset: number, limit: number | null): T[] {
  const start = Math.max(0, Math.trunc(offset));
  if (limit === null) return deals.slice(start);
  return deals.slice(start, start + Math.max(0, Math.trunc(limit)));
}

export function isPanelsGzPlanDeal(deal: PanelsGzPlanSnapshot, keywords: readonly string[]): boolean {
  const explicitValues = [
    text(deal.UF_CRM_1713874845756),
    text(deal.UF_CRM_S2L_GZ_KEYWORD)
  ].filter(Boolean);
  const haystack = normalizeRu(explicitValues.length > 0 ? explicitValues.join(" ") : text(deal.TITLE));
  if (!haystack) return false;

  return keywords.some((keyword) => {
    const normalizedKeyword = normalizeRu(keyword);
    return normalizedKeyword.length > 0 && haystack.includes(normalizedKeyword);
  });
}

export function selectPanelsPublishedDealBatch<T extends PanelsGzPlanSnapshot>(
  deals: T[],
  keywords: readonly string[],
  offset: number,
  limit: number | null
): T[] {
  return selectPublishedDealBatch(deals.filter((deal) => isPanelsGzPlanDeal(deal, keywords)), offset, limit);
}

/**
 * Стадии и воронки Bitrix не трогаем: Goszakup — источник истины только для
 * статуса пункта плана, поэтому обновление никогда не содержит STAGE_ID.
 */
export function buildPublishedDealUpdate(
  deal: PublishedDealSnapshot,
  detectedStatus: string,
  detectedAt: string
): PublishedDealUpdate {
  const currentStatus = text(deal.UF_CRM_PLAN_STATUS) || text(deal.UF_CRM_6627AEBD85B4D);

  if (matches(currentStatus, GZ_PUBLISHED_STATUS_NAME)) {
    return { fields: {}, action: "skipped", skipReason: "deal is already published in Bitrix" };
  }
  if (!matches(currentStatus, GZ_APPROVED_STATUS_NAME)) {
    return {
      fields: {},
      action: "skipped",
      skipReason: `current status ${currentStatus || "-"} is not ${GZ_APPROVED_STATUS_NAME}`
    };
  }

  const fields: Record<string, string> = {};
  if (text(deal.UF_CRM_PLAN_STATUS) !== detectedStatus) fields[GZ_PLAN_STATUS_FIELD] = detectedStatus;
  if (text(deal.UF_CRM_6627AEBD85B4D) !== detectedStatus) fields[GZ_PLAN_STATUS_LEGACY_FIELD] = detectedStatus;
  if (!text(deal.UF_CRM_S2L_GZ_PUBLISHED_AT)) fields[GZ_PUBLISHED_AT_FIELD] = detectedAt;

  return { fields, action: "update-status", skipReason: null };
}

export async function applyPublishedDealUpdate(
  client: PublishedDealUpdateClient,
  dealId: string,
  update: PublishedDealUpdate,
  execute: boolean
): Promise<boolean> {
  if (!execute || Object.keys(update.fields).length === 0) return false;
  await client.updateDeal(dealId, update.fields);
  return true;
}

function matches(value: string, expected: string): boolean {
  return normalizeRu(value) === normalizeRu(expected);
}

function normalizeRu(value: string): string {
  return value.trim().toLocaleLowerCase("ru");
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}
