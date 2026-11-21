import type { ProcurementRecord } from "../kz/procurement/types.js";
import {
  buildProcurementDealDecision,
  PROCUREMENT_ORIGINATOR_ID,
  procurementOpportunityOriginId,
  type ExistingProcurementDeal
} from "./procurementDealPlan.js";
import type { ProcurementCustomerResolution, ProcurementCustomerResolver } from "./procurementCustomer.js";

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
  /** Компания заказчика: найдена, создана (или была бы создана в dry-run), либо не определена. */
  customer?: ProcurementCustomerResolution | null;
}

export interface ProcurementPushOptions {
  execute: boolean;
  /** Без резолвера сделки создаются без компании, как раньше. */
  resolveCustomer?: ProcurementCustomerResolver;
}

export async function planProcurementPush(
  records: ProcurementRecord[],
  client: ProcurementPushClient,
  options: ProcurementPushOptions
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
      const customer = needsCustomer(existing) ? await resolveCustomerSafely(record, options.resolveCustomer) : null;
      const fields = customer?.companyId ? { ...decision.fields, COMPANY_ID: customer.companyId } : decision.fields;
      let dealId = decision.dealId;
      if (options.execute && decision.action === "create") dealId = await client.addDeal(fields);
      if (options.execute && decision.action === "update" && dealId) await client.updateDeal(dealId, fields);
      counts[decision.action] += 1;
      items.push({ record, action: decision.action, dealId, fields, error: null, customer });
    } catch (error) {
      counts.failed += 1;
      items.push({ record, action: "failed", dealId: null, fields: {}, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { items, counts };
}

/** Ручную привязку менеджера не перетираем: компанию ставим только туда, где её нет. */
function needsCustomer(existing: ExistingProcurementDeal | null): boolean {
  return !existing || !(Number(existing.COMPANY_ID ?? 0) > 0);
}

/** Сбой поиска компании не должен терять сделку: заливаем без компании и пишем причину в отчёт. */
async function resolveCustomerSafely(
  record: ProcurementRecord,
  resolve: ProcurementCustomerResolver | undefined
): Promise<ProcurementCustomerResolution | null> {
  if (!resolve) return null;
  try {
    return await resolve(record);
  } catch (error) {
    return { action: "none", companyId: null, warning: `customer: ${error instanceof Error ? error.message : String(error)}` };
  }
}
