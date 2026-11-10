import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {chromium,type Browser} from 'playwright';
import fs from 'node:fs';
import {normalizePlanDeal} from '../../src/bitrix/salesPult/plans/collect.js';
import {buildPlansMonitorView,buildSingleSliceView} from '../../src/bitrix/salesPult/plans/aggregate.js';
import {attachLostWinners,parseLostOutcomeComment} from '../../src/bitrix/salesPult/plans/lostTo.js';
import type {NormalizedPlanDeal} from '../../src/bitrix/salesPult/plans/types.js';
import type {ReadOnlyBitrixClient} from '../../src/bitrix/reporting/readOnlyClient.js';
import {renderPultHtml,type SalesPultPayload} from '../../src/bitrix/salesPult/site.js';

// Все компании, БИН и суммы в этом файле выдуманные.
const NB='\u00a0';
const comment=(name:string,bin:string,sum?:string)=>`Итог закупки: выиграл ${name} (БИН ${bin}) — договор №${bin}/1/01 от 05.11.2026${sum?`, ${sum} ₸`:''}.\nЕсли сделка ещё открыта, закройте её как «Закупка состоялась».`;
function deal(id:number,o:{group?:'ИП'|'КТ',outcome?:string,sum?:number,month?:string,customer?:string}={}):NormalizedPlanDeal{
  return normalizePlanDeal({ID:String(id),CATEGORY_ID:41,ORIGINATOR_ID:'scrape2lead-gz-plans',TITLE:`[GZ ${id}] Тестовый товар`,DATE_CREATE:'2026-10-01',
    CLOSED:o.outcome?'Y':'N',STAGE_SEMANTIC_ID:o.outcome?'F':'P',ASSIGNED_BY_ID:'7',UF_CRM_ENSTRU_NAME:(o.group??'ИП')==='ИП'?'Панель':'Ноутбук',
    UF_CRM_MONTH:o.month??'2026-10',UF_CRM_S2L_GZ_OUTCOME:o.outcome??'',UF_CRM_6627AEBD4503E:'Электронный магазин',UF_CRM_COUNT:1,
    OPPORTUNITY:o.sum??1000,UF_CRM_6627AEBD72587:o.customer??`Тестовая школа ${id}`},{asOfDate:'2026-11-06',portal:'https://example.invalid',managerNames:new Map([['7','Тестовый менеджер']])})!;
}
function fakeReader(byDeal:Record<string,Array<{ID:string,COMMENT:string}>>,fail=false){
  const calls:Array<Record<string,string>>=[];
  const reader={async call(method:string,params:{cmd:Record<string,string>}){
    expect(method).toBe('batch'); calls.push(params.cmd);
    if(fail) throw new Error('network down https://secret.invalid/rest/1/token/');
    const result:Record<string,unknown>={};
    for(const [key,query] of Object.entries(params.cmd)){
      expect(query.startsWith('crm.timeline.comment.list?')).toBe(true);
      result[key]=byDeal[key.slice(1)]??[];
    }
    return {result};
  }} as unknown as ReadOnlyBitrixClient;
  return {reader,calls};
}

describe('Д6: кому проиграли — разбор комментария робота',()=>{
  it('parses winner, BIN and contract sum, decoding entities and parentheses in the name',()=>{
    expect(parseLostOutcomeComment(comment('ТОО &quot;Тестовый поставщик (Алматы)&quot;','123456789012',`1${NB}234${NB}567,5`))).toEqual({name:'ТОО "Тестовый поставщик (Алматы)"',bin:'123456789012',contractSum:1234567.5});
    expect(parseLostOutcomeComment(comment('ТОО Тест','123456789012'))).toEqual({name:'ТОО Тест',bin:'123456789012',contractSum:null});
  });
  it('ignores our wins, partner wins, terminations and other comments',()=>{
    expect(parseLostOutcomeComment('Итог закупки: договор подписан с нами — договор №1 от 05.11.2026, 100 ₸.')).toBeNull();
    expect(parseLostOutcomeComment('Итог закупки: выиграл наш партнёр ТОО Тест (БИН 123456789012) — договор №1 от 05.11.2026, 100 ₸.')).toBeNull();
    expect(parseLostOutcomeComment('Итог закупки: договор №1 от 05.11.2026 с ТОО Тест (БИН 123456789012) расторгнут.')).toBeNull();
    expect(parseLostOutcomeComment('Позвонить заказчику')).toBeNull();
    expect(parseLostOutcomeComment(null)).toBeNull();
  });
});

