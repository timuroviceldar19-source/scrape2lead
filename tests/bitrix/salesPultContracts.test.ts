import { describe, it, expect } from "vitest";
import { attachRegisterContracts } from "../../src/bitrix/salesPult/contracts.js";
import { buildPultView } from "../../src/bitrix/salesPult/view.js";
import { calculateDailyMetrics, calculateRollups, type DealInfo } from "../../src/bitrix/salesPult/metrics.js";
import { buildRegisterView } from "../../src/bitrix/salesPult/register/buildView.js";
import { buildRegisterMonthSummary } from "../../src/bitrix/salesPult/register/history.js";
import type { RegisterRow } from "../../src/bitrix/salesPult/register/types.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";

export const targets = { daily: { calls: 2, proposals: 1, contracts: 1 }, weekly: { calls: 10, proposals: 5, contracts: 5 }, monthly: { calls: 40, proposals: 20, contracts: 20 } };
export function fixture() {
  const deals = new Map<string, DealInfo>([
    ['d1', { id: 'd1', title: 'Альфа', amount: 100, assignedById: 's', stageSemanticId: 'S' }],
    ['d2', { id: 'd2', title: 'Бета', amount: 0, assignedById: 't', stageSemanticId: 'S' }],
    ['d3', { id: 'd3', title: 'Гамма', amount: 900, assignedById: 's', stageSemanticId: 'S', outcome: 'lost:other' }]
  ]);
  const daily = ['s','t'].map(managerId => calculateDailyMetrics({ managerId, date: '2026-10-23', calls: [], kpTransitions: [], contractTransitions: [...deals.keys()].map(id => ({id, dealId:id,stageId:'WON',createdTime:'2026-10-23T12:00:00+05:00'})), deals }));
  const payload: SalesPultPayload = { asOfDate:'2026-10-28',generatedAt:'2026-10-28 12:00 (UTC+5)',portal:'https://example.invalid',callsAvailable:true,targets,dynamics:[],holidays:['2026-10-26'], groups:[{id:'sales',name:'Продажи',managers:[{id:'s',name:'Алия Тестовая',active:true,rollups:calculateRollups({managerId:'s',asOfDate:'2026-10-28',dailyMetrics:daily,deals,targets})}]},{id:'tenders',name:'Тендеры',managers:[{id:'t',name:'Борис Тестовый',active:true,rollups:calculateRollups({managerId:'t',asOfDate:'2026-10-28',dailyMetrics:daily,deals,targets})}]}] };
  const row = (manager:string,customer:string,sale:number):RegisterRow => ({date:'2026-10-23',manager,customer,sale,type:'B2B',product:'Тестовый товар',qty:1,cost:0,extras:0,portal:0,val:null,bonusMop:0,bonusRop:0,note:null,group:'Прочее',kind:'Тест',channel:'B2B'});
  const rows = [row('Алия','Альфа',60),row('Алия','Альфа',40),row('Борис','Дельта',200),row('Неизвестный','Эпсилон',300)];
  const register = buildRegisterView({fileName:'ОП тест.xlsx',asOf:'2026-10-28',month:'2026-10',rows,plans:{Алия:1000,Борис:1000,B2B:500},missing:[],extraDealsCount:0});
  return {payload,register,deals,rows,aliases:{Алия:'Алия Тестовая',Борис:'Борис Тестовый'}};
}
describe('contracts from OP', () => {
  it('excludes WON with lost outcome from daily and all rollups', () => {
    const {payload} = fixture();
    expect(payload.groups[0].managers[0].rollups.month.contracts).toMatchObject({uniqueDealsCount:1,totalAmount:100,dealIds:['d1']});
  });
  it('uses OP contract triples, B2B, both plans, aliases, Other and dated accumulation', () => {
    const f=fixture(); attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    const v=buildPultView(f.payload);
    expect(v.month).toMatchObject({fact:3,amount:600,plan:40,revenuePlan:2500,sourceLabel:'по реестру ОП, файл «ОП тест.xlsx»',awaitingRegister:1,crmFact:2,crmAmount:100});
    expect(v.month.split.map(x=>[x.name,x.c,x.a])).toEqual([['Продажи',1,100],['Тендеры',1,200],['Другие',1,300]]);
    expect(v.month.points[22]).toBe(0); expect(v.month.points[23]).toBe(3);
    expect(v.periods.month.sales.totals.contracts.fact).toBe(1);
    expect(v.periods.month.tenders?.totals.contracts.fact).toBe(1);
    expect(v.periods.month.sales.managers[0].contracts.totalAmount).toBe(100);
    expect(v.periods.day.sales.totals.contracts.sub).toContain('по Битриксу, предварительно');
    expect(v.periods.month.sales.totals.contracts.sub).toContain('по реестру ОП');
  });
  it('defers unmatched CRM beyond two working days and marks uncertain reconciliation quietly', () => {
    const f=fixture(); attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    let signals=buildPultView(f.payload).signals;
    expect(signals.some(s=>s.text.includes('Закрыто в Битриксе, нет в ОП'))).toBe(false);
    f.payload.asOfDate='2026-10-29'; attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    signals=buildPultView(f.payload).signals;
    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({color:'gray',text:expect.stringMatching(/Борис.*Закрыто в Битриксе, нет в ОП.*проверить/)}),
      expect.objectContaining({color:'gray',text:expect.stringMatching(/Неизвестный.*Есть в ОП, нет сделки в Битриксе/)}),
      expect.objectContaining({color:'yellow',text:expect.stringMatching(/Борис.*Сумма сделки 0/)}),
      expect.objectContaining({color:'red',text:expect.stringMatching(/Алия.*Успешна в Битриксе, а на портале договор у другого поставщика/)}),
    ]));
  });
  it('uses closed OP history and falls back clearly on missing or failed register', () => {
    const f=fixture(); f.payload.closedMonth=true;
    const summary=buildRegisterMonthSummary({month:'2026-10',fileName:'ОП итог.xlsx',rows:f.rows,plans:{Алия:1200}});
    attachRegisterContracts(f.payload,{error:'current unavailable',history:{asOf:'2026-11-01',months:[summary]}},f.deals,f.aliases);
    expect(buildPultView(f.payload).month).toMatchObject({fact:3,amount:600,revenuePlan:1200,awaitingRegister:undefined});
    expect(buildPultView(f.payload).month.points[23]).toBe(3);
    attachRegisterContracts(f.payload,{error:'unavailable'},f.deals,f.aliases);
    expect(buildPultView(f.payload).month.sourceLabel).toBe('реестр ОП за месяц недоступен, цифры по Битриксу');
    f.payload.closedMonth=false; attachRegisterContracts(f.payload,{error:'unavailable'},f.deals,f.aliases);
    expect(buildPultView(f.payload).month).toMatchObject({fact:2,sourceLabel:'реестр ОП недоступен, цифры по Битриксу'});
  });
});
