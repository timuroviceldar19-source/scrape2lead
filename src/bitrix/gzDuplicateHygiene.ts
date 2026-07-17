import { GZ_ORIGINATOR_ID } from "./gzLeadCleanup.js";
import {
  GZ_PLAN_LINK_FIELD,
  GZ_PLAN_POINT_ID_FIELD,
  buildGzOriginId,
  extractPlanIdFromUrl,
  type BackfillCandidateDeal
} from "./gzOriginBackfill.js";

export const DEFAULT_OLD_XLS_ORIGINATOR_ID = "app_iu_xls_import";

export interface DuplicateHygieneDeal extends BackfillCandidateDeal {
  STAGE_ID?: string | null;
  CATEGORY_ID?: string | number | null;
}

export interface GzDuplicatePair {
  planId: string;
  originId: string;
  oldDealId: string;
  oldCategoryId: string;
  keyedDealId: string;
  oldTitle: string;
  keyedTitle: string;
}

export interface DuplicateHygieneOptions {
  oldOriginatorIds?: ReadonlySet<string>;
}

export function findGzDuplicatePairs(
  deals: DuplicateHygieneDeal[],
  options: DuplicateHygieneOptions = {}
): GzDuplicatePair[] {
  const oldOriginatorIds = options.oldOriginatorIds ?? new Set([DEFAULT_OLD_XLS_ORIGINATOR_ID]);
  const keyedByOriginId = new Map<string, DuplicateHygieneDeal>();

  for (const deal of deals) {
    const originatorId = String(deal.ORIGINATOR_ID ?? "").trim();
    const originId = String(deal.ORIGIN_ID ?? "").trim();
    const dealId = stringId(deal);
    if (!dealId || originatorId !== GZ_ORIGINATOR_ID || !isGzPlanOriginId(originId)) continue;
    if (!keyedByOriginId.has(originId)) keyedByOriginId.set(originId, deal);
  }

  const pairs: GzDuplicatePair[] = [];
  const seenOldDealIds = new Set<string>();
  for (const deal of deals) {
    const oldDealId = stringId(deal);
    if (!oldDealId || seenOldDealIds.has(oldDealId)) continue;

    const originatorId = String(deal.ORIGINATOR_ID ?? "").trim();
    const originId = String(deal.ORIGIN_ID ?? "").trim();
    if (!oldOriginatorIds.has(originatorId) || originId) continue;

    const planId = extractPlanIdFromDeal(deal);
    if (!planId) continue;

    const expectedOriginId = buildGzOriginId(planId);
    const keyedDeal = keyedByOriginId.get(expectedOriginId);
    const keyedDealId = keyedDeal ? stringId(keyedDeal) : "";
    if (!keyedDealId || keyedDealId === oldDealId) continue;

    seenOldDealIds.add(oldDealId);
    pairs.push({
      planId,
      originId: expectedOriginId,
      oldDealId,
      oldCategoryId: String(deal.CATEGORY_ID ?? "0").trim() || "0",
      keyedDealId,
      oldTitle: String(deal.TITLE ?? ""),
      keyedTitle: String(keyedDeal?.TITLE ?? "")
    });
  }

  return pairs;
}

export function buildDuplicateArchiveFields(archiveStageId: string | null | undefined): Record<string, unknown> | null {
  const stageId = archiveStageId?.trim();
  if (!stageId) return null;
  return { STAGE_ID: stageId };
}

/**
 * Deal stages are scoped to a pipeline: category 0 uses bare ids ("LOSE"),
 * other categories use a "C<id>:" prefix ("C41:LOSE"). Bitrix silently ignores
 * a STAGE_ID from a foreign pipeline on crm.deal.update, so a mismatched
 * archive stage must be treated as an error, not sent.
 */
export function stageMatchesDealCategory(stageId: string, categoryId: string | number | null | undefined): boolean {
  const category = String(categoryId ?? "0").trim() || "0";
  const stageCategory = stageId.trim().match(/^C(\d+):/)?.[1] ?? "0";
  return stageCategory === category;
}

function extractPlanIdFromDeal(deal: DuplicateHygieneDeal): string | null {
  const fromLink = extractPlanIdFromUrl(deal[GZ_PLAN_LINK_FIELD]);
  if (fromLink) return fromLink;
  const fieldValue = String(deal[GZ_PLAN_POINT_ID_FIELD] ?? "").trim();
  if (/^\d+$/.test(fieldValue)) return fieldValue;
  return null;
}

function isGzPlanOriginId(value: string): boolean {
  return /^gz-plan:\d+$/.test(value);
}

function stringId(deal: DuplicateHygieneDeal): string {
  return String(deal.ID ?? "").trim();
}
