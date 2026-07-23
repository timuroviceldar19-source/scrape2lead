import { PROCUREMENT_CATEGORY_ID, PROCUREMENT_MANAGER_IDS, PROCUREMENT_ORIGINATOR_ID } from "./procurementDealPlan.js";

export interface ReassignableProcurementDeal {
  ID: string | number;
  CATEGORY_ID?: string | number | null;
  STAGE_ID?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
}

export interface ProcurementReassignment {
  dealId: string;
  previousAssigneeId: string;
  stageId: string | null;
  fields: { ASSIGNED_BY_ID: string };
}

export function planProcurementReassignments(
  deals: readonly ReassignableProcurementDeal[],
  targetAssigneeId: string = PROCUREMENT_MANAGER_IDS[0]
): ProcurementReassignment[] {
  return deals
    .filter((deal) =>
      String(deal.CATEGORY_ID ?? "") === String(PROCUREMENT_CATEGORY_ID) &&
      deal.ORIGINATOR_ID === PROCUREMENT_ORIGINATOR_ID &&
      String(deal.ASSIGNED_BY_ID ?? "") !== targetAssigneeId
    )
    .map((deal) => ({
      dealId: String(deal.ID),
      previousAssigneeId: String(deal.ASSIGNED_BY_ID ?? ""),
      stageId: deal.STAGE_ID ?? null,
      fields: { ASSIGNED_BY_ID: targetAssigneeId }
    }));
}
