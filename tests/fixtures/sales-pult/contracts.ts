import { calculateDailyMetrics, calculateRollups, type DealInfo } from "../../../src/bitrix/salesPult/metrics.js";
import { buildRegisterView } from "../../../src/bitrix/salesPult/register/buildView.js";
import type { RegisterRow } from "../../../src/bitrix/salesPult/register/types.js";
import type { SalesPultPayload } from "../../../src/bitrix/salesPult/types.js";
export const targets = { daily: { calls: 2, proposals: 1, contracts: 1 }, weekly: { calls: 10, proposals: 5, contracts: 5 }, monthly: { calls: 40, proposals: 20, contracts: 20 } };
export function fixture(extraDeals: DealInfo[] = []) {
  const deals = new Map<string, DealInfo>([
    ['d1', { id: 'd1', title: 'Альфа', amount: 100, assignedById: 's', stageSemanticId: 'S' }],
    ['d2', { id: 'd2', title: 'Бета', amount: 0, assignedById: 't', contractDate:'2026-10-23', stageSemanticId: 'S' }],
    ['d3', { id: 'd3', title: 'Гамма', amount: 900, assignedById: 's', stageSemanticId: 'S', outcome: 'lost:other' }],
    ...extraDeals.map(d => [d.id, d] as [string, DealInfo])
  ]);
  const daily = ['s','t'].map(managerId => calculateDailyMetrics({ managerId, date: '2026-10-23', calls: [], kpTransitions: [], contractTransitions: [...deals.keys()].map(id => ({id, dealId:id,stageId:'WON',createdTime:'2026-10-23T12:00:00+05:00'})), deals }));
  const payload: SalesPultPayload = { asOfDate:'2026-10-28',generatedAt:'2026-10-28 12:00 (UTC+5)',portal:'https://example.invalid',callsAvailable:true,targets,dynamics:[],holidays:['2026-10-26'], groups:[{id:'sales',name:'Продажи',managers:[{id:'s',name:'Алия Тестовая',active:true,rollups:calculateRollups({managerId:'s',asOfDate:'2026-10-28',dailyMetrics:daily,deals,targets})}]},{id:'tenders',name:'Тендеры',managers:[{id:'t',name:'Борис Тестовый',active:true,rollups:calculateRollups({managerId:'t',asOfDate:'2026-10-28',dailyMetrics:daily,deals,targets})}]}] };
  const row = (manager:string,customer:string,sale:number,type='B2B'):RegisterRow => ({date:'2026-10-23',manager,customer,sale,type,product:'Тестовый товар',qty:1,cost:0,extras:0,portal:0,val:null,bonusMop:0,bonusRop:0,note:null,group:'Прочее',kind:'Тест',channel:'B2B'});
  const rows = [row('Алия','Альфа',60),row('Алия','Альфа',40),row('Борис','Дельта',200),row('Неизвестный','Эпсилон',300,'Госзакупки')];
  const register = buildRegisterView({fileName:'ОП тест.xlsx',asOf:'2026-10-28',month:'2026-10',rows,plans:{Алия:1000,Борис:1000,B2B:500},missing:[],extraDealsCount:0});
  return {payload,register,deals,rows,aliases:{Алия:'Алия Тестовая',Борис:'Борис Тестовый'}};
}
