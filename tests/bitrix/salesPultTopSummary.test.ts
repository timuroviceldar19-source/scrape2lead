import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {chromium,type Browser} from 'playwright';
import {fixture} from '../fixtures/sales-pult/contracts.js';
import {attachRegisterContracts} from '../../src/bitrix/salesPult/contracts.js';
import {buildPultView} from '../../src/bitrix/salesPult/view.js';
import {renderPultHtml} from '../../src/bitrix/salesPult/site.js';

const clean=(s:string)=>s.replace(/\s+/g,' ');
const num=(n:number)=>new Intl.NumberFormat('ru-RU').format(Math.round(n)).replace(/\s+/g,' ');
function sample(){
  const f=fixture(); attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
  f.payload.outcomeMismatches=[1,2].map(n=>({id:String(700+n),title:`<Тест ${n}>`,amount:1200,managerId:'777',managerName:'Тестовый владелец',outcome:'won:test',portalSignDate:'2026-10-23'}));
  f.payload.groups[0].managers[0].rollups.day.calls.successful=7;
  f.payload.groups[0].managers[0].rollups.month.calls.successful=31;
  return f.payload;
}
describe('Д4а: верх главной',()=>{
  let browser:Browser;
  beforeAll(async()=>{browser=await chromium.launch({headless:true});});
  afterAll(async()=>{await browser?.close();});
  for(const width of [1440,375]){
    it(`shows four tiles, collapsed details, live chart tips and TV at ${width}`,async()=>{
      const payload=sample(),v=buildPultView(payload),m=v.month;
      const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
      try{
        await page.setContent(renderPultHtml(payload));
        expect(await page.locator('#month h2').textContent()).toBe('01Октябрь');
        const tiles=page.locator('.month-tiles > .month-tile');
        expect(await tiles.count()).toBe(4);
        expect(clean(await tiles.nth(0).innerText())).toContain(`${num(m.fact)} / ${num(m.plan)}`);
        expect(await tiles.nth(0).innerText()).toContain('темп');
        expect(await tiles.nth(0).innerText()).toContain('нужно');
        expect(await tiles.nth(0).locator('.hbar').count()).toBe(1);
        expect(await tiles.nth(1).innerText()).toContain(`${Math.round(m.amount/m.revenuePlan!*100)}% плана выручки`);
        expect(await tiles.nth(1).innerText()).toContain('без НДС');
        expect(await tiles.nth(2).textContent()).toContain('Прогноз к 31.10');
        expect(clean(await tiles.nth(2).innerText())).toContain(`≈ ${num(m.forecast)} / ${num(m.plan)}`);
        expect(await tiles.nth(2).innerText()).toContain(`${m.fpct}% плана при нынешнем темпе`);
        expect(clean(await tiles.nth(3).innerText())).toContain(`${num(v.periods.day.sales.totals.calls.fact)} / ${num(v.periods.day.sales.totals.calls.target)}`);
        expect(await tiles.nth(3).locator(`.${v.periods.day.sales.totals.calls.cls}`).count()).toBeGreaterThan(0);
        const boxes=await tiles.evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y};}));
        expect(boxes[0].y).toBe(boxes[1].y);
        if(width===375){expect(boxes[2].y).toBe(boxes[3].y);expect(boxes[2].y).toBeGreaterThan(boxes[0].y);expect(boxes[0].x).toBe(boxes[2].x);}
        else expect(new Set(boxes.map(b=>b.y)).size).toBe(1);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        const details=page.locator('.month-more');
        expect(await details.getAttribute('open')).toBeNull();
        await details.locator('summary').click();
        expect(await page.locator('#burnWrap svg').isVisible()).toBe(true);
        expect(await details.innerText()).toContain(m.sourceLabel);
        expect(await details.innerText()).toContain('ждут ОП');
        expect(await details.locator('.split-row').count()).toBe(m.split.length);
        await page.locator('#burnWrap .hit').nth(10).hover();
        expect(await page.locator('#burnTip').getAttribute('class')).toContain('on');
        await page.keyboard.press('t');
        expect(await page.locator('#month').getAttribute('class')).toContain('scene');
        expect(await page.locator('#burnWrap svg').isVisible()).toBe(true);
        await page.keyboard.press('t');
        expect(await details.getAttribute('open')).toBeNull();
      }finally{await page.close();}
    },15000);
    it(`folds mismatch list into one red urgent row and supports keyboard at ${width}`,async()=>{
      const payload=sample(),page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
      try{
        await page.setContent(renderPultHtml(payload));
        expect(await page.locator('#signals .mismatches-box').count()).toBe(0);
        const details=page.locator('#signals .outcome-mismatches');
        expect(await details.count()).toBe(1);
        expect(clean(await details.locator('summary').innerText())).toContain('Ошибка в CRM: 2 сделки выиграны на портале, но закрыты как проигрыш');
        expect(await details.locator('summary').innerText()).toContain('список');
        expect(await details.getAttribute('open')).toBeNull();
        const meta=await page.locator('#signals .block-head .meta').innerText();
        await details.locator('summary').focus(); await page.keyboard.press('Enter');
        expect(await details.locator('.mismatch-row').count()).toBe(2);
        expect(await details.locator('a').first().isVisible()).toBe(true);
        expect(await details.locator('a').first().getAttribute('href')).toBe('https://example.invalid/crm/deal/details/701/');
        expect(await details.locator('a').first().innerText()).toBe('<Тест 1>');
        expect(await details.innerText()).toContain('от 23.10');
        expect(await page.locator('#signals .block-head .meta').innerText()).toBe(meta);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        const layout=await page.evaluate(()=>{
          const list=document.querySelector('#signals .outcome-mismatches')!.getBoundingClientRect();
          const all=document.querySelector('#signals .signals')!.getBoundingClientRect();
          const next=document.querySelector('#signals .signals > .sig');
          return {ratio:list.width/all.width,listBottom:list.bottom,nextTop:next?next.getBoundingClientRect().top:null};
        });
        expect(layout.ratio).toBeGreaterThanOrEqual(0.95);
        expect(layout.nextTop).not.toBeNull();
        expect(layout.nextTop!).toBeGreaterThanOrEqual(layout.listBottom-1);
        await page.keyboard.press('t');
        expect(await details.getAttribute('open')).toBeNull();
        await details.locator('summary').evaluate(el=>(el as HTMLElement).click());
        expect(await details.getAttribute('open')).toBeNull();
      }finally{await page.close();}
    },15000);
  }
  it('handles early forecast, missing revenue plan and unavailable calls without an error row',async()=>{
    const payload=sample();payload.asOfDate='2026-10-01';payload.generatedAt='2026-10-01 09:00';payload.contractSource=undefined;payload.callsAvailable=false;payload.outcomeMismatches=[];
    const page=await browser.newPage();
    try{await page.setContent(renderPultHtml(payload));
      expect(await page.locator('.month-tile').nth(1).innerText()).toContain(buildPultView(payload).month.sourceLabel);
      expect(await page.locator('.month-tile').nth(1).innerText()).not.toContain('плана выручки');
      expect(clean(await page.locator('.month-tile').nth(2).innerText())).toContain('—, с 3-го дня');
      expect(await page.locator('.month-tile').nth(3).innerText()).toContain('нет доступа');
      expect(await page.locator('.outcome-mismatches').count()).toBe(0);
    }finally{await page.close();}
  });
  it('uses singular wording for one outcome error',async()=>{
    const payload=sample();payload.outcomeMismatches=payload.outcomeMismatches!.slice(0,1);
    const page=await browser.newPage();
    try{await page.setContent(renderPultHtml(payload));
      expect(clean(await page.locator('#signals .outcome-mismatches summary').innerText())).toContain('Ошибка в CRM: 1 сделка выиграна на портале, но закрыта как проигрыш');
    }finally{await page.close();}
  });
  it('uses closed month result and monthly calls',async()=>{
    const payload=sample();payload.closedMonth=true;const v=buildPultView(payload);
    const page=await browser.newPage();
    try{await page.setContent(renderPultHtml(payload));
      expect(await page.locator('.month-tile').nth(2).innerText()).toContain(`Итог: ${v.month.pct}% плана`);
      expect(await page.locator('.month-tile').nth(2).innerText()).not.toContain('Прогноз');
      expect(await page.locator('.month-tile').nth(0).innerText()).not.toContain('нужно');
      expect(await page.locator('.month-tile').nth(0).innerText()).toContain('в среднем');
      expect(await page.locator('.month-tile').nth(3).textContent()).toContain('Дозвоны за месяц');
      expect(clean(await page.locator('.month-tile').nth(3).innerText())).toContain(`${num(v.periods.month.sales.totals.calls.fact)} / ${num(v.periods.month.sales.totals.calls.target)}`);
    }finally{await page.close();}
  });
});
