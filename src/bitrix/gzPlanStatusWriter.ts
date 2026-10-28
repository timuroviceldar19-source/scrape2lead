import { callBitrixBatch, chunkBatchCommands, type BitrixBatchCommand } from "./batch.js";
import type { DealFieldUpdate, DealUpdateResult } from "./gzPlanStatusRefresh.js";

/** Plan-status refresh is silent: no live-feed posts for automated updates. */
export const DEAL_UPDATE_PARAMS = { REGISTER_SONET_EVENT: "N" } as const;

export function buildDealUpdateCommands(updates: readonly DealFieldUpdate[]): BitrixBatchCommand[] {
  return updates.map((update) => ({
    key: `deal_${update.dealId}`,
    method: "crm.deal.update",
    params: { id: update.dealId, fields: update.fields, params: DEAL_UPDATE_PARAMS }
  }));
}

export function createBatchDealUpdater(webhookUrl: string, fetchImpl?: typeof fetch) {
  return async (updates: DealFieldUpdate[]): Promise<DealUpdateResult[]> => {
    const results: DealUpdateResult[] = [];
    for (const chunk of chunkBatchCommands(buildDealUpdateCommands(updates))) {
      const response = await callBitrixBatch(webhookUrl, chunk, { fetchImpl });
      for (const command of chunk) {
        const entry = response.get(command.key);
        const dealId = String((command.params as { id: string }).id);
        const error = entry?.error
          ? `${entry.error.error}: ${entry.error.error_description ?? ""}`.trim()
          : entry ? null : "missing batch result";
        results.push({ dealId, error });
      }
    }
    return results;
  };
}
