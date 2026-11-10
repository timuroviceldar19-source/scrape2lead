import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { chromium, type Browser } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { attachRegisterContracts } from "../../src/bitrix/salesPult/contracts.js";
import { renderPultHtml } from "../../src/bitrix/salesPult/site.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import type { PlansGroupView } from "../../src/bitrix/salesPult/plans/types.js";
import type { MarketGroupView, MarketView } from "../../src/kz/market/types.js";
import type { ManagerDebts } from "../../src/bitrix/salesPult/debts.js";

const clean = (s: string) => s.replace(/\s+/g, " ");

function pageFile(payload: SalesPultPayload): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-wow-"));
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, renderPultHtml(payload));
  return pathToFileURL(file).href + "#pult";
}

function sampleWow(): SalesPultPayload {
  const f = fixture();
  f.payload.portal = "https://test.bitrix24.kz";
  attachRegisterContracts(f.payload, f.register, f.deals, f.aliases);

  // Outcome mismatches
  f.payload.outcomeMismatches = [
    {
      id: "701",
      title: "Сделка Алии",
      amount: 1500000,
      managerId: "s",
      managerName: "Алия Тестовая",
      outcome: "lost:other",
      portalSignDate: "2026-10-23"
    },
    {
      id: "702",
      title: "Сделка Бориса",
      amount: 2500000,
      managerId: "t",
      managerName: "Борис Тестовый",
      outcome: "lost:other",
      portalSignDate: "2026-10-24"
    }
  ];

  // Debts on manager 's' (Алия)
  const debtsS: ManagerDebts = {
    overdue: 2,
    overdueOverMonth: 1,
    overdueOverMonthTasks: [],
    overdueOngoing: 0,
    newDeals: 3,
    newStaleDeals: 1,
    newOldestAgeDays: 4,
    newDealsList: [
      { dealId: "801", title: "Новая сделка 801", amount: 500000, ageDays: 2 }
    ],
    overdueList: [
      { dealId: "802", title: "Просроченная сделка 802", amount: 700000, overdueDays: 3 }
    ],
    readyToCloseDealIds: ["803"],
    readyToCloseDeals: [
      { dealId: "803", title: "Сделка 803 пора закрыть", amount: 300000, kind: "passed" as const }
    ],
    wonOnPortalNotClosed: 2,
    wonOnPortalNotClosedDeals: [
      { dealId: "901", title: "Выигранный портал 901", amount: 2000000, portalSignDate: "2026-10-25" },
      { dealId: "902", title: "Выигранный портал 902", amount: 1500000, portalSignDate: "2026-10-26" }
    ]
  };
  f.payload.groups[0].managers[0].debts = debtsS;

  // Calls across periods for group 0
  const m0 = f.payload.groups[0].managers[0];
  m0.rollups.day.calls = { ...m0.rollups.day.calls, successful: 5, totalAttempts: 10, durationMinutes: 15 };
  m0.rollups.week.calls = { ...m0.rollups.week.calls, successful: 25, totalAttempts: 50, durationMinutes: 75 };
  m0.rollups.month.calls = { ...m0.rollups.month.calls, successful: 70, totalAttempts: 140, durationMinutes: 210 };

  // Closed month for switcher tests (created before plans and market are attached)
  const closed = structuredClone(f.payload);
  closed.closedMonth = true;
  closed.asOfDate = "2026-09-30";
  f.payload.closedMonths = { "2026-09": closed };

  // Mock Market
  const marketIp = {
    group: "ИП",
    month: "2026-10",
    total: { sum: 50000000, contracts: 10, qty: 20, suppliers: 5, customers: 8 },
    months: [],
    monthViews: {},
    kinds: [],
    methods: [],
    suppliers: [
      {
        bin: "999999999999",
        name: "ТОО Наша Компания",
        sum: 15000000,
        contracts: 3,
        qty: 6,
        us: true,
        contractList: [
          { id: 1, date: "2026-10-15", supplier: "ТОО Наша Компания", customer: 'КГКП "Школа Постоянная"', kind: "Панель", sum: 5000000, qty: 2, us: true, url: "https://example.invalid" }
        ]
      }
    ],
    customers: [
      {
        bin: "111122223333",
        name: 'КГКП "Школа Постоянная"',
        sum: 5000000,
        us: 5000000,
        contracts: 1,
        contractList: [
          { id: 1, date: "2026-10-15", supplier: "ТОО Наша Компания", customer: 'КГКП "Школа Постоянная"', kind: "Панель", sum: 5000000, qty: 2, us: true, url: "https://example.invalid" }
        ]
      }
    ]
  } as unknown as MarketGroupView;
  f.payload.market = { asOf: "2026-10-28", ip: marketIp, kt: null, educationPending: { totalRows: 0, pendingRows: 0, byMonth: [] } } as unknown as MarketView;

  // Mock Plans
  const openPlans = [
    {
      id: "501",
      dealUrl: "https://test.bitrix24.kz/crm/deal/details/501/",
      planNumber: "100501",
      planUrl: "https://example.invalid/plan/100501",
      month: "2026-10",
      customerName: "Коммунальное государственное казённое предприятие «Школа Постоянная»",
      customerBin: "",
      truCode: "26.20.1",
      itemName: "Панель интерактивная 75",
      price: 2500000,
      outcomeCategory: "open",
      kind: "Интерактивная панель 75",
      qty: 2,
      sum: 5000000,
      portalStatus: "Опубликован",
      isNewStage: false,
      managerId: "s",
      managerName: "Алия Тестовая",
      method: "Запрос ценовых предложений"
    },
    {
      id: "502",
      dealUrl: "https://test.bitrix24.kz/crm/deal/details/502/",
      planNumber: "100502",
      planUrl: "https://example.invalid/plan/100502",
      month: "2026-10",
      customerName: "Лицей Реванш",
      customerBin: "444455556666",
      truCode: "26.20.1",
      itemName: "Панель интерактивная 65",
      price: 2500000,
      outcomeCategory: "open",
      kind: "Интерактивная панель 65",
      qty: 1,
      sum: 2500000,
      portalStatus: "Опубликован",
      isNewStage: true,
      managerId: "t",
      managerName: "Борис Тестовый",
      method: "Открытый конкурс"
    },
    {
      id: "503",
      dealUrl: "https://test.bitrix24.kz/crm/deal/details/503/",
      planNumber: "100503",
      planUrl: "https://example.invalid/plan/100503",
      month: "2026-10",
      customerName: "ТОО Заказчик с Победой",
      customerBin: "777777777777",
      truCode: "26.20.1",
      itemName: "Панель интерактивная 86",
      price: 3000000,
      outcomeCategory: "open",
      kind: "Интерактивная панель 86",
      qty: 1,
      sum: 3000000,
      portalStatus: "Опубликован",
      isNewStage: true,
      managerId: "s",
      managerName: "Алия Тестовая",
      method: "Открытый конкурс"
    }
  ];

  const plansIp = {
    group: "ИП",
    total: {
      sum: 23000000, count: 6, qty: 11, customers: 4,
      openSum: 10500000, openCount: 3, newSum: 5500000, newCount: 2,
      publishedSum: 10500000, publishedCount: 3, createdLast7dCount: 2, createdLast7dSum: 5500000,
      wonSum: 5000000, wonCount: 2, lostSum: 7500000, lostCount: 1, cancelledSum: 0, cancelledCount: 0
    },
    managers: [
      { id: "s", name: "Алия Тестовая", count: 3, openCount: 2, newCount: 1, sum: 8000000, openSum: 8000000, wonCount: 2, wonSum: 5000000, lostCount: 0, planList: [] },
      { id: "t", name: "Борис Тестовый", count: 3, openCount: 1, newCount: 1, sum: 2500000, openSum: 2500000, wonCount: 0, wonSum: 0, lostCount: 1, planList: [] }
    ],
    methods: [{ name: "Запрос ценовых предложений", count: 1, sum: 5000000, openCount: 1 }],
    kinds: [{ kind: "Интерактивная панель 75", count: 1, qty: 2, avgPrice: 2500000, sum: 5000000 }],
    statuses: [{ status: "Опубликован", count: 3, sum: 10500000 }],
    customers: [
      { name: "Школа Постоянная", bin: "111122223333", sum: 5000000, count: 1, openSum: 5000000, openCount: 1, planList: [] },
      { name: "ТОО Заказчик с Победой", bin: "777777777777", sum: 3000000, count: 1, openSum: 0, openCount: 0, wonCount: 1, planList: [] }
    ],
    lostTo: {
      lostCount: 1,
      companies: 1,
      unknownCount: 0,
      competitors: [
        {
          bin: "888888888888",
          name: "ТОО Конкурент",
          count: 1,
          planSum: 3000000,
          contractSum: 2900000,
          knownSumCount: 1,
          cheaperCount: 1,
          deals: [
            {
              id: "601",
              dealUrl: "https://test.bitrix24.kz/crm/deal/details/601/",
              planNumber: "100601",
              planUrl: "https://example.invalid/plan/100601",
              month: "2026-09",
              customerName: "Лицей Реванш",
              itemName: "Панель",
              managerName: "Борис Тестовый",
              planSum: 3000000,
              contractSum: 2900000
            }
          ]
        }
      ]
    },
    months: [{ m: "2026-10", sum: 7500000, count: 2, activeSum: 7500000, wonSum: 5000000, newCount: 1 }],
    monthViews: {},
    openPlans
  } as unknown as PlansGroupView;

  f.payload.plans = { asOf: "2026-10-28", ip: plansIp };

  return f.payload;
}

