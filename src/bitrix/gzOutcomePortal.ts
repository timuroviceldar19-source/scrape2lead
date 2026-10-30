import { PortalPlanVerifier, type PortalVerification } from '../kz/goszakupPlanRegistry.js';
import { decideGzDealOutcome, gzDealOutcomeKey, readGzPlanSignal, type GzDealPlanRef, type GzDealOutcome, type GzOutcomeConfig } from './gzDealOutcome.js';

/** Договоры уже подтверждены позициями; новый ключ плана требует совпадения с порталом. */
export async function verifyGzPlanOutcome(
  portal: PortalPlanVerifier, ref: GzDealPlanRef, version: number | null,
  candidate: GzDealOutcome, config: GzOutcomeConfig
): Promise<PortalVerification | null> {
  if (!['published', 'failed', 'cancelled', 'contract-draft', 'repurposed'].includes(candidate.kind)) return null;
  return portal.verify(ref.planNumber ?? 0, version, async row => {
    const detail = candidate.kind === 'repurposed' ? await portal.detail(row) : null;
    const signal = readGzPlanSignal(ref, { status: row.status, name: row.item_name,
      enstruCode: detail?.ref_enstru_code, exactPoint: ref.pointIds.includes(Number(row.plan_point_id)) }, config.itemFamilies);
    const outcome = decideGzDealOutcome(ref, [], signal, config);
    return !!outcome && gzDealOutcomeKey(outcome) === gzDealOutcomeKey(candidate);
  });
}
