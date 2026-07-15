import { parseGzPlanLinkIdentity } from "../kz/gzPlanIdentity.js";

/**
 * GZ lots carry no plan number, so only the plans importer's deals qualify.
 */
export const GZ_PLAN_ORIGINATOR_IDS: readonly string[] = ["scrape2lead-gz-plans"];

const PLAN_NUMBER_FIELD = "UF_CRM_PLAN_ID";
const DUPLICATE_STAGE = /:DUPLICATE$/i;
const H3_BLOCK = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
const NUMBERED_HEADING = /^\s*(\d+)\s*:/;

export interface GzBackfillDeal {
  ID?: string | number;
  ORIGINATOR_ID?: string | null;
  STAGE_ID?: string | null;
  UF_CRM_PLAN_ID?: string | number | null;
  UF_CRM_PLAN_LINK?: string | null;
  UF_CRM_1782386571874_IU_XLS?: string | null;
}

export interface GzPlanNumberSource {
  canonicalPlanPointId: string;
  legacyPlanId: string | null;
  /** The snapshot is keyed by the legacy segment, never by the canonical id. */
  snapshotId: string | null;
}

export interface GzPlanNumberReportEntry {
  dealId: string;
  canonicalPlanPointId: string;
  planNumber: string;
  source: "snapshot" | "playwright";
  stageId: string;
}

export interface GzPlanNumberUnresolved {
  dealId: string;
  canonicalPlanPointId: string;
  reason: string;
}

export interface GzPlanNumberPlan {
  resolved: GzPlanNumberReportEntry[];
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

export function resolveGzPlanNumberSource(deal: GzBackfillDeal): GzPlanNumberSource | null {
  const identity = parseGzPlanLinkIdentity(getGzPlanLink(deal));
  if (!identity) return null;

  return {
    canonicalPlanPointId: identity.planPointId,
    legacyPlanId: identity.legacyPlanId,
    snapshotId: identity.legacyPlanId
  };
}

/**
 * Reads the plan number from the page heading (`<h3>86795650: Доска специальная</h3>`).
 * The page also carries an unnumbered site announcement heading, and a page that
 * offers two different numbers is ambiguous rather than authoritative.
 */
export function extractGzPlanNumberFromHeading(html: string): string | null {
  const numbers = new Set<string>();
  for (const match of html.matchAll(H3_BLOCK)) {
    const numbered = match[1].match(NUMBERED_HEADING);
    if (numbered) numbers.add(numbered[1]);
  }
  return numbers.size === 1 ? [...numbers][0] : null;
}

export function planGzPlanNumberBackfill(
  deals: readonly GzBackfillDeal[],
  options: { readSnapshot: (snapshotId: string) => string | null }
): GzPlanNumberPlan {
  const resolved: GzPlanNumberReportEntry[] = [];
  const unresolved: GzPlanNumberUnresolved[] = [];

  for (const deal of deals) {
    if (!isGzPlanNumberBackfillCandidate(deal)) continue;

    const dealId = text(deal.ID);
    const source = resolveGzPlanNumberSource(deal);
    if (!source) {
      unresolved.push({ dealId, canonicalPlanPointId: "", reason: "no usable plan link" });
      continue;
    }

    const html = source.snapshotId ? options.readSnapshot(source.snapshotId) : null;
    if (!html) {
      unresolved.push({
        dealId,
        canonicalPlanPointId: source.canonicalPlanPointId,
        reason: "no local snapshot"
      });
      continue;
    }

    const planNumber = extractGzPlanNumberFromHeading(html);
    if (!planNumber) {
      unresolved.push({
        dealId,
        canonicalPlanPointId: source.canonicalPlanPointId,
        reason: "no numbered heading in snapshot"
      });
      continue;
    }

    resolved.push({
      dealId,
      canonicalPlanPointId: source.canonicalPlanPointId,
      planNumber,
      source: "snapshot",
      stageId: text(deal.STAGE_ID)
    });
  }

  return { resolved, unresolved };
}

export function canExecuteGzPlanNumberBackfill(plan: GzPlanNumberPlan): { ok: boolean; reason?: string } {
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