describe("Пульт продаж: Wow-апгрейд", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  describe("1. Живая воронка денег и реакция на Сегодня / Неделя / Месяц", () => {
    it("renders progress bar in revenue tile and displays potential from wonOnPortalNotClosedDeals", async () => {
      const payload = sampleWow();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(pageFile(payload));
        const revTile = page.locator(".month-tiles .month-tile").nth(1);
        expect(await revTile.locator(".label").innerText()).toBe("ВЫРУЧКА");
        // Must contain .hbar progress bar with .ink class for high contrast
        const contractsTile = page.locator(".month-tiles .month-tile").first();
        expect(await contractsTile.locator(".hbar > span.ink").count()).toBe(1);
        expect(await revTile.locator(".hbar > span.ink").count()).toBe(1);
        // Must contain potential line with won on portal
        const text = await revTile.innerText();
        expect(clean(text)).toContain("+ Ещё 2 на 3,5 млн ₸ выиграно на портале (не закрыты в CRM)");
        expect(clean(text)).toContain("ждёт ОП: 1 сделка");
      } finally {
        await page.close();
      }
    }, 20000);

    it("syncs 4th tile (title, values, .hbar, note) when period is changed via buttons or keys 1/2/3", async () => {
      const payload = sampleWow();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(pageFile(payload));
        const callTile = page.locator(".month-tiles .month-tile").nth(3);
        // Day by default
        expect(await callTile.locator(".label").innerText()).toBe("ДОЗВОНЫ СЕГОДНЯ");
        expect(await callTile.locator(".tile-value").innerText()).toContain("5 / 2");
        expect(await callTile.locator(".hbar").count()).toBe(1);

        // Switch to week via button
        await page.locator('.periods button[data-p="week"]').click();
        expect(await callTile.locator(".label").innerText()).toBe("ДОЗВОНЫ ЗА НЕДЕЛЮ");
        expect(await callTile.locator(".tile-value").innerText()).toContain("25 / 10");

        // Switch to month via key 3
        await page.keyboard.press("3");
        expect(await callTile.locator(".label").innerText()).toBe("ДОЗВОНЫ ЗА МЕСЯЦ");
        expect(await callTile.locator(".tile-value").innerText()).toContain("70 / 40");

        // Switch back to day via key 1
        await page.keyboard.press("1");
        expect(await callTile.locator(".label").innerText()).toBe("ДОЗВОНЫ СЕГОДНЯ");
        expect(await callTile.locator(".tile-value").innerText()).toContain("5 / 2");
      } finally {
        await page.close();
      }
    }, 20000);
  });

  describe("2. Персональный режим «Я — …» 2.0", () => {
    it("displays me-summary in 01, prioritizes urgent signals, auto-expands team detail, and sets plans manager filter", async () => {
      const payload = sampleWow();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(pageFile(payload));
        // Select 's' (Алия Тестовая)
        await page.locator("#meSelect").selectOption("s");

        // 1. Block 01 has personal summary .me-summary
        const meSummary = page.locator(".me-summary");
        expect(await meSummary.isVisible()).toBe(true);
        const summaryText = await meSummary.innerText();
        expect(summaryText).toContain("Алия Тестовая");
        expect(summaryText).toContain("1 / 20"); // contracts fact/target
        expect(summaryText).toContain("5 / 2"); // calls fact/target

        // 2. Block 02: Aliy's urgent mismatch shown first, other team collapsed
        const urgentBlock = page.locator("#signals");
        await page.locator("#signals .outcome-mismatches summary").first().click();
        expect(await urgentBlock.innerText()).toContain("Сделка Алии");
        // Boris's items or other items should be collapsed under summary "У остальных в команде"
        expect(await page.locator(".other-team-signals > summary").isVisible()).toBe(true);
        expect(await page.locator(".other-team-signals > summary").innerText()).toContain("У остальных в команде");

        // Mock clipboard to verify per-block copying of mismatches
        await page.evaluate(() => {
          (window as any).__lastCopied = null;
          Object.defineProperty(navigator, "clipboard", {
            value: { writeText: async (t: string) => { (window as any).__lastCopied = t; } },
            configurable: true
          });
        });

        // Copy button in personal block copies only Aliy's mismatch
        const myCopyBtn = page.locator("#signals .outcome-mismatches:not(.other-team-signals .outcome-mismatches) .copy-chat-btn");
        await myCopyBtn.click();
        const myCopied = await page.evaluate(() => (window as any).__lastCopied);
        expect(myCopied).toContain("Сделка Алии");
        expect(myCopied).not.toContain("Сделка Бориса");

        // Open other team signals and copy button copies only Boris's mismatch
        await page.locator(".other-team-signals > summary").click();
        await page.locator(".other-team-signals .outcome-mismatches > summary").click();
        const otherCopyBtn = page.locator(".other-team-signals .outcome-mismatches .copy-chat-btn");
        await otherCopyBtn.click();
        const otherCopied = await page.evaluate(() => (window as any).__lastCopied);
        expect(otherCopied).toContain("Сделка Бориса");
        expect(otherCopied).not.toContain("Сделка Алии");

        // 3. Block 03: Aliy's row is auto-expanded
        const row = page.locator('#sales .trow.body[aria-controls="d-s"]');
        expect(await row.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator("#d-s").getAttribute("class")).toContain("open");

        // 4. Tab plans: switching to #plans-ip auto-filters by managerId = 's'
        const storedMe = await page.evaluate(() => localStorage.getItem("pult-me"));
        expect(storedMe).toBe("s");
        await page.locator('.sections a[data-t="plans"]').click();
        let activeFilter = page.locator('#tab-plans-ip .plan-filter-group [data-plan-filter="managerId"][aria-pressed="true"]');
        expect(await activeFilter.getAttribute("data-value")).toBe("s");

        // Switch to manager 't' (Борис) and verify plans sync updates managerId to 't'
        await page.locator('.sections a[data-t="pult"]').click();
        await page.locator("#meSelect").selectOption("t");
        await page.locator('.sections a[data-t="plans"]').click();
        activeFilter = page.locator('#tab-plans-ip .plan-filter-group [data-plan-filter="managerId"][aria-pressed="true"]');
        expect(await activeFilter.getAttribute("data-value")).toBe("t");

        // Switch back to all team ('') and verify plans sync clears managerId filter
        await page.locator('.sections a[data-t="pult"]').click();
        await page.locator("#meSelect").selectOption("");
        await page.locator('.sections a[data-t="plans"]').click();
        activeFilter = page.locator('#tab-plans-ip .plan-filter-group [data-plan-filter="managerId"][aria-pressed="true"]');
        expect(await activeFilter.getAttribute("data-value")).toBe("");

        // In TV mode: me-summary is hidden, all team shown
        await page.locator('.sections a[data-t="pult"]').click();
        await page.locator("#meSelect").selectOption("s");
        await page.keyboard.press("t");
        expect(await meSummary.isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    }, 20000);
  });

  describe("3. Прямые ссылки на сделки и кнопка «Скопировать для чата»", () => {
    it("wraps deal title with ID in links in contracts signals, and copies chat text from button", async () => {
      const payload = sampleWow();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(pageFile(payload));
        // Check signal direct link
        const signalLink = page.locator("#signals .sig a[href*='/crm/deal/details/']").first();
        expect(await signalLink.isVisible()).toBe(true);
        expect(await signalLink.getAttribute("href")).toContain("https://test.bitrix24.kz/crm/deal/details/");

        // Open outcome-mismatches and check copy button
        const mismatches = page.locator("#signals .outcome-mismatches");
        await mismatches.locator("summary").click();
        const copyBtn = mismatches.locator(".copy-chat-btn");
        expect(await copyBtn.isVisible()).toBe(true);
        expect(await copyBtn.innerText()).toBe("Скопировать для чата");

        // Click copy button and verify feedback
        await copyBtn.click();
        expect(await copyBtn.innerText()).toBe("Скопировано ✓");

        // Manager detail also has copy button
        const row = page.locator('#sales .trow.body[aria-controls="d-s"]');
        await row.click();
        const mgrCopyBtn = page.locator("#d-s .copy-chat-btn");
        expect(await mgrCopyBtn.isVisible()).toBe(true);
        await mgrCopyBtn.click();
        expect(await mgrCopyBtn.innerText()).toBe("Скопировано ✓");

        // Hidden in TV
        await page.keyboard.press("t");
        expect(await page.locator(".copy-chat-btn:visible").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 20000);
  });

  describe("4. Мгновенный поиск по клавише `/` или ⌘K и фильтр планов", () => {
    it("opens search modal on search button click or `/` and filters across payload", async () => {
      const payload = sampleWow();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(pageFile(payload));
        // Search button in header
        const searchBtn = page.locator("#searchBtn");
        expect(await searchBtn.isVisible()).toBe(true);
        expect(await searchBtn.innerText()).toContain("Поиск");

        // Click search button
        await searchBtn.click();
        const modal = page.locator("#searchModal");
        expect(await modal.isVisible()).toBe(true);

        const input = page.locator("#quickSearchInput");
        expect(await page.evaluate(() => document.activeElement?.id === "quickSearchInput")).toBe(true);

        // Search for a deal
        await input.fill("901");
        const results = page.locator("#searchResults .search-item");
        expect(await results.count()).toBeGreaterThanOrEqual(1);
        expect(await results.first().innerText()).toContain("Выигранный портал 901");

        // Arrow navigation and Esc
        await page.keyboard.press("ArrowDown");
        expect(await results.first().getAttribute("class")).toContain("selected");
        await page.keyboard.press("Escape");
        expect(await modal.isVisible()).toBe(false);

        // Pressing '/' opens it again
        await page.keyboard.press("/");
        expect(await modal.isVisible()).toBe(true);
        await page.keyboard.press("Escape");

        // Search in Open Plans section (05)
        await page.locator('.sections a[data-t="plans"]').click();
        const planSearch = page.locator(".plan-search-input");
        expect(await planSearch.isVisible()).toBe(true);
        await planSearch.fill("Реванш");
        const rows = page.locator(".plans-table .r:not(.head)");
        expect(await rows.count()).toBe(1);
        expect(await rows.first().innerText()).toContain("Лицей Реванш");

        // In closed month: quick search reads from root PAYLOAD
        await page.locator('.sections a[data-t="pult"]').click();
        await page.locator("#monthSelect").selectOption("2026-09");
        await page.keyboard.press("/");
        expect(await modal.isVisible()).toBe(true);
        await input.fill("901");
        const closedResults = page.locator("#searchResults .search-item");
        expect(await closedResults.count()).toBeGreaterThanOrEqual(1);
        expect(await closedResults.first().innerText()).toContain("Выигранный портал 901");

        // Entering TV mode closes search modal
        await input.blur();
        await page.keyboard.press("t");
        expect(await modal.isVisible()).toBe(false);
        await page.keyboard.press("t"); // exit TV
      } finally {
        await page.close();
      }
    }, 20000);
  });

  describe("5. Связка «Планы ↔ Рынок»: метки «покупал у нас» и «ранее забрал конкурент»", () => {
    it("displays good tag for past buyers and warn tag for competitor wins", async () => {
      const payload = sampleWow();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(pageFile(payload));
        await page.locator('.sections a[data-t="plans"]').click();
        const table = page.locator(".plans-table");
        expect(await table.innerText()).toContain("покупал у нас");
        expect(await table.innerText()).toContain("ранее забрал конкурент");

        const goodTag = table.locator(".tag.good");
        expect(await goodTag.first().innerText()).toBe("покупал у нас");

        const warnTag = table.locator(".tag.warn");
        expect(await warnTag.innerText()).toBe("ранее забрал конкурент");

        // 1. Tag for open plan 501: matched by legal form normalization (КГКП in market vs Коммунальное государственное казённое предприятие in plans)
        const row501 = page.locator(".plans-table .r").filter({ hasText: "Школа Постоянная" });
        expect(await row501.locator(".tag.good").innerText()).toBe("покупал у нас");

        // 2. Tag for open plan 502: lost to competitor
        const row502 = page.locator(".plans-table .r").filter({ hasText: "Лицей Реванш" });
        expect(await row502.locator(".tag.warn").innerText()).toBe("ранее забрал конкурент");

        // 3. Tag for open plan 503: matched by wonCount > 0 in plans customers
        const row503 = page.locator(".plans-table .r").filter({ hasText: "ТОО Заказчик с Победой" });
        expect(await row503.locator(".tag.good").innerText()).toBe("покупал у нас");
      } finally {
        await page.close();
      }
    }, 20000);
  });

  describe("6. Отсутствие горизонтального скролла на 1440px и 375px", () => {
    for (const width of [1440, 375]) {
      it(`does not overflow horizontally at ${width}px`, async () => {
        const payload = sampleWow();
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        try {
          await page.goto(pageFile(payload));
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

          // Test search modal at this width
          await page.locator("#searchBtn").click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.keyboard.press("Escape");

          // Test plans tab at this width
          await page.locator('.sections a[data-t="plans"]').click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        } finally {
          await page.close();
        }
      }, 20000);
    }
  });
});
