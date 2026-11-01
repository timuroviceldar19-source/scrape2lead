import { describe, it, expect } from "vitest";
import { attachRegisterContracts } from "../../src/bitrix/salesPult/contracts.js";
import { buildPultView } from "../../src/bitrix/salesPult/view.js";
import { calculateDailyMetrics, calculateRollups, type DealInfo } from "../../src/bitrix/salesPult/metrics.js";
import { buildRegisterView } from "../../src/bitrix/salesPult/register/buildView.js";
import { buildRegisterMonthSummary } from "../../src/bitrix/salesPult/register/history.js";
import type { RegisterRow } from "../../src/bitrix/salesPult/register/types.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";

import { fixture } from "../fixtures/sales-pult/contracts.js";
describe('contracts from OP', () => {
  it('preserves calls on dates without an OP contract', () => {
    const f=fixture(); f.payload.dynamics=[{date:'2026-10-22',calls:17,contracts:9,amount:900}];
    attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    expect(buildPultView(f.payload).month.byDay[21]).toMatchObject({calls:17,contracts:0,amount:0});
  });

  it('keeps an inactive manager with OP contracts visible in the monthly department', () => {
    const f=fixture(); f.payload.groups[1].managers[0].active=false;
    attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    expect(buildPultView(f.payload).periods.month.tenders?.managers.map(m=>m.id)).toContain('t');
    expect(buildPultView(f.payload).periods.day.tenders?.managers).toEqual([]);
  });
  it('falls back without losing CRM metrics when Disk loading fails', async () => {
    const { loadRegisterView } = await import('../../src/bitrix/salesPult/register/load.js');
    const reader={ listAllBatched:async()=>{ throw new Error('Disk unavailable'); } };
    const register=await loadRegisterView({reader:reader as never,diskFolderId:123});
    expect(register.error).toContain('Disk unavailable');
    const f=fixture(); attachRegisterContracts(f.payload,register,f.deals,f.aliases);
    expect(buildPultView(f.payload).month).toMatchObject({fact:2,amount:100,sourceLabel:'реестр ОП недоступен, цифры по Битриксу'});
  });

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
