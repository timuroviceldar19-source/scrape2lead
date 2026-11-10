import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {chromium,type Browser,type Page} from 'playwright';
import {fixture} from '../fixtures/sales-pult/contracts.js';
import {attachRegisterContracts} from '../../src/bitrix/salesPult/contracts.js';
import {buildPultView} from '../../src/bitrix/salesPult/view.js';
import {renderPultHtml} from '../../src/bitrix/salesPult/site.js';

// Все данные этого файла выдуманные.
const clean=(s:string)=>s.replace(/\s+/g,' ');
function sample(){
  const f=fixture(); attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
  const calls=f.payload.groups[0].managers[0].rollups.day.calls;
  calls.successful=7; calls.totalAttempts=12; calls.durationMinutes=34;
  return f.payload;
}
const box=async(page:Page,sel:string)=>(await page.locator(sel).first().boundingBox())!;

describe('Д4б: одна таблица «Команда» и свёрнутая аналитика звонков',()=>{
  let browser:Browser;
  beforeAll(async()=>{browser=await chromium.launch({headless:true});});
  afterAll(async()=>{await browser?.close();});
  for(const width of [1440,375]){
    it(`renders sales and tenders in one team table at ${width}`,async()=>{
      const payload=sample(),v=buildPultView(payload),day=v.periods.day;
      const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
      const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
      try{
        await page.setContent(renderPultHtml(payload));
        expect(await page.locator('#sales h2').textContent()).toBe('03Команда сегодня');
        expect(await page.locator('#tenders').count()).toBe(0);
        expect(await page.locator('#sales .inst').count()).toBe(0);
        const groups=page.locator('#sales .team .trow.group');
        expect(await groups.count()).toBe(2);
        expect(await groups.nth(0).getAttribute('data-group')).toBe('sales');
        expect(await groups.nth(1).getAttribute('data-group')).toBe('tenders');
        expect(await groups.nth(0).locator('.nm').textContent()).toBe('Продажи');
        expect(await groups.nth(1).locator('.nm').textContent()).toBe('Тендеры');
        const salesGroup=clean(await groups.nth(0).innerText());
        expect(salesGroup).toContain(`${day.sales.totals.calls.fact} / ${day.sales.totals.calls.target}`);
        expect(salesGroup).toContain(`${day.sales.totals.contracts.fact} / ${day.sales.totals.contracts.target}`);
        const tenderGroup=clean(await groups.nth(1).innerText());
        expect(tenderGroup).toContain(`${day.tenders!.totals.contracts.fact} / ${day.tenders!.totals.contracts.target}`);
        const salesRow=page.locator('#sales .trow.body').filter({hasText:'Алия Тестовая'});
        const tenderRow=page.locator('#sales .trow.body.tender').filter({hasText:'Борис Тестовый'});
        expect(await tenderRow.count()).toBe(1);
        expect(clean(await salesRow.innerText())).toContain('набрал 12 · 34 мин');
        expect((await tenderRow.locator('.cell[data-l="Подписал"] .sub').innerText()).trim()).toBe('по Битриксу, предварительно');
        const ys=[(await groups.nth(0).boundingBox())!.y,(await salesRow.boundingBox())!.y,(await groups.nth(1).boundingBox())!.y,(await tenderRow.boundingBox())!.y];
        expect([...ys].sort((a,b)=>a-b)).toEqual(ys);
        const na=tenderRow.locator('.cell.na');
        expect(await na.count()).toBe(2);
        if(width===1440){
          expect(await na.first().isVisible()).toBe(true);
          expect((await na.first().innerText()).trim()).toBe('—');
          const salesSigned=(await salesRow.locator('.cell[data-l="Подписал"]').boundingBox())!;
          const tenderSigned=(await tenderRow.locator('.cell[data-l="Подписал"]').boundingBox())!;
          expect(Math.abs(salesSigned.x-tenderSigned.x)).toBeLessThan(1);
        } else {
          expect(await na.first().isVisible()).toBe(false);
        }
        const team=await box(page,'#sales .team'),section=await box(page,'#sales');
        expect(team.width/section.width).toBeGreaterThanOrEqual(0.95);
        for(const i of [0,1]) expect(Math.abs((await groups.nth(i).boundingBox())!.width-team.width)).toBeLessThan(1);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await tenderRow.click();
        const detail=page.locator(`#${await tenderRow.getAttribute('aria-controls')}`);
        await expect.poll(()=>detail.getAttribute('class')).toContain('open');
        expect(await page.locator('#tasks h2').textContent()).toMatch(/^05/);
        expect(errors).toEqual([]);
      }finally{await page.close();}
    },15000);
    it(`keeps calls analytics collapsed, remembers it across periods and opens it in TV at ${width}`,async()=>{
      const payload=sample(),page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
      try{
        await page.setContent(renderPultHtml(payload));
        expect(await page.locator('#calls h2').textContent()).toBe('04Звонки сегодня');
        expect(await page.locator('#calls .callstrip').isVisible()).toBe(true);
        const more=page.locator('#calls .calls-more');
        expect(await more.getAttribute('open')).toBeNull();
        expect(await page.locator('#callsWrap svg').isVisible()).toBe(false);
        expect(await page.locator('#calls .anat').isVisible()).toBe(false);
        await more.locator('summary').click();
        expect(await page.locator('#callsWrap svg').isVisible()).toBe(true);
        expect(await page.locator('#calls .anat').isVisible()).toBe(true);
        await page.locator('#callsWrap .hit').nth(5).hover();
        expect(await page.locator('#callsTip').getAttribute('class')).toContain('on');
        if(width===1440) await page.keyboard.press('2'); else await page.locator('[data-p="week"]').click();
        expect(await page.locator('#calls h2').textContent()).toBe('04Звонки за неделю');
        expect(await page.locator('#calls .calls-more').getAttribute('open')).not.toBeNull();
        await page.locator('#calls .calls-more > summary').click();
        expect(await page.locator('#calls .calls-more').getAttribute('open')).toBeNull();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.keyboard.press('t');
        expect(await page.locator('#scenes i').count()).toBe(4);
        expect(await page.locator('#calls .calls-more').getAttribute('open')).not.toBeNull();
        expect(await page.locator('#month .hero').isVisible()).toBe(true);
        expect(await page.locator('#month .month-tiles').isVisible()).toBe(false);
        await page.keyboard.press('t');
        expect(await page.locator('#calls .calls-more').getAttribute('open')).toBeNull();
        expect(await page.locator('#month .month-tiles').isVisible()).toBe(true);
      }finally{await page.close();}
    },15000);
  }
  it('shows OP contracts of tenders in the month period inside the team table',async()=>{
    const payload=sample(),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    try{
      await page.setContent(renderPultHtml(payload));
      await page.locator('[data-p="month"]').click();
      expect(await page.locator('#sales h2').textContent()).toBe('03Команда за месяц');
      const tenderRow=page.locator('#sales .trow.body.tender');
      expect(await tenderRow.innerText()).toContain('по реестру ОП');
      expect(await tenderRow.locator('.cell[data-l="Подписал"] .num').innerText()).toContain('1');
    }finally{await page.close();}
  });
  it('renders only the sales group when there is no tender group',async()=>{
    const payload=sample(); payload.groups=payload.groups.filter(g=>g.id!=='tenders');
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
    try{
      await page.setContent(renderPultHtml(payload));
      expect(await page.locator('#sales .trow.group').count()).toBe(1);
      expect(await page.locator('#sales .trow.body.tender').count()).toBe(0);
      await page.keyboard.press('t');
      expect(await page.locator('#scenes i').count()).toBe(4);
      expect(errors).toEqual([]);
    }finally{await page.close();}
  });
});
