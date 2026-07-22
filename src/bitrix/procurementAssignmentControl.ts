import { verifyProcurementAssignmentGate } from "./procurementDealPlan.js";

type AssignmentDeal = { ID: string | number; ASSIGNED_BY_ID?: string | number | null };
type AssignmentReader = (dealId: string) => Promise<AssignmentDeal | null>;

export interface ProcurementAssignmentWaitOptions {
  managerIds: readonly string[];
  timeoutMs: number;
  pollIntervalMs: number;
}

export async function waitForProcurementAssignments(
  dealIds: string[],
  readDeal: AssignmentReader,
  options: ProcurementAssignmentWaitOptions
): Promise<{ ok: boolean; invalidDealIds: string[] }> {
  const uniqueIds = [...new Set(dealIds.map(String))];
  if (!uniqueIds.length) return { ok: true, invalidDealIds: [] };

  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  let gate = { ok: false, invalidDealIds: uniqueIds };
  do {
    const deals: AssignmentDeal[] = [];
    for (const id of uniqueIds) {
      const deal = await readDeal(id);
      deals.push(deal ?? { ID: id, ASSIGNED_BY_ID: null });
    }
    gate = verifyProcurementAssignmentGate(deals, options.managerIds);
    if (gate.ok || Date.now() >= deadline) return gate;
    await delay(Math.max(0, options.pollIntervalMs));
  } while (true);
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}
