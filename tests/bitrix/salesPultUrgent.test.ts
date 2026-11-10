import { describe, it, expect, vi } from 'vitest';
import { fixture } from '../fixtures/sales-pult/contracts.js';
import { buildPultSignals } from '../../src/bitrix/salesPult/signals.js';
import { buildPultView } from '../../src/bitrix/salesPult/view.js';
import { attachRegisterContracts } from '../../src/bitrix/salesPult/contracts.js';
import { ReadOnlyBitrixClient } from '../../src/bitrix/reporting/readOnlyClient.js';
import { collectPultData } from '../../src/bitrix/salesPult/collect.js';

describe('Д3: Срочно', () => {
  it('omits table debts, calls, ready-to-close and contract celebrations even after 14:00', () => {
    const {payload} = fixture();
    payload.generatedAt = '2026-10-28 15:10 (UTC+5)';
    for (const g of payload.groups) for (const m of g.managers) {
      m.debts = {overdue: 8, overdueOverMonth: 6, overdueOngoing: 3, newDeals: 4, newStaleDeals: 4, newOldestAgeDays: 3, readyToCloseDealIds: ['111'], wonOnPortalNotClosed: 2};
      m.rollups.signals = {zeroBitrixCallsToday:true, zeroKpThreeDays:false};
      m.rollups.day.contracts.uniqueDealsCount = 2;
    }
    expect(buildPultSignals(payload)).toEqual([]);
    expect(buildPultView(payload)).toMatchObject({signalsUrgent:0, signalsMeta:'Срочного нет'});
  });
  it('counts all remaining rows plus each mismatch deal, without duplicating the box', () => {
    const f = fixture();
    f.payload.callsAvailable = false;
    f.payload.outcomeMismatches = [1,2].map(n => ({id:String(n), title:'Тест', amount:10, managerId:'777', managerName:'Тестовый владелец', outcome:'won:test'}));
    attachRegisterContracts(f.payload, f.register, f.deals, f.aliases);
    const signals = buildPultSignals(f.payload);
    expect(signals.map(s=>s.color)).toEqual(['red','yellow','gray']);
    expect(signals.map(s=>s.text).join(' ')).not.toMatch(/Ошибка в CRM|Есть в ОП|Закрыто в Битриксе/);
    expect(buildPultView(f.payload).signalsUrgent).toBe(5);
  });
  it('moves reconciliation to structured data after two working days and keeps it out of main signals', () => {
    const f=fixture([{id:'777',title:'Дельта',amount:200,assignedById:'s',contractDate:'2026-10-23',stageSemanticId:'S'}]);
    attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    expect(f.payload.contractSource?.reconciliation.closedNotInRegister).toEqual([]);
    f.payload.asOfDate='2026-10-29';
    attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    expect(f.payload.contractSource?.reconciliation).toEqual({
      closedNotInRegister:[{dealId:'d2',title:'Бета',manager:'Борис Тестовый',amount:0,date:'2026-10-23'}],
      possibleDuplicates:[{dealId:'777',title:'Дельта',manager:'Алия Тестовая',registerManager:'Борис'}]
    });
    expect(buildPultSignals(f.payload).map(s=>s.text).join(' ')).not.toMatch(/Есть в ОП|нет в ОП|Возможен дубль/);
    f.payload.closedMonth=true;
    attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    expect(f.payload.contractSource?.reconciliation).toEqual({closedNotInRegister:[],possibleDuplicates:[]});
  });
  it.each([false,true])('loads only urgent outside owners once; failure=%s', async fail => {
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const rows = [
      {ID:'111',ASSIGNED_BY_ID:'777',STAGE_ID:'LOSE',STAGE_SEMANTIC_ID:'F',UF_CRM_S2L_GZ_OUTCOME:'won:test'},
      {ID:'112',ASSIGNED_BY_ID:'777',STAGE_ID:'LOSE',STAGE_SEMANTIC_ID:'F',UF_CRM_S2L_GZ_OUTCOME:'partner:test'},
      {ID:'113',ASSIGNED_BY_ID:'778',STAGE_ID:'WON',STAGE_SEMANTIC_ID:'S',UF_CRM_S2L_GZ_OUTCOME:'lost:test'},
      {ID:'114',ASSIGNED_BY_ID:'779',STAGE_ID:'NEW',STAGE_SEMANTIC_ID:'P',UF_CRM_S2L_GZ_OUTCOME:'won:test'},
      {ID:'115',ASSIGNED_BY_ID:'780',STAGE_ID:'DUPLICATE',STAGE_SEMANTIC_ID:'F',UF_CRM_S2L_GZ_OUTCOME:'won:test'}
    ];
    const call=vi.fn(async(method:string,p:any) => {
      if(method==='im.user.get') { if(fail) throw Error('https://secret.invalid/webhook'); return {name:`Владелец ${p.ID}`}; }
      return [];
    });
    const reader=new ReadOnlyBitrixClient({call});
    vi.spyOn(reader,'listAllBatched').mockImplementation(async(method:string,p:any) => method==='crm.deal.list' && JSON.stringify(p).includes('UF_CRM_S2L_GZ_OUTCOME') ? rows : []);
    const data=await collectPultData({client:reader,fromDate:'2026-10-01',toDate:'2026-10-29',managerIds:[],proposalStages:[],contractStages:[]});
    const lostQuery=vi.mocked(reader.listAllBatched).mock.calls.find(([method,p])=>method==='crm.deal.list' && JSON.stringify(p).includes('lost:'));
    expect(lostQuery?.[1]?.filter).not.toHaveProperty('ASSIGNED_BY_ID');
    expect(call.mock.calls.filter(([m])=>m==='im.user.get').map(([,p])=>p.ID).sort()).toEqual([777,778]);
    expect(data.outcomeMismatches.map(d=>d.managerName)).toEqual([fail?'сотрудник ID 777':'Владелец 777',fail?'сотрудник ID 777':'Владелец 777']);
    const f=fixture();
    attachRegisterContracts(f.payload,f.register,data.deals,f.aliases,data.userProfiles);
    expect(buildPultSignals(f.payload).find(s=>s.color==='red')?.text).toContain(fail?'сотрудник ID 778':'Владелец 778');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret.invalid');
    warn.mockRestore();
  });
});
