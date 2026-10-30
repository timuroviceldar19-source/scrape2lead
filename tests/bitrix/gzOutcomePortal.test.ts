import { expect, it, vi } from 'vitest';
import { verifyGzPlanOutcome } from '../../src/bitrix/gzOutcomePortal.js';
import { PortalPlanVerifier } from '../../src/kz/goszakupPlanRegistry.js';
import type { GzDealPlanRef, GzOutcomeConfig, GzDealOutcome } from '../../src/bitrix/gzDealOutcome.js';
import type { GoszakupPlanListItem } from '../../src/kz/goszakupPlanTypes.js';

const ref: GzDealPlanRef = { planNumber: 100, pointIds: [200], revisionIds: [], planNumberVerified: true, itemName: 'Экран', enstruCode: '279020.100.000002' };
const config: GzOutcomeConfig = { ourBins: [], partnerBins: [], itemFamilies: { groups: [], wildcards: [] } };
it.each(['Проект договора', 'Отменен'])('ключ published блокируется при статусе портала %s', async status => {
  const portal = new PortalPlanVerifier({ delayMs: 0, searchFn: async () => [{ plan_list_number: '100', plan_point_id: '200', status }] as GoszakupPlanListItem[] });
  expect((await verifyGzPlanOutcome(portal, ref, 200, { kind: 'published', planStatus: 'Опубликован' }, config))?.reason).toBe('source_conflict');
});
it('published подтверждается совпавшей версией и ключом портала', async () => {
  const portal = new PortalPlanVerifier({ delayMs: 0, searchFn: async () => [{ plan_list_number: '100', plan_point_id: '200', status: 'Опубликован' }] as GoszakupPlanListItem[] });
  expect((await verifyGzPlanOutcome(portal, ref, 200, { kind: 'published', planStatus: 'Опубликован' }, config))?.reason).toBe('confirmed');
});
it('недоступный портал не подтверждает новый ключ', async () => {
  const portal = new PortalPlanVerifier({ delayMs: 0, searchFn: async () => { throw Error('offline'); } });
  expect((await verifyGzPlanOutcome(portal, ref, 200, { kind: 'published', planStatus: 'Опубликован' }, config))?.reason).toBe('portal_unavailable');
});
it.each(['won', 'lost', 'partner', 'terminated'] as const)('договорный исход %s не требует проверки плана', async kind => {
  const searchFn = vi.fn(async () => []);
  const portal = new PortalPlanVerifier({ searchFn });
  expect(await verifyGzPlanOutcome(portal, ref, null, { kind } as GzDealOutcome, config)).toBeNull();
  expect(searchFn).not.toHaveBeenCalled();
});
