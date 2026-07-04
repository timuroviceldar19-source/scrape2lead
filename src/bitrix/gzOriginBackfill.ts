import { GZ_ORIGINATOR_ID } from "./gzLeadCleanup.js";

export const GZ_PLAN_LINK_FIELD = "UF_CRM_PLAN_LINK";
export const GZ_PLAN_POINT_ID_FIELD = "UF_CRM_6A436D5A3614C";

export interface BackfillCandidateDeal {
  ID?: string | number;
  TITLE?: string | null;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
  [GZ_PLAN_LINK_FIELD]?: string | null;
  [GZ_PLAN_POINT_ID_FIELD]?: string | null;
}

export type BackfillAction =
  | { action: "backfill"; originId: string; planId: string }
  | { action: "already-keyed" }
  | { action: "foreign-origin" }
  | { action: "no-plan-id" }
  | { action: "conflict"; originId: string; claimedByDealId: string };

const SHOW_PLAN_URL_PATTERN = /\/registry\/show_plan\/\d+\/(\d+)(?:[/?#]|$)/;

export function extractPlanIdFromUrl(url: string | null | undefined): string | null {
  const match = (url ?? "").trim().match(SHOW_PLAN_URL_PATTERN);
  return match?.[1] ?? null;
}

export function buildGzOriginId(planId: string): string {
  return `gz-plan:${planId}`;
}

export interface BackfillOptions {
  /** Originator ids whose deals may be re-keyed when their ORIGIN_ID is empty. */
  claimOriginators?: ReadonlySet<string>;
}

export function decideBackfillAction(
  deal: BackfillCandidateDeal,
  claimedOrigins: ReadonlyMap<string, string>,
  options: BackfillOptions = {}
): BackfillAction {
  const originatorId = String(deal.ORIGINATOR_ID ?? "").trim();
  const originId = String(deal.ORIGIN_ID ?? "").trim();

  if (originatorId === GZ_ORIGINATOR_ID && originId) return { action: "already-keyed" };
  if (originatorId && originatorId !== GZ_ORIGINATOR_ID) {
    const claimable = !originId && (options.claimOriginators?.has(originatorId) ?? false);
    if (!claimable) return { action: "foreign-origin" };
  }
  if (originId) return { action: "foreign-origin" };

  const planId = String(deal[GZ_PLAN_POINT_ID_FIELD] ?? "").trim().match(/^\d+$/)?.[0]
    ?? extractPlanIdFromUrl(deal[GZ_PLAN_LINK_FIELD]);
  if (!planId) return { action: "no-plan-id" };

  const newOriginId = buildGzOriginId(planId);
  const claimedByDealId = claimedOrigins.get(newOriginId);
  if (claimedByDealId && claimedByDealId !== String(deal.ID ?? "")) {
    return { action: "conflict", originId: newOriginId, claimedByDealId };
  }

  return { action: "backfill", originId: newOriginId, planId };
}

export function buildBackfillFields(planId: string): Record<string, unknown> {
  return {
    ORIGINATOR_ID: GZ_ORIGINATOR_ID,
    ORIGIN_ID: buildGzOriginId(planId),
    [GZ_PLAN_POINT_ID_FIELD]: planId
  };
}
