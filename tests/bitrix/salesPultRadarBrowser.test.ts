import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { chromium, type Browser } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { renderPultHtml, renderRegisterHtml } from "../../src/bitrix/salesPult/site.js";
import type { SalesPultPayload, RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import type { RadarView } from "../../src/bitrix/salesPult/radar/types.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

function pageFile(payload: SalesPultPayload): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-radar-"));
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, renderPultHtml(payload));
  return pathToFileURL(file).href;
}

function regPageFile(payload: RegisterPagePayload): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-radar-"));
  const file = path.join(dir, "reg.html");
  fs.writeFileSync(file, renderRegisterHtml(payload));
  return pathToFileURL(file).href;
}

function samplePayloadWithRadar(): SalesPultPayload {
  const f = fixture();
  f.payload.portal = "https://f3.bitrix24.kz";

  const radar: RadarView = {
    asOf: "2026-11-10",
    ip: {
      group: "ИП",
      kpis: {
        totalCount: 5,
        totalSum: 25000000,
        submitCount: 2,
        submitSum: 10000000,
        discussionCount: 1,
        discussionSum: 5000000,
        secondChanceCount: 2,
        secondChanceSum: 10000000
      },
      submitToday: [
        {
          id: "4301",
          dealUrl: "https://f3.bitrix24.kz/crm/deal/details/4301/",
          sourceType: "lot",
          lotNumber: "83132229-ЗЦП1",
          planNumber: "83132229",
          lotUrl: "https://goszakup.gov.kz/ru/registry/lots/83132229",
          announceUrl: "https://goszakup.gov.kz/ru/announce/index/12345678",
          title: "Интерактивная панель 75",
          itemName: "Интерактивная панель 75",
          qty: 10,
          sum: 6500000,
          method: "Запрос ценовых предложений",
          status: "Опубликован (прием заявок)",
          group: "ИП",
          kind: "Интерактивные панели",
          customerName: "КГУ Школа-лицей №1",
          customerBin: "010203040506",
          managerId: "s",
          managerName: "Алия Менеджер",
          startAt: "2026-11-09 10:00",
          endAt: "2026-11-10 18:00",
          hoursLeft: 6,
          isToday: true,
          isWithin48h: true,
          column: "submitToday"
        },
        {
          id: "4302",
          dealUrl: "https://f3.bitrix24.kz/crm/deal/details/4302/",
          sourceType: "lot",
          lotNumber: "83132230-ЗЦП1",
          planNumber: "83132230",
          title: "Интерактивная панель 65",
          itemName: "Интерактивная панель 65",
          qty: 5,
          sum: 3500000,
          method: "ЗЦП",
          status: "Опубликован (прием заявок)",
          group: "ИП",
          kind: "Интерактивные панели",
          customerName: "ТОО Тест",
          customerBin: "123456789012",
          managerId: "t",
          managerName: "Борис",
          startAt: "2026-11-09 10:00",
          endAt: "2026-11-12 18:00",
          hoursLeft: 54,
          isToday: false,
          isWithin48h: false,
          column: "submitToday"
        }
      ],
      discussion: [
        {
          id: "4303",
          dealUrl: "https://f3.bitrix24.kz/crm/deal/details/4303/",
          sourceType: "lot",
          lotNumber: "83132231-ОК1",
          planNumber: "83132231",
          title: "Интерактивная доска",
          itemName: "Интерактивная доска",
          qty: 8,
          sum: 5000000,
          method: "Открытый конкурс",
          status: "Опубликован",
          group: "ИП",
          kind: "Интерактивные и спец. доски",
          customerName: "КГКП Детский сад",
          customerBin: "998877665544",
          managerId: "s",
          managerName: "Алия Менеджер",
          startAt: "2026-11-15 10:00",
          endAt: "2026-11-25 18:00",
          hoursLeft: null,
          isToday: false,
          isWithin48h: false,
          column: "discussion"
        }
      ],
      secondChance: [
        {
          id: "4304",
          dealUrl: "https://f3.bitrix24.kz/crm/deal/details/4304/",
          sourceType: "lot",
          lotNumber: "83132232-ЗЦП1",
          planNumber: "83132232",
          title: "Интерактивный комплекс",
          itemName: "Интерактивный комплекс",
          qty: 3,
          sum: 6000000,
          method: "ЗЦП",
          status: "Закупка не состоялась",
          group: "ИП",
          kind: "Интерактивные панели",
          customerName: "ГККП Колледж",
          customerBin: "445566778899",
          managerId: "s",
          managerName: "Алия Менеджер",
          startAt: null,
          endAt: null,
          hoursLeft: null,
          isToday: false,
          isWithin48h: false,
          column: "secondChance"
        },
        {
          id: "9005",
          dealUrl: "https://f3.bitrix24.kz/crm/deal/details/9005/",
          sourceType: "plan",
          planNumber: "83132233",
          title: "Интерактивная панель 86",
          itemName: "Интерактивная панель 86",
          qty: 2,
          sum: 4000000,
          method: "ОК",
          status: "failed:закупка не состоялась",
          group: "ИП",
          kind: "Интерактивные панели",
          customerName: "ТОО Центр",
          customerBin: "332211009988",
          managerId: "t",
          managerName: "Борис",
          startAt: null,
          endAt: null,
          hoursLeft: null,
          isToday: false,
          isWithin48h: false,
          column: "secondChance"
        }
      ]
    },
    kt: {
      group: "КТ",
      kpis: {
        totalCount: 1,
        totalSum: 15000000,
        submitCount: 1,
        submitSum: 15000000,
        discussionCount: 0,
        discussionSum: 0,
        secondChanceCount: 0,
        secondChanceSum: 0
      },
      submitToday: [
        {
          id: "4305",
          dealUrl: "https://f3.bitrix24.kz/crm/deal/details/4305/",
          sourceType: "lot",
          lotNumber: "77770001-ОК1",
          planNumber: "77770001",
          title: "Компьютеры в сборе",
          itemName: "Компьютер Core i7",
          qty: 30,
          sum: 15000000,
          method: "Открытый конкурс",
          status: "Опубликован (прием заявок)",
          group: "КТ",
          kind: "Компьютеры и системные блоки",
          customerName: "КГУ Акимат",
          customerBin: "111222333444",
          managerId: "t",
          managerName: "Борис",
          startAt: "2026-11-08 10:00",
          endAt: "2026-11-10 18:00",
          hoursLeft: 6,
          isToday: true,
          isWithin48h: true,
          column: "submitToday"
        }
      ],
      discussion: [],
      secondChance: []
    }
  };

  (f.payload as unknown as Record<string, unknown>).radar = radar;
  return f.payload;
}

