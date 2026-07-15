import { createHash } from "node:crypto";
import { parseGzPlanLinkIdentity } from "./gzPlanIdentity.js";

/**
 * Pages loaded per canonical plan point. Kept apart from the legacy-keyed
 * `data/debug` cache, which is forensic evidence rather than a source of truth:
 * its files are named after the second `show_plan` segment, and that segment is
 * shared by several canonical points.
 */
export const GZ_CANONICAL_PLAN_PAGE_DIR = "data/canonical/gz-plan-point";

const H3_BLOCK = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
const NUMBERED_HEADING = /^\s*(\d+)\s*:/;

export interface GzCanonicalUrlVerdict {
  ok: boolean;
  reason?: string;
}

export function canonicalPlanPageFileName(canonicalPlanPointId: string): string {
  return `gz-plan-point-${canonicalPlanPointId}.html`;
}

/**
 * A page is only evidence about the point that was asked for: goszakup answers a
 * stale or amended point with a redirect to another one, and that point's number
 * belongs to a different deal.
 */
export function verifyCanonicalPlanPageUrl(
  finalUrl: string,
  expectedCanonicalPlanPointId: string
): GzCanonicalUrlVerdict {
  const identity = parseGzPlanLinkIdentity(finalUrl);
  if (!identity) {
    return { ok: false, reason: `final url ${finalUrl || "(none)"} is not a goszakup plan point page` };
  }
  if (identity.planPointId !== expectedCanonicalPlanPointId) {
    return {
      ok: false,
      reason: `final url points at ${identity.planPointId}, expected ${expectedCanonicalPlanPointId}`
    };
  }
  return { ok: true };
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

export function hashGzPlanPage(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}