describe('Д6: кому проиграли — загрузка пачками',()=>{
  it('reads comments only for lost deals, 50 per batch, and takes the latest outcome comment',async()=>{
    const deals=[...Array.from({length:120},(_,i)=>deal(i+1,{outcome:`lost:${i}`})),deal(500,{outcome:'won:1'}),deal(501)];
    const byDeal:Record<string,Array<{ID:string,COMMENT:string}>>={};
    for(let i=1;i<=120;i++) byDeal[String(i)]=[{ID:'10',COMMENT:comment('ТОО Старый','111111111111','100')},{ID:'20',COMMENT:comment('ТОО Новый','222222222222','90')},{ID:'15',COMMENT:'Перезвонить'}];
    const {reader,calls}=fakeReader(byDeal);
    await attachLostWinners(reader,deals);
    expect(calls.map(c=>Object.keys(c).length)).toEqual([50,50,20]);
    expect(deals[0].lostTo).toEqual({name:'ТОО Новый',bin:'222222222222',contractSum:90});
    expect(deals[120].lostTo).toBeUndefined();
    expect(deals[121].lostTo).toBeUndefined();
  });
  it('keeps plans working when the batch fails and does not leak the error text',async()=>{
    const deals=[deal(1,{outcome:'lost:1'})];
    const {reader}=fakeReader({},true);
    const warn:string[]=[]; const orig=console.warn; console.warn=(...a:unknown[])=>{warn.push(a.map(String).join(' '));};
    try{ await attachLostWinners(reader,deals); } finally { console.warn=orig; }
    expect(deals[0].lostTo).toBeUndefined();
    expect(warn.join(' ')).not.toContain('secret.invalid');
  });
});

describe('Д6: кому проиграли — агрегация',()=>{
  it('groups lost deals by winner BIN with plan and contract sums and cheaper-than-plan count',()=>{
    const ds=[
      deal(1,{outcome:'lost:1',sum:1000}),deal(2,{outcome:'lost:2',sum:3000}),deal(3,{outcome:'lost:3',sum:500}),
      deal(4,{outcome:'lost:4',sum:700}),deal(5,{outcome:'won:5',sum:900}),deal(6,{sum:100})
    ];
    ds[0].lostTo={name:'ТОО Альфа',bin:'111111111111',contractSum:800};
    ds[1].lostTo={name:'ТОО Альфа',bin:'111111111111',contractSum:3000};
    ds[2].lostTo={name:'ТОО Бета',bin:'222222222222',contractSum:null};
    const v=buildSingleSliceView(ds,'2026-11-06');
    expect(v.lostTo.lostCount).toBe(4);
    expect(v.lostTo.companies).toBe(2);
    expect(v.lostTo.unknownCount).toBe(1);
    expect(v.lostTo.competitors.map(c=>c.bin)).toEqual(['111111111111','222222222222']);
    const a=v.lostTo.competitors[0];
    expect(a).toMatchObject({name:'ТОО Альфа',count:2,planSum:4000,contractSum:3800,knownSumCount:2,cheaperCount:1});
    expect(a.deals.map(d=>d.id)).toEqual(['2','1']);
    expect(a.deals[1]).toMatchObject({planSum:1000,contractSum:800,customerName:'Тестовая школа 1',dealUrl:'https://example.invalid/crm/deal/details/1/'});
    expect(v.lostTo.competitors[1]).toMatchObject({count:1,contractSum:0,knownSumCount:0,cheaperCount:0});
  });
  it('keeps the 20 largest deals per company like other plan lists',()=>{
    const ds=Array.from({length:25},(_,i)=>{const d=deal(i+1,{outcome:`lost:${i}`,sum:1000+i});d.lostTo={name:'ТОО Альфа',bin:'111111111111',contractSum:900};return d;});
    const c=buildSingleSliceView(ds,'2026-11-06').lostTo.competitors[0];
    expect(c.count).toBe(25);
    expect(c.deals).toHaveLength(20);
    expect(c.deals[0].id).toBe('25');
  });
  it('keeps only the top 15 companies and fills month slices',()=>{
    const ds=Array.from({length:20},(_,i)=>{const d=deal(i+1,{outcome:`lost:${i}`,month:i<10?'2026-09':'2026-10'});d.lostTo={name:`ТОО ${i}`,bin:String(100000000000+i),contractSum:500};return d;});
    const view=buildPlansMonitorView(ds,{asOfDate:'2026-11-06'});
    expect(view.ip!.lostTo.competitors).toHaveLength(15);
    expect(view.ip!.lostTo.companies).toBe(20);
    expect(view.ip!.monthViews['2026-09'].lostTo.lostCount).toBe(10);
  });
});