describe("Sales Pult Radar Browser UI", () => {
  it("renders 'Радар' nav link between 'Сегодня' and 'Выручка'", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const url = pageFile(samplePayloadWithRadar());
      await page.goto(url);

      const navLinks = await page.locator("nav.sections a").allTextContents();
      // Should have: Сегодня · Радар · Выручка · Планы · Рынок
      expect(navLinks[0]).toContain("Сегодня");
      expect(navLinks[1]).toContain("Радар");
      expect(navLinks[2]).toContain("Выручка");
      expect(navLinks[3]).toContain("Планы");
      expect(navLinks[4]).toContain("Рынок");
    } finally {
      await page.close();
    }
  });

  it("navigates to #radar-ip, displays 4 KPI tiles, 3 columns, and controls", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const url = pageFile(samplePayloadWithRadar()) + "#radar-ip";
      await page.goto(url);

      // Verify radar-ip tab is active
      const radarTab = page.locator("#tab-radar-ip");
      expect(await radarTab.getAttribute("class")).toContain("on");

      // Product switch is visible
      const productSwitch = page.locator("#productSwitch");
      expect(await productSwitch.isVisible()).toBe(true);

      // meSelect is visible
      const meSelect = page.locator("#meSelect");
      expect(await meSelect.isVisible()).toBe(true);

      // Period buttons (Сегодня, Неделя, Месяц) are hidden
      const dayBtn = page.locator('button[data-p="day"]');
      expect(await dayBtn.isVisible()).toBe(false);

      // Check 4 KPI tiles in tab-radar-ip
      const kpis = radarTab.locator(".radar-kpis .tile, .kpis .tile");
      expect(await kpis.count()).toBe(4);

      // Check 3 columns in tab-radar-ip
      const cols = radarTab.locator(".radar-col");
      expect(await cols.count()).toBe(3);

      // Column 1 should have 2 cards
      const col1Cards = cols.nth(0).locator(".radar-card");
      expect(await col1Cards.count()).toBe(2);

      // Check card contents: item name, sum, customer, links
      const firstCard = col1Cards.first();
      expect(await firstCard.innerText()).toContain("Интерактивная панель 75");
      expect(await firstCard.innerText()).toContain("6,5 млн ₸");
      expect(await firstCard.innerText()).toContain("Сделка #4301");
      expect(await firstCard.innerText()).toContain("Школа-лицей №1");

      // Check switching to KT via product switch
      await page.locator('#productSwitch button[data-product="kt"]').click();
      expect(page.url()).toContain("#radar-kt");
      const radarKtTab = page.locator("#tab-radar-kt");
      expect(await radarKtTab.getAttribute("class")).toContain("on");
      expect(await radarKtTab.innerText()).toContain("Компьютер Core i7");
    } finally {
      await page.close();
    }
  });

  it("quick search (⌘K / /) indexes radar lots", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const url = pageFile(samplePayloadWithRadar()) + "#pult";
      await page.goto(url);

      // Open quick search modal
      await page.locator("#searchBtn").click();
      const modal = page.locator("#searchModal");
      expect(await modal.isVisible()).toBe(true);

      // Search by lot number
      const input = page.locator("#quickSearchInput");
      await input.fill("83132229");

      const results = page.locator("#searchResults .search-item");
      expect(await results.count()).toBeGreaterThanOrEqual(1);
      expect(await results.first().innerText()).toContain("83132229");
    } finally {
      await page.close();
    }
  });

  it("calls animate(document.getElementById('calls')) on period switch so data-count animates", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const url = pageFile(samplePayloadWithRadar()) + "#pult";
      await page.goto(url);

      // Switch to week period
      await page.locator('button[data-p="week"]').click();

      // Verify the calls counter has animated (not stuck at "0")
      const callsVal = page.locator('#calls .callstrip .v[data-count]').first();
      const text = await callsVal.textContent();
      // Should not be "0" if data-count > 0
      const countAttr = await callsVal.getAttribute("data-count");
      if (Number(countAttr) > 0) {
        expect(Number(text)).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  });

  it("fixes register gross/sale text formatting without glued numbers", async () => {
    const f = fixture();
    f.register.groups = [
      { g: "ИП", sale: 35000000, val: 12700000 },
      { g: "КТ", sale: 15000000, val: 5300000 }
    ];
    const regPayload: RegisterPagePayload = {
      asOfDate: "2026-11-10",
      generatedAt: "2026-11-10 12:00",
      register: f.register
    };

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const url = regPageFile(regPayload);
      await page.goto(url);

      const gsumText = await page.locator(".gsum").textContent();
      // Should NOT contain "35,0 12,7" glued together
      expect(gsumText).not.toContain("35,0 12,7");
      // Should contain "35,0 млн (маржа 12,7 млн · 36%)"
      expect(gsumText).toMatch(/35,0\s+млн\s+\(маржа\s+12,7\s+млн\s+·\s+36%\)/);
    } finally {
      await page.close();
    }
  });
});
