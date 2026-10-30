import { expect, it, vi } from 'vitest';
import { gzDealBin, loadCompanyBins } from '../../src/bitrix/gzDealBin.js';
import { planItemChange } from '../../src/bitrix/gzPlanItemChange.js';

it('использует БИН компании для проверки товара, а при его отсутствии пропускает сделку', async () => {
  const deals = [{ ID: 1, COMPANY_ID: '10', ORIGIN_ID: 'gz-plan:100', UF_CRM_PLAN_ID: '100', DATE_CREATE: '2026-01-01', UF_CRM_REF_ENSTRU_CODE: '111111.111.111111' }];
  const call = vi.fn(async () => [{ ID: '10', UF_CRM_666171B20E9E3: '990000000001' }]);
  const bins = await loadCompanyBins(deals, call);
  const item = { id: 200, rootId: 100, bin: '990000000001', year: 2026, code: '222222.222.222222', name: 'Товар', createdAt: '2026-02-01' };
  expect(planItemChange({ ...deals[0], UF_CRM_6627AEBD7C2D2: gzDealBin(deals[0], bins) }, item)).not.toBeNull();
  expect(gzDealBin(deals[0])).toBeNull();
  expect(call).toHaveBeenCalledWith(['10']);
});
