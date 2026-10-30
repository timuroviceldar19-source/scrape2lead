import type { PlanItemChange } from './gzPlanItemChange.js';
import { PortalPlanVerifier, type PortalVerification } from '../kz/goszakupPlanRegistry.js';

export async function filterVerifiedPlanItemUpdates(updates: PlanItemChange[], portal: PortalPlanVerifier): Promise<{
  updates: PlanItemChange[];
  skipped: Array<PortalVerification & { dealId: string; planNumber: number; message: string }>;
}> {
  const confirmed: PlanItemChange[] = [];
  const skipped: Array<PortalVerification & { dealId: string; planNumber: number; message: string }> = [];
  for (const update of updates) {
    const result = await portal.verifyItem(update.current.rootId, update.current.id, update.current.code);
    if (result.reason === 'confirmed') confirmed.push(update);
    else skipped.push({ ...result, dealId: update.dealId, planNumber: update.current.rootId,
      message: result.portalVersion && result.portalVersion > update.current.id ? 'zakup отстаёт от портала' : result.message ?? result.reason });
  }
  return { updates: confirmed, skipped };
}
