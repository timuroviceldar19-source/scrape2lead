import { expect, it, vi } from 'vitest';
import { verifyGzPlanOutcome, prefetchGzPlanOutcomeProofs } from '../../src/bitrix/gzOutcomePortal.js';
import { PortalPlanVerifier } from '../../src/kz/goszakupPlanRegistry.js';
import type { GzDealPlanRef, GzOutcomeConfig, GzDealOutcome } from '../../src/bitrix/gzDealOutcome.js';
import type { GoszakupPlanListItem } from '../../src/kz/goszakupPlanTypes.js';

const ref: GzDealPlanRef = { planNumber: 100, pointIds: [200], revisionIds: [], planNumberVerified: true, itemName: 'Экран', enstruCode: '279020.100.000002' };
const config: GzOutcomeConfig = { ourBins: [], partnerBins: [], itemFamilies: { groups: [], wildcards: [] } };
it('переделанный товар подтверждается карточкой версии; предварительное чтение не повторяется', async () => {
  const detailFn = vi.fn(async () => ({ ref_enstru_code: '531011.100.000000' }));
  const portal = new PortalPlanVerifier({ delayMs: 0,
    searchFn: async () => [{ plan_list_number: '100', plan_point_id: '201', item_name: 'Услуги', status: 'Утвержден' }] as GoszakupPlanListItem[], detailFn });
  const candidate: GzDealOutcome = { kind: 'repurposed', newItem: 'Услуги' };
  await prefetchGzPlanOutcomeProofs(portal, [{ ref, candidate, previousKey: null }]);
  expect((await verifyGzPlanOutcome(portal, ref, 201, candidate, config))?.reason).toBe('confirmed');
  expect(detailFn).toHaveBeenCalledTimes(1);
});
it('отказ предварительного чтения сохраняется до финального решения, пустые кандидаты не запрашиваются', async () => {
  const searchFn = vi.fn(async () => { throw Error('offline'); });
  const portal = new PortalPlanVerifier({ delayMs: 0, searchFn });
  const candidate: GzDealOutcome = { kind: 'published', planStatus: 'Опубликован' };
  await prefetchGzPlanOutcomeProofs(portal, [
    { ref, candidate: null, previousKey: null }, { ref: { ...ref, planNumber: null }, candidate, previousKey: null },
    { ref, candidate, previousKey: null }
  ]);
  expect((await verifyGzPlanOutcome(portal, ref, 200, candidate, config))?.reason).toBe('portal_unavailable');
  expect(searchFn).toHaveBeenCalledTimes(1);
});
it('новый ключ получает бюджет до фонового обхода; неизменённые и договорные ключи не загружаются', async () => {
  let now = 0;
  const searchFn = vi.fn(async () => [{ plan_list_number: '100', plan_point_id: '200', status: 'Опубликован' }] as GoszakupPlanListItem[]);
  const portal = new PortalPlanVerifier({ delayMs: 0, deadline: 100, now: () => now, searchFn });
  const candidate: GzDealOutcome = { kind: 'published', planStatus: 'Опубликован' };
  await prefetchGzPlanOutcomeProofs(portal, [
    { ref, candidate, previousKey: 'cancelled:отменен' },
    { ref: { ...ref, planNumber: 101 }, candidate, previousKey: 'published:опубликован' },
    { ref: { ...ref, planNumber: 102 }, candidate: { kind: 'won' } as GzDealOutcome, previousKey: null }
  ]);
  now = 100;
  expect((await verifyGzPlanOutcome(portal, ref, 200, candidate, config))?.reason).toBe('confirmed');
  expect(searchFn).toHaveBeenCalledTimes(1);
});
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
