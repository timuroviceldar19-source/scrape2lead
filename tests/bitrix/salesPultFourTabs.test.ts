import fs from 'node:fs';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {chromium,type Browser,type Page} from 'playwright';
import {normalizePlanDeal} from '../../src/bitrix/salesPult/plans/collect.js';
import {buildPlansMonitorView} from '../../src/bitrix/salesPult/plans/aggregate.js';
import {renderPultHtml,renderRegisterHtml,type SalesPultPayload,type RegisterPagePayload} from '../../src/bitrix/salesPult/site.js';
import {fixture} from '../fixtures/sales-pult/contracts.js';

// Все данные этого файла выдуманные.
const options={asOfDate:'2026-11-06'};
function payload(){
  const p:SalesPultPayload=JSON.parse(fs.readFileSync('tests/fixtures/sales-pult/midday.json','utf8'));
  const deals=['ИП','КТ'].flatMap((group,g)=>[1,2,3].map(i=>normalizePlanDeal({
    ID:String(g*100+i),CATEGORY_ID:41,ORIGINATOR_ID:'scrape2lead-gz-plans',TITLE:`[GZ ${i}] Тестовый товар`,DATE_CREATE:'2026-11-01',CLOSED:'N',
    ASSIGNED_BY_ID:'7',UF_CRM_ENSTRU_NAME:group==='ИП'?'Панель':'Ноутбук',UF_CRM_MONTH:'2026-11',UF_CRM_PLAN_STATUS:'Утвержден',
    UF_CRM_6627AEBD4503E:'Электронный магазин',UF_CRM_COUNT:1,OPPORTUNITY:1000*i,UF_CRM_6627AEBD72587:'Тестовая школа'
  },{...options,managerNames:new Map([['7','Тестовый менеджер']])})!));
  p.plans=buildPlansMonitorView(deals,options);
  return p;
}
const navTexts=(page:Page)=>page.locator('.sections a').evaluateAll(es=>es.map(e=>e.textContent!.trim()));
const active=(page:Page)=>page.locator('.sections a[aria-current="page"]').textContent();
const pressed=(page:Page)=>page.locator('#productSwitch button[aria-pressed="true"]').getAttribute('data-product');

describe('Д5: четыре вкладки вместо шести',()=>{
  let browser:Browser;
  beforeAll(async()=>{browser=await chromium.launch({headless:true});});
  afterAll(async()=>{await browser?.close();});
  for(const width of [1440,375]){
    it(`switches sections and product at ${width}`,async()=>{
      const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
      const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
      try{
        await page.setContent(renderPultHtml(payload()));
        expect(await navTexts(page)).toEqual(['Сегодня','Радар','Выручка','Планы','Рынок']);
        expect(await active(page)).toBe('Сегодня');
        expect(await page.locator('#productSwitch').isVisible()).toBe(false);
        await page.locator('.sections [data-t="plans"]').click();
        expect(await page.locator('#tab-plans-ip').getAttribute('class')).toContain('on');
        expect(await active(page)).toBe('Планы');
        expect(await page.locator('#productSwitch').isVisible()).toBe(true);
        expect(await page.locator('#productSwitch button').evaluateAll(es=>es.map(e=>e.textContent!.trim()))).toEqual(['Панели (ИП)','Техника (КТ)']);
        expect(await pressed(page)).toBe('ip');
        await page.locator('#productSwitch [data-product="kt"]').click();
        expect(await page.locator('#tab-plans-kt').getAttribute('class')).toContain('on');
        expect(await page.evaluate(()=>location.hash)).toBe('#plans-kt/all');
        expect(await active(page)).toBe('Планы');
        await page.locator('.sections [data-t="market"]').click();
        expect(await page.locator('#tab-kt').getAttribute('class')).toContain('on');
        expect(await active(page)).toBe('Рынок');
        expect(await pressed(page)).toBe('kt');
        expect(await page.evaluate(()=>location.hash)).toMatch(/^#kt\//);
        await page.locator('#productSwitch [data-product="ip"]').click();
        expect(await page.locator('#tab-ip').getAttribute('class')).toContain('on');
        expect(await pressed(page)).toBe('ip');
        const links=await page.locator('.sections a').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {l:r.left,r:r.right};}));
        expect(links.every(b=>b.l>=0&&b.r<=width)).toBe(true);
        const buttons=await page.locator('#productSwitch button').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {l:r.left,r:r.right};}));
        expect(buttons.every(b=>b.l>=0&&b.r<=width)).toBe(true);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.locator('.sections [data-t="pult"]').click();
        expect(await page.locator('#tab-pult').getAttribute('class')).toContain('on');
        expect(await page.locator('#productSwitch').isVisible()).toBe(false);
        expect(errors).toEqual([]);
      }finally{await page.close();}
    },20000);
  }
  it('opens a product tab from the address and hides the switch in TV',async()=>{
    const p=payload(),file=`${fs.mkdtempSync('/tmp/pult-tabs-')}/index.html`;
    fs.writeFileSync(file,renderPultHtml(p));
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    try{
      await page.goto(`file://${file}#plans-kt`);
      expect(await active(page)).toBe('Планы');
      expect(await pressed(page)).toBe('kt');
      await page.evaluate(()=>{location.hash='kt';});
      await expect.poll(()=>active(page)).toBe('Рынок');
      expect(await pressed(page)).toBe('kt');
      await page.keyboard.press('t');
      expect(await page.locator('#productSwitch').isVisible()).toBe(false);
    }finally{await page.close();}
  });
  it('uses the same four sections on the register page with «Выручка» active',async()=>{
    const f=fixture();
    if(f.register.error!==undefined) throw new Error(f.register.error);
    const reg:RegisterPagePayload={asOfDate:f.payload.asOfDate,generatedAt:f.payload.generatedAt,portal:'https://example.invalid',register:f.register};
    const page=await browser.newPage({viewport:{width:375,height:900}});
    try{
      await page.setContent(renderRegisterHtml(reg));
      expect(await navTexts(page)).toEqual(['Сегодня','Радар','Выручка','Планы','Рынок']);
      expect(await active(page)).toBe('Выручка');
      expect(await page.locator('.sections a').evaluateAll(es=>es.map(e=>e.getAttribute('href')))).toEqual(['./#pult','./#radar-ip','./reg.html','./#plans-ip','./#ip']);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }finally{await page.close();}
  });
});