describe('Д6: блок «Кому проиграли» на «Планах»',()=>{
  let browser:Browser;
  beforeAll(async()=>{browser=await chromium.launch({headless:true});});
  afterAll(async()=>{await browser?.close();});
  function payload(){
    const p:SalesPultPayload=JSON.parse(fs.readFileSync('tests/fixtures/sales-pult/midday.json','utf8'));
    const ds=[deal(1,{outcome:'lost:1',sum:1_000_000,month:'2026-09'}),deal(2,{outcome:'lost:2',sum:2_000_000,month:'2026-10'}),deal(3,{outcome:'lost:3',sum:500_000,month:'2026-10'}),deal(4,{month:'2026-10'})];
    ds[0].lostTo={name:'<img src=x onerror="window.pwn=1">',bin:'111111111111',contractSum:800_000};
    ds[1].lostTo={name:'<img src=x onerror="window.pwn=1">',bin:'111111111111',contractSum:2_000_000};
    p.plans=buildPlansMonitorView(ds,{asOfDate:'2026-11-06'});
    return p;
  }
  for(const width of [1440,375]){
    it(`shows winners with an expandable deal list and follows the month at ${width}`,async()=>{
      const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
      try{
        await page.setContent(renderPultHtml(payload()));
        await page.locator('.sections [data-t="plans"]').click();
        const block=page.locator('#tab-plans-ip .plans-lost');
        expect(await block.locator('h2').textContent()).toBe('04Кому проиграли');
        expect(await page.locator('#tab-plans-ip .plans-open h2').textContent()).toMatch(/^05/);
        expect(await page.locator('#tab-plans-ip .plans-customers h2').textContent()).toMatch(/^06/);
        const rows=block.locator('details.lost-d');
        expect(await rows.count()).toBe(1);
        const first=(await rows.first().locator('summary').innerText()).replace(/\s+/g,' ');
        expect(first).toContain('<img src=x');
        expect(first).toContain('111111111111');
        expect(first).toContain('1 из 2');
        expect(await block.innerText()).toContain('ещё 1 без данных о победителе');
        expect(await block.locator('img').count()).toBe(0);
        await rows.first().locator('summary').click();
        const list=rows.first().locator('.lost-row');
        expect(await list.count()).toBe(2);
        expect(await list.first().locator('a').first().getAttribute('href')).toBe('https://example.invalid/crm/deal/details/2/');
        expect((await list.nth(1).innerText()).replace(/\s+/g,' ')).toContain('−20%');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        expect(await page.evaluate(()=>(window as unknown as {pwn?:number}).pwn)).toBeUndefined();
        await page.locator('#planMonths [data-month="2026-09"]').click();
        expect(await page.locator('#tab-plans-ip .plans-lost details.lost-d').count()).toBe(1);
        expect(await page.locator('#tab-plans-ip .plans-lost').innerText()).not.toContain('без данных о победителе');
      }finally{await page.close();}
    },15000);
  }
});
