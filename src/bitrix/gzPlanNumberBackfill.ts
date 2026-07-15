import { parseGzPlanLinkIdentity } from "../kz/gzPlanIdentity.js";

/**
 * GZ lots carry no plan number, so only the plans importer's deals qualify.
 */
export const GZ_PLAN_ORIGINATOR_IDS: readonly string[] = ["scrape2lead-gz-plans"];

const PLAN_NUMBER_FIELD = "UF_CRM_PLAN_ID";
const DUPLICATE_STAGE = /:DUPLICATE$/i;

export interface GzBackfillDeal {
  ID?: string | number;
  TITLE?: string | null;
  CATEGORY_ID?: string | number | null;
  ORIGIN_ID?: string | null;
  ORIGINATOR_ID?: string | null;
  STAGE_ID?: string | null;
  UF_CRM_PLAN_ID?: string | number | null;
  UF_CRM_PLAN_LINK?: string | null;
  UF_CRM_1782386571874_IU_XLS?: string | null;
}

export interface GzPlanNumberSource {
  canonicalPlanPointId: string;
  legacyPlanId: string | null;
}

/** One deal, one canonical page load. Two deals never share a load. */
export interface GzPlanNumberFetchTarget {
  dealId: string;
  canonicalPlanPointId: string;
  planLink: string;
  stageId: string;
}

export interface GzPlanNumberReportEntry {
  dealId: string;
  canonicalPlanPointId: string;
  planNumber: string;
  source: "canonical-page";
  stageId: string;
}

export interface GzPlanNumberUnresolved {
  dealId: string;
  canonicalPlanPointId: string;
  reason: string;
}

export interface GzPlanNumberPlan {
  pending: GzPlanNumberFetchTarget[];
  unresolved: GzPlanNumberUnresolved[];
}

export interface GzPlanNumberWriteDecision {
  action: "write" | "skip-filled" | "drift";
  fields?: { UF_CRM_PLAN_ID: string };
  reason?: string;
}

export function isGzPlanNumberBackfillCandidate(deal: GzBackfillDeal): boolean {
  if (!GZ_PLAN_ORIGINATOR_IDS.includes(text(deal.ORIGINATOR_ID))) return false;
  if (text(deal.UF_CRM_PLAN_ID)) return false;
  return !DUPLICATE_STAGE.test(text(deal.STAGE_ID));
}

export function getGzPlanLink(deal: GzBackfillDeal): string {
  return text(deal.UF_CRM_PLAN_LINK) || text(deal.UF_CRM_1782386571874_IU_XLS);
}

/**
 * The legacy segment is reported for provenance only. It is not an identity and
 * must never key a cache: 26 legacy segments in the live CRM are shared by two
 * canonical points, so a page stored under one is evidence about neither.
 */
export function resolveGzPlanNumberSource(deal: GzBackfillDeal): GzPlanNumberSource | null {
  const identity = parseGzPlanLinkIdentity(getGzPlanLink(deal));
  if (!identity) return null;

  return {
    canonicalPlanPointId: identity.planPointId,
    legacyPlanId: identity.legacyPlanId
  };
}

export function planGzPlanNumberBackfill(deals: readonly GzBackfillDeal[]): GzPlanNumberPlan {
  const pending: GzPlanNumberFetchTarget[] = [];
  const unresolved: GzPlanNumberUnresolved[] = [];

  for (const deal of deals) {
    if (!isGzPlanNumberBackfillCandidate(deal)) continue;

    const dealId = text(deal.ID);
    const source = resolveGzPlanNumberSource(deal);
    if (!source) {
      unresolved.push({ dealId, canonicalPlanPointId: "", reason: "no usable plan link" });
      continue;
    }

    pending.push({
      dealId,
      canonicalPlanPointId: source.canonicalPlanPointId,
      planLink: getGzPlanLink(deal),
      stageId: text(deal.STAGE_ID)
    });
  }

  return { pending, unresolved };
}

export function canExecuteGzPlanNumberBackfill(plan: {
  resolved: readonly GzPlanNumberReportEntry[];
  unresolved: readonly GzPlanNumberUnresolved[];
}): { ok: boolean; reason?: string } {
  if (plan.unresolved.length > 0) {
    const ids = plan.unresolved.map((entry) => entry.dealId).join(", ");
    return { ok: false, reason: `${plan.unresolved.length} unresolved candidate(s): ${ids}` };
  }
  if (plan.resolved.length === 0) {
    return { ok: false, reason: "report contains no resolved candidates" };
  }
  return { ok: true };
}

export function decideGzPlanNumberWrite(
  entry: GzPlanNumberReportEntry,
  deal: GzBackfillDeal
): GzPlanNumberWriteDecision {
  if (DUPLICATE_STAGE.test(text(deal.STAGE_ID))) {
    return { action: "drift", reason: `deal moved to ${text(deal.STAGE_ID)} since the report` };
  }

  const canonical = resolveGzPlanNumberSource(deal)?.canonicalPlanPointId ?? "";
  if (canonical !== entry.canonicalPlanPointId) {
    return {
      action: "drift",
      reason: `plan link now points at ${canonical || "(none)"}, report expected ${entry.canonicalPlanPointId}`
    };
  }

  const current = text(deal.UF_CRM_PLAN_ID);
  if (!current) return { action: "write", fields: buildGzPlanNumberUpdate(entry.planNumber) };
  if (current === entry.planNumber) return { action: "skip-filled" };

  return { action: "drift", reason: `deal already carries ${current}, report expected ${entry.planNumber}` };
}

export function buildGzPlanNumberUpdate(planNumber: string): { UF_CRM_PLAN_ID: string } {
  return { [PLAN_NUMBER_FIELD]: planNumber };
}

function text(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}
