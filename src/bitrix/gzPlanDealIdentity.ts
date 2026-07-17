import {
  buildGzPlanOriginId,
  extractLegacyGzPlanIdFromUrl,
  resolveGzPlanPointId
} from "../kz/gzPlanIdentity.js";

export interface GzPlanIdentityRow {
  planId: string;
  planNumber: string;
  planUrl: string;
}

export interface GzPlanDealIdentity {
  planPointId: string;
  originId: string;
  legacyOriginId: string | null;
}

export interface LegacyGzDealIdentityFields {
  ORIGIN_ID?: string | null;
  UF_CRM_PLAN_ID?: string | number | null;
  UF_CRM_PLAN_LINK?: string | null;
  UF_CRM_1782386293000_IU_XLS?: string | number | null;
  UF_CRM_1782386571874_IU_XLS?: string | null;
}

export function getGzPlanDealIdentity(row: GzPlanIdentityRow): GzPlanDealIdentity {
  const planPointId = resolveGzPlanPointId(row.planUrl, row.planId);
  if (!planPointId) throw new Error("missing canonical plan point ID");

  const legacyPlanId = extractLegacyGzPlanIdFromUrl(row.planUrl)
    ?? (/^\d+$/.test(row.planId.trim()) ? row.planId.trim() : null);
  return {
    planPointId,
    originId: buildGzPlanOriginId(planPointId),
    legacyOriginId: legacyPlanId && legacyPlanId !== planPointId
      ? buildGzPlanOriginId(legacyPlanId)
      : null
  };
}

export function legacyDealMatchesRow(
  row: GzPlanIdentityRow,
  deal: LegacyGzDealIdentityFields
): boolean {
  const identity = getGzPlanDealIdentity(row);
  if (!identity.legacyOriginId || String(deal.ORIGIN_ID ?? "").trim() !== identity.legacyOriginId) {
    return false;
  }

  const dealPlanUrl = firstNonEmpty(
    deal.UF_CRM_PLAN_LINK,
    deal.UF_CRM_1782386571874_IU_XLS
  );
  if (dealPlanUrl) return normalizeUrl(dealPlanUrl) === normalizeUrl(row.planUrl);

  const dealPlanNumber = firstNonEmpty(
    deal.UF_CRM_PLAN_ID,
    deal.UF_CRM_1782386293000_IU_XLS
  );
  return Boolean(dealPlanNumber && dealPlanNumber === row.planNumber.trim());
}

function firstNonEmpty(...values: Array<string | number | null | undefined>): string {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}
