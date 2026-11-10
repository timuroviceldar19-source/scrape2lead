import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {chromium,type Browser,type Page} from 'playwright';
import {fixture} from '../fixtures/sales-pult/contracts.js';
import {attachRegisterContracts} from '../../src/bitrix/salesPult/contracts.js';
import {renderPultHtml} from '../../src/bitrix/salesPult/site.js';

// Все данные этого файла выдуманные.
function sample(){
  const f=fixture(); attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
  const task=(id:string,title:string)=>({id,dealId:id,title,deadline:'2026-10-28',amount:1000,isOverdue:true,overdueDays:2,rank:1,kind:'overdue' as const,group:1 as const});
  f.payload.groups[0].managers[0].topTasks=[task('901','Задача Алии')];
  f.payload.groups[1].managers[0].topTasks=[task('902','Задача Бориса')];
  return f.payload;
}
function pageFile(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pult-me-'));
  const file=path.join(dir,'index.html'); fs.writeFileSync(file,renderPultHtml(sample()));
  return pathToFileURL(file).href+'#pult';
}
const bodyRows=(page:Page)=>page.locator('#sales .trow.body:visible');
const names=(page:Page)=>bodyRows(page).locator('.nm').allTextContents();

describe('Д7: «Я — …» на «Сегодня»',()=>{
  let browser:Browser;
  beforeAll(async()=>{browser=await chromium.launch({headless:true});});
  afterAll(async()=>{await browser?.close();});
  for(const width of [1440,375]){
    it(`shows only my row and my tasks, remembers the choice at ${width}`,async()=>{
      const url=pageFile();
      const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
      const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
      try{
        await page.goto(url);
        const select=page.locator('#meSelect');
        expect(await select.isVisible()).toBe(true);
        expect(await select.inputValue()).toBe('');
        expect(await select.locator('option').allTextContents()).toEqual(['вся команда','Алия Тестовая','Борис Тестовый']);
        expect(await names(page)).toEqual(['Алия Тестовая','Борис Тестовый']);
        await select.selectOption('s');
        expect(await names(page)).toEqual(['Алия Тестовая']);
        // Строка не раскрывается сама: задачи показывает блок 05, долги и списки открываются по нажатию.
        const row=bodyRows(page).first();
        expect(await row.getAttribute('aria-expanded')).toBe('false');
        await row.click();
        expect(await page.locator(`#${await row.getAttribute('aria-controls')}`).getAttribute('class')).toContain('open');
        expect(await page.locator('#sales .trow.group:visible').count()).toBe(1);
        expect(await page.locator('#sales .team-all').isVisible()).toBe(true);
        expect(await page.locator('#tasks .filters [aria-pressed="true"]').getAttribute('data-f')).toBe('s');
        expect(await page.locator('#tasks .task').count()).toBe(1);
        expect(await page.locator('#tasks').innerText()).toContain('Задача Алии');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.locator('[data-p="week"]').click();
        expect(await names(page)).toEqual(['Алия Тестовая']);
        await page.reload();
        expect(await page.locator('#meSelect').inputValue()).toBe('s');
        expect(await names(page)).toEqual(['Алия Тестовая']);
        await page.locator('#sales .team-all').click();
        expect(await names(page)).toEqual(['Алия Тестовая','Борис Тестовый']);
        await page.locator('#meSelect').selectOption('t');
        expect(await names(page)).toEqual(['Борис Тестовый']);
        expect(await page.locator('#sales .trow.group:visible').getAttribute('data-group')).toBe('tenders');
        await page.locator('#meSelect').selectOption('');
        expect(await names(page)).toEqual(['Алия Тестовая','Борис Тестовый']);
        expect(await page.locator('#tasks .filters [aria-pressed="true"]').getAttribute('data-f')).toBe('all');
        expect(errors).toEqual([]);
      }finally{await page.close();}
    },20000);
  }
  it('shows the whole team in TV and ignores an unknown saved person',async()=>{
    const url=pageFile();
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    try{
      await page.goto(url);
      await page.locator('#meSelect').selectOption('s');
      await page.keyboard.press('t');
      expect(await page.locator('#meSelect').isVisible()).toBe(false);
      expect(await page.locator('#sales .trow.body').count()).toBe(2);
      expect(await page.locator('#sales .team-all').count()).toBe(0);
      await page.keyboard.press('t');
      expect(await names(page)).toEqual(['Алия Тестовая']);
      await page.evaluate(()=>localStorage.setItem('pult-me','nobody'));
      await page.reload();
      expect(await page.locator('#meSelect').inputValue()).toBe('');
      expect(await names(page)).toEqual(['Алия Тестовая','Борис Тестовый']);
    }finally{await page.close();}
  });
});
