import { describe, expect, it } from 'vitest';
import { fetchGzPlans, GzPlanLookup } from '../../src/kz/zakupGzPlans.js';
const json = (body: unknown) => new Response(JSON.stringify(body));
const page = (results: unknown[]) => ({ count: results.length, results });
const context = { bin: '990000000001', year: 2026 };
const detail = { id: 500, external_id: 200, organization: { iin_bin: context.bin }, name_ru: 'Экран', enstru: { code: '279020.100.000002' }, status: { name: 'Утвержден', egz_code: '2' }, year: { year: 2026 }, plan: { act_date: '2026-10-15' }, timestamp: 1792042214 };
const options = { pauseMs: 0, maxRetries: 0, retryDelayMs: 0, orgCachePath: '', contexts: new Map([[100, context], [200, context]]) };
function registry(listed: unknown[], plan = detail, withContract = false) {
  const calls: URL[] = [];
  const fetchFn = (async (url: string) => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.endsWith('/plan-items/')) return json(page(listed));
    if (u.pathname.endsWith('/plan-items/500/')) return json(plan);
    if (u.pathname.endsWith('/organizations/')) return json(page([{id: 42, iin_bin: context.bin}]));
    if (u.pathname.endsWith('/years/')) return json([{id: 12, year: 2026}]);
    if (u.pathname.endsWith('/contract-statuses/')) return json([{id: 6, egz_code: '190', name: 'Действует'}]);
    if (u.pathname.endsWith('/contracts/')) return json(page(withContract ? [{id: 7, contract_number_sys: '990000000001/260001/00', status_id: 6, supplier_organization_id: 8}] : []));
    if (u.pathname.endsWith('/subjects/')) return json([{external_id: 9, plan_item: {id: 500, external_id: 200, root: {external_id: 100}}, contract: {supplier_organization: {id: 8, iin_bin: '990000000002'}}}]);
    throw Error('unexpected '+u.pathname);
  }) as typeof fetch;
  return { fetchFn, calls };
}
describe('поиск версий через q и договоры', () => {
  it('для статуса пункта не требует БИН поставщика постороннего договора', async () => {
    const {fetchFn: base}=registry([],detail,true);
    const fetchFn=(async(url: string,init?: RequestInit)=>{
      const p=new URL(url).pathname;
      if(p.endsWith('/subjects/')) return json([{external_id:9,plan_item:{id:500,external_id:200,root:{external_id:100}}}]);
      if(p.endsWith('/organizations/8/')||p.endsWith('/contracts/7/')) return new Response('not found',{status:404});
      return base(url,init);
    }) as typeof fetch;
    expect((await fetchGzPlans([100],'root',{...options,fetchFn}))[0].id).toBe(200);
  });
  it('ошибка чтения позиций вызывает резерв Plans, даже если ows Contract вернул пустой список', async () => {
    const {fetchFn: base}=registry([],detail,true);
    const fields: string[]=[];
    const fetchFn=(async(url: string,init?: RequestInit)=>{
      const u=new URL(url);
      if(u.hostname==='ows.goszakup.gov.kz') {
        const query=JSON.parse(String(init?.body)).query;
        const field=query.includes('Plans(filter:')?'Plans':'Contract';fields.push(field);
        return json({data:{[field]:field==='Plans'?[{id:200,rootrecordId:100,RefPlnPointStatus:{nameRu:'Утвержден'}}]:null}});
      }
      if(u.pathname.endsWith('/contracts/'))return new Response('down',{status:503});
      return base(url,init);
    }) as typeof fetch;
    const result=await fetchGzPlans([100],'root',{...options,fetchFn,token:'t'});
    expect(result[0]?.id).toBe(200);expect(fields).toContain('Plans');
  });
  it('q принимает только БИН заказчика и год не раньше сделки; даёт текущий товар и дату акта', async () => {
    const { fetchFn, calls } = registry([{ id: 500, external_id: '200' }]);
    const [plan] = await fetchGzPlans([100], 'root', { ...options, fetchFn });
    expect(calls[0].searchParams.get('q')).toBe('100');
    expect(calls.every(u=>u.hostname==='zakup.gov.kz')).toBe(true);
    expect(plan).toEqual({id: 200, rootrecordId: 100, subjectBiin: context.bin, isActive: 1, isDeleted: 0, plnPointYear: 2026, refEnstruCode: '279020.100.000002', nameRu: 'Экран', dateCreate: '2026-10-15 00:00:00', RefPlnPointStatus: {nameRu: 'Утвержден'}});
  });
  it.each([{organization:{iin_bin:'990000000099'}},{year:{year:2025}},{is_externally_deleted: true},{is_externally_active:false}])('отсеивает чужой, старый или удалённый результат %j', async over => {
    const { fetchFn } = registry([{id:500,external_id:200}], {...detail,...over});
    expect(await fetchGzPlans([100], 'root', {...options,fetchFn})).toEqual([]);
  });
  it('если q пуст, берёт связь root из позиций договора; повторно договоры не читает', async () => {
    const {fetchFn,calls}=registry([],detail,true);
    const lookup = new GzPlanLookup({...options,fetchFn});
    const [plan]=await lookup.plans([100],'root',options.contexts);
    expect(plan.id).toBe(200);
    await lookup.contracts(context.bin,[2026]);
    expect(calls.filter(u=>u.pathname.endsWith('/contracts/'))).toHaveLength(1);
  });
  it('точному id не выдумывает корень; timestamp не заменяет отсутствующую дату акта', async () => {
    const {fetchFn}=registry([{id:500,external_id:200}],{...detail,plan:null} as any);
    const [plan]=await fetchGzPlans([200],'id',{...options,fetchFn});
    expect(plan.rootrecordId).toBeNull(); expect(plan.dateCreate).toBe('');
  });
  it('без проверяемого БИН и года не доверяет полнотекстовому совпадению', async () => {
    const {fetchFn}=registry([{id:500,external_id:200}]);
    await expect(fetchGzPlans([100],'root',{...options,contexts:new Map(),fetchFn})).rejects.toThrow(/БИН и года/);
  });
});
