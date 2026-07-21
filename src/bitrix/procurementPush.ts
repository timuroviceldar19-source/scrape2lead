import type { ProcurementRecord } from "../kz/procurement/types.js";
import {
  buildProcurementDealDecision,
  PROCUREMENT_ORIGINATOR_ID,
  procurementOpportunityOriginId,
  type ExistingProcurementDeal
} from "./procurementDealPlan.js";

export interface ProcurementPushClient {
  findByOrigin(originatorId: string, originId: string): Promise<ExistingProcurementDeal | null>;
  findPotentialDuplicate(record: ProcurementRecord): Promise<ExistingProcurementDeal | null>;
  addDeal(fields: Record<string, unknown>): Promise<string>;
  updateDeal(id: string, fields: Record<string, unknown>): Promise<void>;
}

export interface ProcurementPushItem {
  record: ProcurementRecord;
  action: "create" | "update" | "duplicate" | "failed";
  dealId: string | null;
  fields: Record<string, unknown>;
  error: string | null;
}

export async function planProcurementPush(
  records: ProcurementRecord[],
  client: ProcurementPushClient,
  options: { execute: boolean }
): Promise<{ items: ProcurementPushItem[]; counts: { create: number; update: number; duplicate: number; failed: number } }> {
  const items: ProcurementPushItem[] = [];
  const counts = { create: 0, update: 0, duplicate: 0, failed: 0 };
  for (const record of records) {
    try {
      const originId = procurementOpportunityOriginId(record);
      const existing = await client.findByOrigin(PROCUREMENT_ORIGINATOR_ID, originId);
      if (!existing) {
        const duplicate = await client.findPotentialDuplicate(record);
        if (duplicate) {
          counts.duplicate += 1;
          items.push({ record, action: "duplicate", dealId: String(duplicate.ID), fields: {}, error: null });
          continue;
        }
      }
      const decision = buildProcurementDealDecision(record, existing);
      let dealId = decision.dealId;
      if (options.execute && decision.action === "create") dealId = await client.addDeal(decision.fields);
      if (options.execute && decision.action === "update" && dealId) await client.updateDeal(dealId, decision.fields);
      counts[decision.action] += 1;
      items.push({ record, action: decision.action, dealId, fields: decision.fields, error: null });
    } catch (error) {
      counts.failed += 1;
      items.push({ record, action: "failed", dealId: null, fields: {}, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { items, counts };
}
