import { describe, expect, it, vi } from 'vitest';
import { PortalPlanVerifier, searchPlanRows, fetchPortalPage, PortalThrottledError, HtmlBudgetError } from '../../src/kz/goszakupPlanRegistry.js';
import type { GoszakupPlanListItem } from '../../src/kz/goszakupPlanTypes.js';

const row = (version = 200, status = 'Опубликован', root = '100') => ({
  plan_list_number: root, plan_point_id: String(version), status,
  detail_url: `https://procurement.gov.kz/ru/registry/show_plan/${version}/1`, item_name: 'Экран'
}) as GoszakupPlanListItem;
const reader = (rows: GoszakupPlanListItem[]) => new PortalPlanVerifier({
  delayMs: 0, searchFn: async () => rows, detailFn: async () => ({ ref_enstru_code: '279020.100.000002' })
});

describe('подтверждение источника реестром портала', () => {
  it('исчерпание бюджета отличимо от недоступности портала для общего обхода', async () => {
    await expect(fetchPortalPage('https://procurement.gov.kz', { deadline: 0 })).rejects.toBeInstanceOf(HtmlBudgetError);
  });
  it('не принимает опубликованный пункт, если портал показывает проект договора', async () => {
    expect((await reader([row(200, 'Проект договора')]).verify(100, 200, r => r.status === 'Опубликован')).reason).toBe('source_conflict');
  });
  it('подтверждает только совпавшую новую версию и статус', async () => {
    expect((await reader([row(199, 'Проект договора'), row()]).verify(100, 200, r => r.status === 'Опубликован')).reason).toBe('confirmed');
  });
  it.each([[201, 'Опубликован'], [199, 'Опубликован']])('отклоняет несовпавшую версию %s', async (version, status) => {
    expect((await reader([row(version, status)]).verify(100, 200, () => true)).reason).toBe('source_conflict');
  });
  it('не подставляет строку соседнего номера и не подтверждает пустой результат', async () => {
    expect((await reader([row(200, 'Опубликован', '1000')]).verify(100, 200, () => true)).reason).toBe('source_conflict');
  });
  it('при недоступности портала пропускает запись отдельно от конфликтов', async () => {
    const verifier = new PortalPlanVerifier({ delayMs: 0, searchFn: async () => { throw Error('offline'); } });
    expect((await verifier.verify(100, 200, () => true)).reason).toBe('portal_unavailable');
  });
  it('проверяет код карточки совпавшей версии и останавливает старый товар', async () => {
    expect((await reader([row(201)]).verifyItem(100, 200, '279020.100.000002')).reason).toBe('source_conflict');
    expect((await reader([row()]).verifyItem(100, 200, '279020.100.000002')).reason).toBe('confirmed');
    expect((await reader([row()]).verifyItem(100, 200, '262030.100.000043')).reason).toBe('source_conflict');
  });
  it('недоступная карточка и карточка без кода не разрешают правку товара', async () => {
    for (const detailFn of [async () => null, async () => { throw Error('offline'); }]) {
      const verifier = new PortalPlanVerifier({ delayMs: 0, searchFn: async () => [row()], detailFn });
      expect((await verifier.verifyItem(100, 200, '279020.100.000002')).reason).toBe('portal_unavailable');
    }
  });
  it('пауза не выходит за общий бюджет', async () => {
    const verifier = new PortalPlanVerifier({ deadline: 100, now: () => 0, delayMs: 1500, searchFn: async () => [row()] });
    await verifier.verify(100, 200, () => true);
    expect((await verifier.verify(101, 200, () => true)).reason).toBe('html_budget');
  });
  it('повторяет короткую страницу один раз и учитывает бюджет повторения', async () => {
    const fetchFn = vi.fn(async () => new Response('short')) as unknown as typeof fetch;
    const sleepFn = vi.fn(async () => {});
    await expect(fetchPortalPage('https://procurement.gov.kz', { fetchFn, sleepFn })).rejects.toBeInstanceOf(PortalThrottledError);
    expect(sleepFn).toHaveBeenCalledWith(30_000);
    await expect(fetchPortalPage('https://procurement.gov.kz', { fetchFn, deadline: 100, now: () => 0 })).rejects.toThrow();
  });
  it('не принимает ошибку HTTP и сохраняет причину сетевого сбоя', async () => {
    await expect(fetchPortalPage('https://procurement.gov.kz', { fetchFn: (async () => new Response('', { status: 503 })) as typeof fetch })).rejects.toThrow('503');
    await expect(fetchPortalPage('https://procurement.gov.kz', { fetchFn: (async () => { throw new Error('fetch failed', { cause: { code: 'ECONNRESET' } }); }) as typeof fetch })).rejects.toThrow('ECONNRESET');
  });
  it('не делает запросы после общего бюджета HTML', async () => {
    const searchFn = vi.fn(async () => [row()]);
    const verifier = new PortalPlanVerifier({ searchFn, deadline: 100, now: () => 100, delayMs: 0 });
    expect((await verifier.verify(100, 200, () => true)).reason).toBe('html_budget');
    expect(searchFn).not.toHaveBeenCalled();
  });
  it('пауза и кэш общие для последовательных проверок', async () => {
    const searchFn = vi.fn(async () => [row()]); const sleepFn = vi.fn(async () => {});
    const verifier = new PortalPlanVerifier({ searchFn, sleepFn, now: () => 0, delayMs: 1500 });
    await verifier.verify(100, 200, () => true); await verifier.verify(100, 200, () => true);
    await verifier.verify(101, 200, () => true);
    expect(searchFn).toHaveBeenCalledTimes(2); expect(sleepFn).toHaveBeenCalledWith(1500);
  });
  it('запрос реестра фильтрует номер точно и проверяет число до сети', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>' + ' '.repeat(11000) + '</html>')) as unknown as typeof fetch;
    expect(await searchPlanRows(100, { fetchFn })).toEqual([]);
    expect(new URL(String((fetchFn as any).mock.calls[0][0])).searchParams.get('filter[number]')).toBe('100');
    await expect(searchPlanRows(NaN, { fetchFn })).rejects.toThrow();
  });
});
