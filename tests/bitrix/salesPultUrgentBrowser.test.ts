import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { fixture } from '../fixtures/sales-pult/contracts.js';
import { renderPultHtml, renderRegisterHtml, type RegisterPagePayload } from '../../src/bitrix/salesPult/site.js';

describe('Д3: urgent and register in browser', () => {
  let browser:Browser;
  beforeAll(async()=>{browser=await chromium.launch({headless:true});});
  afterAll(async()=>{await browser?.close();});
  for(const width of [1440,375]) {
    it(`keeps signals TV scene and has no overflow at ${width}`,async()=>{
      const {payload}=fixture();
      payload.outcomeMismatches=[{id:'777',title:'Выдуманная сделка',amount:100,managerId:'888',managerName:'Тестовый владелец',outcome:'won:test'}];
      const page=await browser.newPage({viewport:{width,height:900}});
      try {
        await page.clock.install();
        await page.setContent(renderPultHtml(payload));
        await expect.poll(()=>page.locator('#signals h2').textContent()).toBe('02Срочно');
        expect(await page.locator('#signals .block-head .meta').innerText()).toBe('1 срочный пункт');
        expect(await page.locator('.mismatch-row .mgr').innerText()).toContain('Тестовый владелец');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.keyboard.press('t');
        await expect.poll(()=>page.locator('#scenes i').count()).toBe(5);
        await page.clock.fastForward(15_100);
        await page.clock.fastForward(15_100);
        await page.clock.fastForward(15_100);
        await expect.poll(()=>page.locator('#signals').evaluate(el=>el.classList.contains('scene'))).toBe(true);
      } finally {await page.close();}
    });
    it(`renders escaped reconciliation inside 04 with links and empty state at ${width}`,async()=>{
      const f=fixture();
      const payload:RegisterPagePayload={asOfDate:f.payload.asOfDate,generatedAt:f.payload.generatedAt,portal:'https://example.invalid',register:f.register,
        reconciliation:{closedNotInRegister:[{dealId:'777',title:'<img src=x onerror="window.pwn=1">',manager:'<Тест>',amount:1200,date:'2026-10-23'}],possibleDuplicates:[{dealId:'778',title:'Дубль',manager:'Тест',registerManager:'<Другой>'}]}};
      if (f.register.error !== undefined) throw new Error(f.register.error);
      payload.register.history={asOf:payload.asOfDate,months:[],monthViews:{'2026-09':{...f.register,month:'2026-09'}}};
      const page=await browser.newPage({viewport:{width,height:900}});
      try {
        await page.setContent(renderRegisterHtml(payload));
        const section=page.locator('section').filter({has:page.locator('h2', {hasText:'В реестре есть, в CRM'})});
        expect(await section.locator('h3').innerText()).toBe('В CRM «Выигран», в реестре нет');
        expect(await section.locator('.reconciliation a').first().getAttribute('href')).toBe('https://example.invalid/crm/deal/details/777/');
        expect(await section.locator('.reconciliation').innerText()).toContain('<img src=x');
        expect(await section.locator('.reconciliation').innerText()).toContain('в реестре у <Другой>');
        expect(await section.locator('.reconciliation img').count()).toBe(0);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.evaluate(()=>{location.hash='2026-09';});
        await expect.poll(()=>page.locator('.reconciliation').count()).toBe(0);
        await page.evaluate(()=>{location.hash='2026-10';});
        await expect.poll(()=>page.locator('.reconciliation a').count()).toBe(2);
        payload.reconciliation={closedNotInRegister:[],possibleDuplicates:[]};
        await page.goto('about:blank');
        await page.setContent(renderRegisterHtml(payload));
        expect(await page.locator('.reconciliation').innerText()).toBe('расхождений нет');
      } finally {await page.close();}
    });
  }
});
