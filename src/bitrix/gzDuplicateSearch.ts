const PLAN_POINT_FIELD = "UF_CRM_6A436D5A3614C";
const PLAN_NUMBER_FIELD = "UF_CRM_PLAN_ID";
const PLAN_URL_FIELD = "UF_CRM_PLAN_LINK";
const PLAN_URL_ALT_FIELD = "UF_CRM_1782386571874_IU_XLS";
const COMPANY_BIN_FIELD = "UF_CRM_6627AEBD7C2D2";

export interface GzDuplicateSearchInput {
  planPointId: string;
  planNumber: string;
  planUrl: string;
  bin: string | null;
  amount: number;
}

export interface GzDuplicateSearch {
  reason: string;
  filter: Record<string, unknown>;
  blocking: boolean;
}

export function buildGzDuplicateSearches(input: GzDuplicateSearchInput): GzDuplicateSearch[] {
  const searches: GzDuplicateSearch[] = [];

  if (input.planPointId) {
    searches.push({
      reason: "plan point id",
      filter: { [PLAN_POINT_FIELD]: input.planPointId },
      blocking: true
    });
  }
  if (input.planNumber) {
    searches.push({
      reason: "plan number",
      filter: { [PLAN_NUMBER_FIELD]: input.planNumber },
      blocking: true
    });
  }
  if (input.planUrl) {
    searches.push({
      reason: "plan url",
      filter: { [PLAN_URL_FIELD]: input.planUrl },
      blocking: true
    });
    searches.push({
      reason: "plan url alt",
      filter: { [PLAN_URL_ALT_FIELD]: input.planUrl },
      blocking: true
    });
  }
  // A customer routinely plans several distinct items at an identical round
  // price, so BIN + amount cannot establish identity. It stays as an advisory
  // signal for manually created deals that carry no plan fields at all.
  if (input.bin && input.amount > 0) {
    searches.push({
      reason: "BIN + amount",
      filter: { [COMPANY_BIN_FIELD]: input.bin, OPPORTUNITY: input.amount },
      blocking: false
    });
  }

  return searches;
}

export interface GzDuplicateCandidateDeal {
  ID?: string | number;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
}

export interface GzDuplicateEvaluation<T extends GzDuplicateCandidateDeal> {
  deal: T;
  reason: string;
  blocking: boolean;
}

/**
 * Picks a duplicate from pre-fetched per-search result sets, mirroring the
 * sequential lookup semantics exactly: searches are evaluated in build order,
 * the first previously unseen deal wins, and a deal that carries the row's own
 * canonical originator/origin pair is never a duplicate of itself.
 */
export function evaluateGzDuplicateSearchResults<T extends GzDuplicateCandidateDeal>(
  searches: readonly GzDuplicateSearch[],
  resultsBySearch: ReadonlyArray<readonly T[]>,
  currentOrigin: { originatorId: string; originId: string }
): GzDuplicateEvaluation<T> | null {
  const seen = new Set<string>();

  for (let index = 0; index < searches.length; index++) {
    const search = searches[index];
    for (const deal of resultsBySearch[index] ?? []) {
      const id = String(deal.ID ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (
        String(deal.ORIGINATOR_ID ?? "") === currentOrigin.originatorId
        && String(deal.ORIGIN_ID ?? "") === currentOrigin.originId
      ) {
        continue;
      }
      return { deal, reason: search.reason, blocking: search.blocking };
    }
  }

  return null;
}
