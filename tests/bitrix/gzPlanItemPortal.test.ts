import { expect, it } from 'vitest';
import { filterVerifiedPlanItemUpdates } from '../../src/bitrix/gzPlanItemPortal.js';
import { PortalPlanVerifier } from '../../src/kz/goszakupPlanRegistry.js';
import type { PlanItemChange } from '../../src/bitrix/gzPlanItemChange.js';
import type { GoszakupPlanListItem } from '../../src/kz/goszakupPlanTypes.js';
const update = { dealId: '1', current: { rootId: 100, id: 200, code: '279020.100.000002' } } as PlanItemChange;
it.each([201, 200])('правку товара разрешает только совпавшая версия: портал %s', async version => {
  const portal = new PortalPlanVerifier({ delayMs: 0, searchFn: async () => [{ plan_list_number: '100', plan_point_id: String(version) }] as GoszakupPlanListItem[], detailFn: async () => ({ ref_enstru_code: update.current.code }) });
  const result = await filterVerifiedPlanItemUpdates([update], portal);
  expect(result.updates).toHaveLength(version === 200 ? 1 : 0);
  expect(result.skipped).toHaveLength(version === 200 ? 0 : 1);
});
it('не пишет товар при недоступности портала', async () => {
  const portal = new PortalPlanVerifier({ delayMs: 0, searchFn: async () => { throw Error('offline'); } });
  const result = await filterVerifiedPlanItemUpdates([update], portal);
  expect(result.updates).toEqual([]); expect(result.skipped[0].reason).toBe('portal_unavailable');
});
