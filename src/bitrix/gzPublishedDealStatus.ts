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

export type PublishedDealAction = "update-status" | "skipped";

export interface PublishedDealUpdate {
  fields: Record<string, string>;
  action: PublishedDealAction;
  skipReason: string | null;
}

export interface PublishedDealUpdateClient {
  updateDeal(id: string, fields: Record<string, string>): Promise<void>;
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
