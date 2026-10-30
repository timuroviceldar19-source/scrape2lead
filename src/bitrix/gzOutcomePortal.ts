import { PortalPlanVerifier, type PortalVerification } from '../kz/goszakupPlanRegistry.js';
import { decideGzDealOutcome, gzDealOutcomeKey, readGzPlanSignal, shouldReplaceGzOutcomeKey, type GzDealPlanRef, type GzDealOutcome, type GzOutcomeConfig } from './gzDealOutcome.js';

const PLAN_KINDS = new Set(['published', 'failed', 'cancelled', 'contract-draft', 'repurposed']);

/** Новые ключи получают бюджет раньше длинного обхода планов без сигнала. Ошибки остаются в кэше для финального решения. */
export async function prefetchGzPlanOutcomeProofs(portal: PortalPlanVerifier, candidates: Array<{
  ref: GzDealPlanRef; candidate: GzDealOutcome | null; previousKey: string | null | undefined;
}>): Promise<number> {
  let attempted = 0;
  for (const { ref, candidate, previousKey } of candidates) {
    if (!ref.planNumber || !candidate || !PLAN_KINDS.has(candidate.kind)
      || !shouldReplaceGzOutcomeKey(previousKey, gzDealOutcomeKey(candidate))) continue;
    attempted++;
    try {
      const rows = await portal.search(ref.planNumber);
      if (candidate.kind === 'repurposed') {
        const latest = [...rows].sort((a, b) => Number(b.plan_point_id) - Number(a.plan_point_id))[0];
        if (latest) await portal.detail(latest);
      }
    } catch { /* Итоговая проверка прочитает тот же отказ и запишет отдельную причину пропуска. */ }
  }
  return attempted;
}

/** Договоры уже подтверждены позициями; новый ключ плана требует совпадения с порталом. */
export async function verifyGzPlanOutcome(
  portal: PortalPlanVerifier, ref: GzDealPlanRef, version: number | null,
  candidate: GzDealOutcome, config: GzOutcomeConfig
): Promise<PortalVerification | null> {
  if (!PLAN_KINDS.has(candidate.kind)) return null;
  return portal.verify(ref.planNumber ?? 0, version, async row => {
    const detail = candidate.kind === 'repurposed' ? await portal.detail(row) : null;
    const signal = readGzPlanSignal(ref, { status: row.status, name: row.item_name,
      enstruCode: detail?.ref_enstru_code, exactPoint: ref.pointIds.includes(Number(row.plan_point_id)) }, config.itemFamilies);
    const outcome = decideGzDealOutcome(ref, [], signal, config);
    return !!outcome && gzDealOutcomeKey(outcome) === gzDealOutcomeKey(candidate);
  });
}
