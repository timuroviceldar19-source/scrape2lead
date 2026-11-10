import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { renderPultHtml, renderRegisterHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import type { RegisterView } from "../../src/bitrix/salesPult/register/types.js";
import { buildMarketGroupView } from "../../src/kz/market/aggregate.js";
import type { MarketUnit, MarketConfig } from "../../src/kz/market/types.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";

vi.setConfig({ testTimeout: 30_000 });

describe("salesPult in-browser Playwright test", () => {
  let browser: Browser;
  let tempDir: string;
  let indexPath: string;
  let regPath: string;
  let debtLayoutPath: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-browser-test-"));
    indexPath = path.join(tempDir, "index.html");
    regPath = path.join(tempDir, "reg.html");

    const cfg: MarketConfig = loadMarketConfig();

    const sampleUnits: MarketUnit[] = [
      {
        id: 1,
        month: "2026-09",
        date: "2026-09-15",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 50000000,
        qty: 50,
        price: 1000000,
        supplier: "061140003942",
        customer: "111111111111",
        supplierName: 'ТОО "F3.kz"',
        customerName: "Школа 1",
        method: "Открытый конкурс",
        us: true
      },
      {
        id: 2,
        month: "2026-10",
        date: "2026-10-10",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 80000000,
        qty: 80,
        price: 1000000,
        supplier: "061140003942",
        customer: "111111111111",
        supplierName: 'ТОО "F3.kz"',
        customerName: "Школа 1",
        method: "Открытый конкурс",
        us: true
      },
      {
        id: 3,
        month: "2026-10",
        date: "2026-10-12",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 40000000,
        qty: 40,
        price: 1000000,
        supplier: "999999999999",
        customer: "222222222222",
        supplierName: "Конкурент ИП",
        customerName: "Школа 2",
        method: "Запрос ценовых предложений",
        us: false
      },
      {
        id: 40,
        month: "2026-01",
        date: "2026-01-15",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 60000000,
        qty: 100,
        price: 600000,
        supplier: "130540000688",
        customer: "333333333333",
        supplierName: 'ТОО "Amanat Asia"',
        customerName: "Колледж 1",
        method: "Электронный магазин",
        us: true
      },
      {
        id: 41,
        month: "2026-10",
        date: "2026-10-10",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 100000000,
        qty: 160,
        price: 625000,
        supplier: "061140003942",
        customer: "555555555555",
        supplierName: 'ТОО "F3.kz"',
        customerName: "Колледж 3",
        method: "Открытый конкурс",
        us: true
      },
      {
        id: 4,
        month: "2026-10",
        date: "2026-10-14",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 120000000,
        qty: 200,
        price: 600000,
        supplier: "130540000688",
        customer: "333333333333",
        supplierName: 'ТОО "Amanat Asia"',
        customerName: "Колледж 1",
        method: "Электронный магазин",
        us: true
      },
      {
        id: 5,
        month: "2026-10",
        date: "2026-10-18",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 90000000,
        qty: 150,
        price: 600000,
        supplier: "888888888888",
        customer: "444444444444",
        supplierName: "Конкурент КТ",
        customerName: "Колледж 2",
        method: "Запрос ценовых предложений",
        us: false
      }
    ];

    const marketIp = buildMarketGroupView("ИП", sampleUnits, "2026-10-29", cfg);
    const marketKt = buildMarketGroupView("КТ", sampleUnits, "2026-10-29", cfg);

    const basePayload: SalesPultPayload = JSON.parse(
      fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8")
    );
    basePayload.portal = "https://ft3.bitrix24.kz";
    basePayload.groups.forEach((g, gi) => g.managers.forEach((m, mi) => {
      m.name = `Тестовый менеджер ${gi + 1}.${mi + 1}`;
    }));
    const firstMgr = basePayload.groups[0].managers[0];
    if (firstMgr.debts) {
      firstMgr.debts.readyToCloseDealIds = ["990001"];
      firstMgr.debts.readyToCloseDeals = [{ kind: "passed", dealId: "990001", title: '<img src=x onerror="window.debtXss=1"> Выдуманная сделка', amount: 123000 }];
      firstMgr.debts.newDeals = 60;
      firstMgr.debts.newDealsList = [{ dealId: "990002", title: "Выдуманная новая сделка", amount: 200, ageDays: 8 }];
      firstMgr.debts.overdue = 1;
      firstMgr.debts.overdueList = [{ dealId: "990003", title: "Выдуманная просроченная сделка", amount: 300, overdueDays: 12 }];
      firstMgr.debts.wonOnPortalNotClosed = 1;
      firstMgr.debts.wonOnPortalNotClosedDeals = [{ dealId: "990004", title: "Выдуманная победа", amount: 400, portalSignDate: "2026-10-30" }];
      firstMgr.debts.overdueOverMonth = 2;
      firstMgr.debts.overdueOverMonthTasks = [
        {
          dealId: "900501",
          title: "[GZ 9000501] Тестовая школа №101 — Моноблоки",
          amount: 4500000,
          currency: "KZT",
          overdueDays: 42,
          deadline: "2026-09-10T12:00:00+05:00"
        },
        {
          dealId: "900502",
          title: "[GZ 9000502] Тестовый лицей №102 — Принтеры",
          amount: 1200000,
          currency: "KZT",
          overdueDays: 35,
          deadline: "2026-09-17T12:00:00+05:00"
        }
      ];
    }
    if (firstMgr.topTasks && firstMgr.topTasks.length > 0) {
      firstMgr.topTasks[0].passedPlanMonthNote = "план на сентябрь прошёл";
      firstMgr.topTasks[0].contactedAfterDeadlineNote = "связался — закрыть дело / поставить следующий шаг";
    }
    basePayload.outcomeMismatches = [
      {
        id: "45477",
        title: "[GZ 87744345] Школа №72 - Компьютер",
        amount: 4280000,
        managerId: "147",
        managerName: "Эльмира",
        stageId: "C41:LOSE",
        outcome: "won:991140002353/260055",
        portalSignDate: "2026-09-29"
      }
    ];
    basePayload.market = {
      educationPending: {},
      asOf: "2026-10-29",
      months: ["2026-01", "2026-09", "2026-10"],
      ip: marketIp,
      kt: marketKt,
      updatedAt: "2026-10-29"
    };

    const regView: RegisterView = {
      file: "ОП 29.10.26.xlsx",
      asOf: "2026-10-29",
      month: "2026-10",
      total: {
        sale: 293000000,
        val: 78500000,
        bonusMop: 2350000,
        bonusRop: 390000,
        contracts: 84,
        plan: 250000000,
        b2bPlan: 40000000,
        b2bSale: 35000000
      },
      daily: [{ d: "2026-10-01", sale: 10000000 }],
      managers: [
        {
          name: "Эльмира",
          sale: 50000000,
          val: 15000000,
          margin: 0.3,
          bonus: 450000,
          plan: 30000000,
          contracts: 12,
          missCount: 0,
          missSum: 0,
          rows: []
        }
      ],
      mix: [
        {
          kind: "Интерактивные панели",
          group: "ИП",
          sale: 118400000,
          val: 35000000,
          qty: 50,
          contracts: 30
        }
      ],
      channels: [{ name: "ЗЦП", sale: 100000000, val: 30000000, contracts: 25 }],
      groups: [
        { g: "ИП", sale: 118400000, val: 35000000 },
        { g: "КТ", sale: 174500000, val: 43500000 }
      ],
      missing: [],
      crmExtra: 0,
      rows: []
    };

    const regPayload: RegisterPagePayload = {
      asOfDate: "2026-10-29",
      generatedAt: "2026-10-29 15:30 (UTC+5)",
      portal: "ft3.bitrix24.kz",
      pultUrl: "https://f3-pult.pages.dev",
      register: regView
    };

    const closed = structuredClone(basePayload);
    closed.asOfDate = "2026-09-30";
    closed.generatedAt = "2026-09-30 23:59 (UTC+5)";
    closed.closedMonth = true;
    closed.groups.forEach((g) => g.managers.forEach((m) => {
      m.rollups.month.contracts.uniqueDealsCount = 7;
      m.rollups.month.contracts.totalAmount = 700;
    }));
    basePayload.closedMonths = { "2026-09": closed, "2026-08": null };
    debtLayoutPath = path.join(tempDir, "debt-layout.html");
    const layoutPayload = structuredClone(basePayload);
    const layoutDebts = layoutPayload.groups[0].managers[0].debts!;
    const examples = Array.from({ length: 26 }, (_, i) => ({
      dealId: `9990${i}`, title: `Выдуманная образовательная организация номер ${i + 1} — поставка оборудования для учебных кабинетов`, amount: 100000 + i
    }));
    layoutDebts.readyToCloseDealIds = examples.map(d => d.dealId);
    layoutDebts.readyToCloseDeals = examples.map(d => ({ ...d, kind: "passed" }));
    layoutDebts.newDeals = 26;
    layoutDebts.newDealsList = examples.map(d => ({ ...d, ageDays: 8 }));
    layoutDebts.overdue = 26;
    layoutDebts.overdueList = examples.map(d => ({ ...d, overdueDays: 42 }));
    layoutDebts.wonOnPortalNotClosed = 26;
    layoutDebts.wonOnPortalNotClosedDeals = examples.map(d => ({ ...d, portalSignDate: "2026-10-30" }));
    layoutDebts.overdueOverMonth = 26;
    layoutDebts.overdueOverMonthTasks = examples.map(d => ({ ...d, overdueDays: 42, deadline: "2026-09-01" }));
    fs.writeFileSync(debtLayoutPath, renderPultHtml(layoutPayload), "utf8");
    fs.writeFileSync(indexPath, renderPultHtml(basePayload), "utf8");
    fs.writeFileSync(regPath, renderRegisterHtml(regPayload), "utf8");

    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    if (browser) await browser.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it.each(["click", "Enter", " "])("opens ready-to-close from the debt label using %s and escapes titles", async (action) => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(`${pathToFileURL(indexPath).href}#pult`);
    const row = page.locator("#sales .trow.body").filter({ hasText: "Тестовый менеджер 1.1" });
    const button = row.getByRole("button", { name: /пора закрыть/ });
    expect(await button.count()).toBe(1);
    if (action === "click") await button.click();
    else { await button.focus(); await button.press(action); }
    expect(await row.getAttribute("aria-expanded")).toBe("true");
    const detail = page.locator("#" + await row.getAttribute("aria-controls"));
    const list = detail.locator('details[data-debt-list="readyToCloseDeals"]');
    expect(await list.getAttribute("open")).not.toBeNull();
    const link = list.locator('a[href$="/crm/deal/details/990001/"]');
    expect(await link.isVisible()).toBe(true);
    expect(await link.textContent()).toBe('<img src=x onerror="window.debtXss=1"> Выдуманная сделка');
    expect(await link.getAttribute("target")).toBe("_blank");
    expect(await list.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).debtXss)).toBeUndefined();
    // A repeated activation must keep the row open; a plain row click still toggles it.
    await button.click();
    expect(await row.getAttribute("aria-expanded")).toBe("true");
    await row.locator(".who").click();
    expect(await row.getAttribute("aria-expanded")).toBe("false");
    await page.close();
  });

  it.each([1440, 375])("opens other debt lists with age, sign date and omitted count at width %i", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await page.goto(`${pathToFileURL(indexPath).href}#pult`);
    const row = page.locator("#sales .trow.body").filter({ hasText: "Тестовый менеджер 1.1" });
    for (const [label, key, text] of [
      [/без звонка/, "newDealsList", "без звонка 8 дней"],
      [/просрочен/, "overdueList", "просрочено 12 дней"],
      [/выиграно на портале/, "wonOnPortalNotClosedDeals", "подписан 30.10"]
    ] as const) {
      await row.getByRole("button", { name: label }).click();
      const list = page.locator("#" + await row.getAttribute("aria-controls")).locator(`details[data-debt-list="${key}"]`);
      expect(await list.getAttribute("open")).not.toBeNull();
      expect((await list.textContent())?.replace(/\u00a0/g, " ")).toContain(text);
      expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (key === "newDealsList") expect(await list.textContent()).toContain("и ещё 59 в Битриксе");
    }
    await page.close();
  });

  it("uses the full manager detail width for all five lists without nested scrolling at 1440 px", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await page.goto(pathToFileURL(debtLayoutPath).href);
    const row = page.locator("#sales .trow.body").filter({ hasText: "Тестовый менеджер 1.1" });
    await row.locator(".who").click();
    const detail = page.locator("#" + await row.getAttribute("aria-controls"));
    const lists = detail.locator("details");
    expect(await lists.count()).toBe(5);
    for (const list of await lists.all()) {
      await list.locator("summary").click();
      const layout = await list.evaluate(el => ({
        width: el.getBoundingClientRect().width,
        detailWidth: el.closest(".detail-in")!.getBoundingClientRect().width,
        inStats: !!el.closest(".dstats"),
        scrolls: [el, ...el.querySelectorAll("*")].filter(node => /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)).length
      }));
      expect(layout.width).toBeGreaterThanOrEqual(layout.detailWidth * 0.7);
      expect(layout.inStats).toBe(false);
      expect(layout.scrolls).toBe(0);
      expect(await list.locator(".old-task-link").first().evaluate(el => getComputedStyle(el).wordBreak)).toBe("normal");
      expect((await list.locator(".old-task-meta").first().boundingBox())!.width).toBeCloseTo(240, 0);
    }
    await page.close();
  });

  it("keeps urgent tasks beside counters and closed lists compact at 1440 px", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await page.goto(pathToFileURL(debtLayoutPath).href);
    const row = page.locator("#sales .trow.body").filter({ hasText: "Тестовый менеджер 1.1" });
    await row.locator(".who").click();
    const detail = page.locator("#" + await row.getAttribute("aria-controls"));
    const stats = (await detail.locator(".dstats").boundingBox())!;
    const urgent = (await detail.locator(".manager-urgent").boundingBox())!;
    expect(urgent.y).toBeCloseTo(stats.y, 0);
    expect(urgent.x).toBeGreaterThan(stats.x + stats.width);
    const lists = await detail.locator("details").all();
    const first = (await lists[0].boundingBox())!;
    expect(first.y - Math.max(stats.y + stats.height, urgent.y + urgent.height)).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < lists.length; i++) {
      const prev = (await lists[i - 1].boundingBox())!;
      const next = (await lists[i].boundingBox())!;
      expect(next.y - prev.y - prev.height).toBeGreaterThanOrEqual(8);
      expect(next.y - prev.y - prev.height).toBeLessThanOrEqual(12);
    }
    await page.close();
  });

  it("shows ten of 26 rows on mobile, then expands the other sixteen in every debt list", async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });
    await page.goto(pathToFileURL(debtLayoutPath).href);
    const row = page.locator("#sales .trow.body").filter({ hasText: "Тестовый менеджер 1.1" });
    await row.locator(".who").click();
    const detail = page.locator("#" + await row.getAttribute("aria-controls"));
    for (const list of await detail.locator("details").all()) {
      await list.locator("summary").click();
      expect(await list.locator(".old-task-item:visible").count()).toBe(10);
      const more = list.getByRole("button", { name: "показать ещё 16", exact: true });
      expect(await more.isVisible()).toBe(true);
      const title = (await list.locator(".old-task-link").first().boundingBox())!;
      const meta = (await list.locator(".old-task-meta").first().boundingBox())!;
      expect(meta.y).toBeGreaterThanOrEqual(title.y + title.height);
      await more.click();
      expect(await list.locator(".old-task-item:visible").count()).toBe(26);
      expect(await more.isVisible()).toBe(false);
      expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.close();
  });

  it.each(["reduce", "no-preference"] as const)("scrolls the selected list into view with reduced motion %s", async (reducedMotion) => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion });
    await page.addInitScript(() => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function(options) {
        if (this.matches("details[data-debt-list]")) (window as any).debtScroll = options;
        original.call(this, options);
      };
    });
    await page.goto(pathToFileURL(debtLayoutPath).href);
    const row = page.locator("#sales .trow.body").filter({ hasText: "Тестовый менеджер 1.1" });
    await row.getByRole("button", { name: /пора закрыть/ }).click();
    await page.waitForFunction(() => !!(window as any).debtScroll, undefined, { timeout: 2000 });
    expect(await page.evaluate(() => (window as any).debtScroll)).toMatchObject({ block: "nearest", behavior: reducedMotion === "reduce" ? "instant" : "smooth" });
    await page.waitForFunction(() => {
      const summary = document.querySelector('#sales details[data-debt-list="readyToCloseDeals"][open] > summary');
      const header = document.querySelector(".dateline");
      if (!summary || !header) return false;
      const box = summary.getBoundingClientRect();
      return box.top >= header.getBoundingClientRect().bottom && box.top < innerHeight;
    }, undefined, { timeout: 2000 });
    await page.close();
  });

  it.each([1280, 375])("keeps periods visible at tenders on width %i", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 850 }, reducedMotion: "reduce" });
    await page.goto(`${pathToFileURL(indexPath).href}#pult`);
    await page.locator("#tenders").scrollIntoViewIfNeeded();
    const nav = await page.locator("#periodsNav").boundingBox();
    expect(nav).not.toBeNull();
    expect(nav!.y).toBeGreaterThanOrEqual(0);
    expect(nav!.y + nav!.height).toBeLessThan(850);
    await page.evaluate(() => document.getElementById("tenders")!.scrollIntoView());
    const heading = await page.locator("#tenders h2").boundingBox();
    expect(heading!.y).toBeGreaterThanOrEqual(nav!.y + nav!.height);
    await page.waitForFunction(() => document.getElementById("tenders")!.classList.contains("in"));
    if (process.env.PULT_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.PULT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PULT_SCREENSHOT_DIR, `pult-${width}.png`), animations: "disabled" });
    }
    await page.close();
  });

  it("opens and switches a closed month, hides live sections, and restores current month for TV", async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(`${pathToFileURL(indexPath).href}#pult/2026-09`);
    expect(await page.locator("#month h2").textContent()).toContain("Сентябрь");
    expect(await page.locator('#periodsNav [data-p="day"]').isVisible()).toBe(false);
    expect(await page.locator('#periodsNav [data-p="week"]').isVisible()).toBe(false);
    expect(await page.locator("#signals").isVisible()).toBe(false);
    expect(await page.locator("#tasks").isVisible()).toBe(false);
    expect(await page.locator("#month .readout").isVisible()).toBe(false);
    expect(await page.locator("#month .verdict").textContent()).toContain("Выполнено");
    if (process.env.PULT_SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.PULT_SCREENSHOT_DIR, "pult-closed-month.png") });
    }
    expect(await page.locator('#monthSelect option[value="2026-08"]').evaluate((option) => (option as HTMLOptionElement).disabled)).toBe(true);
    const septemberFact = await page.locator("#month .big").getAttribute("data-count");
    await page.selectOption("#monthSelect", "2026-10");
    expect(await page.locator("#month h2").textContent()).toContain("Октябрь");
    expect(await page.locator("#month .big").getAttribute("data-count")).not.toBe(septemberFact);
    await page.selectOption("#monthSelect", "2026-09");
    expect(page.url()).toContain("#pult/2026-09");
    await page.locator('.sections a[data-t="ip"]').click();
    expect(await page.locator("#periodsNav").isVisible()).toBe(false);
    expect(await page.locator("#tab-ip").textContent()).toContain("ИП");
    await page.locator('.sections a[data-t="pult"]').click();
    await page.locator("#tvBtn").click();
    expect(await page.locator("#month h2").textContent()).toContain("Октябрь");
    await page.close();
  });

  it.each(["__proto__", "constructor", "2026-13"])("opens the current month for a link to #pult/%s", async (key) => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.goto(`${pathToFileURL(indexPath).href}#pult/${key}`);
    expect(await page.locator("#month h2").textContent()).toContain("Октябрь");
    expect(await page.locator("#monthSelect").inputValue()).toBe("2026-10");
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it("loads standalone reg.html: no console errors, reveal sections visible (opacity=1), data-w bars width > 0", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(pathToFileURL(regPath).href);
    await page.waitForTimeout(300);

    // Scroll to reveal all sections
    await page.evaluate(async () => {
      for (let y = 0; y <= document.body.scrollHeight; y += 250) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    await page.waitForTimeout(800);

    expect(consoleErrors).toEqual([]);

    // Check that sections with .reveal are visible (opacity === 1)
    const opacities = await page.evaluate(() => {
      const reveals = [...document.querySelectorAll(".reveal")];
      return reveals.map((el) => window.getComputedStyle(el).opacity);
    });
    expect(opacities.length).toBeGreaterThan(0);
    for (const op of opacities) {
      expect(Number(op)).toBeGreaterThanOrEqual(0.98);
    }

    // Check that data-w bars have width > 0
    const widths = await page.evaluate(() => {
      const bars = [...document.querySelectorAll(".hbar span[data-w]")];
      return bars.map((el) => (el as HTMLElement).offsetWidth);
    });
    expect(widths.length).toBeGreaterThan(0);
    const nonZeroBars = widths.filter((w) => w > 0);
    expect(nonZeroBars.length).toBeGreaterThan(0);

    await page.close();
  }, 20_000);

  it("loads pult market tab #ip: no console errors, reveal sections visible, month bars height > 0, data-w bars width > 0", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`${pathToFileURL(indexPath).href}#ip`);
    await page.waitForTimeout(400);

    await page.evaluate(async () => {
      for (let y = 0; y <= document.body.scrollHeight; y += 250) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    await page.waitForTimeout(800);

    expect(consoleErrors).toEqual([]);

    // Check .reveal sections visible
    const opacities = await page.evaluate(() => {
      const reveals = [...document.querySelectorAll("#tab-ip .reveal")];
      return reveals.map((el) => window.getComputedStyle(el).opacity);
    });
    expect(opacities.length).toBeGreaterThan(0);
    for (const op of opacities) {
      expect(Number(op)).toBeGreaterThanOrEqual(0.98);
    }

    // Check that month columns (.tot) have height > 0
    const heights = await page.evaluate(() => {
      const cols = [...document.querySelectorAll("#tab-ip .months .col .tot")];
      return cols.map((el) => (el as HTMLElement).offsetHeight);
    });
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) {
      expect(h).toBeGreaterThan(0);
    }

    // Check that data-w bars have width > 0
    const widths = await page.evaluate(() => {
      const bars = [...document.querySelectorAll("#tab-ip .hbar span[data-w]")];
      return bars.map((el) => (el as HTMLElement).offsetWidth);
    });
    expect(widths.length).toBeGreaterThan(0);
    const nonZeroBars = widths.filter((w) => w > 0);
    expect(nonZeroBars.length).toBeGreaterThan(0);

    await page.close();
  }, 20_000);

  it("opens contracts on the portal from lost contracts and from a customer's contract list", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    await page.goto(`${pathToFileURL(indexPath).href}#ip`);
    await page.waitForTimeout(400);

    const lostLinks = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>("#tab-ip .lost a.r")].map((a) => ({ href: a.href, target: a.target, rel: a.rel }))
    );
    // In October the IP market has one contract not ours: id 3.
    expect(lostLinks.map((l) => l.href)).toEqual(["https://procurement.gov.kz/ru/egzcontract/cpublic/show/3"]);
    for (const link of lostLinks) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
    }

    // "Школа 1" bought from F3 in October: contract 2, shown as ours.
    const customer = page.locator("#tab-ip div.cust > .cust-d", { hasText: "Школа 1" });
    expect(await customer.locator(".cust-list a.r").isVisible()).toBe(false);
    await customer.locator("summary").click();
    const contractLink = customer.locator(".cust-list a.r");
    expect(await contractLink.isVisible()).toBe(true);
    expect(await contractLink.getAttribute("href")).toBe("https://procurement.gov.kz/ru/egzcontract/cpublic/show/2");
    expect(await contractLink.getAttribute("class")).toContain("us");

    // A supplier row opens the supplier's contracts, each with its customer.
    const supplier = page.locator("#tab-ip .share .cust-d", { hasText: "Конкурент ИП" });
    const supplierLink = supplier.locator(".cust-list a.r");
    expect(await supplierLink.isVisible()).toBe(false);
    await supplier.locator("summary").click();
    expect(await supplierLink.isVisible()).toBe(true);
    expect(await supplierLink.getAttribute("href")).toBe("https://procurement.gov.kz/ru/egzcontract/cpublic/show/3");
    expect(await supplierLink.textContent()).toContain("Школа 2");

    expect(consoleErrors).toEqual([]);
    await page.close();
  }, 20_000);

  it("loads pult market tab #kt: no console errors, reveal sections visible, month bars height > 0, data-w bars width > 0", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`${pathToFileURL(indexPath).href}#kt`);
    await page.waitForTimeout(400);

    await page.evaluate(async () => {
      for (let y = 0; y <= document.body.scrollHeight; y += 250) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    await page.waitForTimeout(800);

    expect(consoleErrors).toEqual([]);

    // Check .reveal sections visible
    const opacities = await page.evaluate(() => {
      const reveals = [...document.querySelectorAll("#tab-kt .reveal")];
      return reveals.map((el) => window.getComputedStyle(el).opacity);
    });
    expect(opacities.length).toBeGreaterThan(0);
    for (const op of opacities) {
      expect(Number(op)).toBeGreaterThanOrEqual(0.98);
    }

    // Check that month columns (.tot) have height > 0
    const heights = await page.evaluate(() => {
      const cols = [...document.querySelectorAll("#tab-kt .months .col .tot")];
      return cols.map((el) => (el as HTMLElement).offsetHeight);
    });
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) {
      expect(h).toBeGreaterThan(0);
    }

    // Check January KT: Amanat Asia > 0, F3 === 0
    const janBars = await page.evaluate(() => {
      const janCol = document.querySelector("#tab-kt .months .col[data-m='2026-01']");
      if (!janCol) return null;
      const our0 = janCol.querySelector(".our.our-0") as HTMLElement | null;
      const our1 = janCol.querySelector(".our.our-1") as HTMLElement | null;
      return {
        our0H: our0 ? our0.offsetHeight : 0,
        our1H: our1 ? our1.offsetHeight : 0
      };
    });
    expect(janBars).not.toBeNull();
    expect(janBars!.our1H).toBeGreaterThan(0);
    expect(janBars!.our0H).toBe(0);

    // Check October KT: both F3 and Amanat Asia > 0
    const octBars = await page.evaluate(() => {
      const octCol = document.querySelector("#tab-kt .months .col[data-m='2026-10']");
      if (!octCol) return null;
      const our0 = octCol.querySelector(".our.our-0") as HTMLElement | null;
      const our1 = octCol.querySelector(".our.our-1") as HTMLElement | null;
      return {
        our0H: our0 ? our0.offsetHeight : 0,
        our1H: our1 ? our1.offsetHeight : 0
      };
    });
    expect(octBars).not.toBeNull();
    expect(octBars!.our0H).toBeGreaterThan(0);
    expect(octBars!.our1H).toBeGreaterThan(0);

    // Check legend has company swatches
    const legendText = await page.evaluate(() => {
      const leg = document.querySelector("#tab-kt .legend");
      return leg ? leg.textContent : "";
    });
    expect(legendText).toContain("F3");
    expect(legendText).toContain("Amanat Asia");

    // Check YTD block
    const ytdCardText = await page.evaluate(() => {
      const card = document.querySelector("#tab-kt .ytd-box");
      return card ? card.textContent : "";
    });
    expect(ytdCardText).toContain("С января по октябрь 2026 года");
    expect(ytdCardText).toContain("F3");
    expect(ytdCardText).toContain("Amanat Asia");

    // Check 480px boundary for KT units: at 627px both header and columns show millions (not billions)
    await page.setViewportSize({ width: 627, height: 900 });
    const at627 = await page.evaluate(() => {
      const meta = document.querySelector("#tab-kt .months")?.closest("section")?.querySelector(".block-head .meta");
      const desktopSpan = meta ? meta.querySelector(".desktop") : null;
      const mobileSpan = meta ? meta.querySelector(".mobile") : null;
      const colLabDesktop = document.querySelector("#tab-kt .months .col .lab .desktop");
      const colLabMobile = document.querySelector("#tab-kt .months .col .lab .mobile");
      return {
        metaDesktopDisplay: desktopSpan ? window.getComputedStyle(desktopSpan).display : "",
        metaMobileDisplay: mobileSpan ? window.getComputedStyle(mobileSpan).display : "",
        colLabDesktopDisplay: colLabDesktop ? window.getComputedStyle(colLabDesktop).display : "",
        colLabMobileDisplay: colLabMobile ? window.getComputedStyle(colLabMobile).display : ""
      };
    });
    expect(at627.metaDesktopDisplay).toBe("inline");
    expect(at627.metaMobileDisplay).toBe("none");
    expect(at627.colLabDesktopDisplay).toBe("inline");
    expect(at627.colLabMobileDisplay).toBe("none");

    // At 400px (<= 480px), both header and columns switch to mobile (billions)
    await page.setViewportSize({ width: 400, height: 900 });
    const at400 = await page.evaluate(() => {
      const meta = document.querySelector("#tab-kt .months")?.closest("section")?.querySelector(".block-head .meta");
      const desktopSpan = meta ? meta.querySelector(".desktop") : null;
      const mobileSpan = meta ? meta.querySelector(".mobile") : null;
      const colLabDesktop = document.querySelector("#tab-kt .months .col .lab .desktop");
      const colLabMobile = document.querySelector("#tab-kt .months .col .lab .mobile");
      return {
        metaDesktopDisplay: desktopSpan ? window.getComputedStyle(desktopSpan).display : "",
        metaMobileDisplay: mobileSpan ? window.getComputedStyle(mobileSpan).display : "",
        colLabDesktopDisplay: colLabDesktop ? window.getComputedStyle(colLabDesktop).display : "",
        colLabMobileDisplay: colLabMobile ? window.getComputedStyle(colLabMobile).display : ""
      };
    });
    expect(at400.metaDesktopDisplay).toBe("none");
    expect(at400.metaMobileDisplay).toBe("inline");
    expect(at400.colLabDesktopDisplay).toBe("none");
    expect(at400.colLabMobileDisplay).toBe("inline");

    await page.close();
  }, 20_000);
  it("loads main pult tab: no console errors with outcomeMismatches, renders collapsed error list and valid deal URL", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(pathToFileURL(indexPath).href);
    await page.waitForTimeout(400);

    // Scroll down to reveal all sections
    await page.evaluate(async () => {
      for (let y = 0; y <= document.body.scrollHeight; y += 250) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    await page.waitForTimeout(600);

    // 1. Zero console errors
    expect(consoleErrors).toEqual([]);

    // Д4а: список по умолчанию свёрнут; прежние строки доступны после раскрытия.
    await page.locator('.outcome-mismatches > summary').click();
    // 2. Error list preserves the deal title and ddmm date
    const boxText = await page.evaluate(() => {
      const el = document.querySelector(".outcome-mismatches");
      return el ? el.textContent : "";
    });
    expect(boxText).toContain("Ошибка в CRM: 1 сделка выиграна на портале, но закрыта как проигрыш");
    expect(boxText).toContain("Школа №72");
    expect(boxText).toContain("от 29.09");

    // 3. Link has valid single-https URL
    const linkHref = await page.evaluate(() => {
      const a = document.querySelector(".outcome-mismatches a") as HTMLAnchorElement | null;
      return a ? a.href : "";
    });
    expect(linkHref).toBe("https://ft3.bitrix24.kz/crm/deal/details/45477/");
    expect(linkHref).not.toContain("https://https://");

    // 4. Mobile layout check (phone 375px): sum and date wrap below title, no horizontal overflow
    await page.setViewportSize({ width: 375, height: 667 });
    const mobileRow = await page.evaluate(() => {
      const row = document.querySelector(".mismatch-row") as HTMLElement | null;
      const info = row?.querySelector(".info") as HTMLElement | null;
      const meta = row?.querySelector(".meta") as HTMLElement | null;
      const box = document.querySelector(".outcome-mismatches") as HTMLElement | null;
      if (!row || !info || !meta || !box) return null;
      const rowRect = row.getBoundingClientRect();
      const infoRect = info.getBoundingClientRect();
      const metaRect = meta.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      return {
        flexDirection: window.getComputedStyle(row).flexDirection,
        metaBelowInfo: metaRect.top >= infoRect.bottom - 2,
        rowFitsInBox: rowRect.right <= boxRect.right + 2
      };
    });
    expect(mobileRow).not.toBeNull();
    expect(mobileRow!.flexDirection).toBe("column");
    expect(mobileRow!.metaBelowInfo).toBe(true);
    expect(mobileRow!.rowFitsInBox).toBe(true);
  }, 20_000);

  it("renders collapsed 30+ days list in manager card, expands on click, hides in TV mode, and shows task badges", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(pathToFileURL(indexPath).href);
    await page.waitForTimeout(300);

    await page.evaluate(() => (document.querySelector(".trow.body") as HTMLElement)?.click());
    await page.waitForTimeout(100);

    const detailsInfo = await page.evaluate(() => {
      const det = document.querySelector("details.old-tasks") as HTMLDetailsElement | null;
      if (!det) return null;
      const sum = det.querySelector("summary.old-tasks-sum");
      const items = [...det.querySelectorAll(".old-task-item")];
      return {
        open: det.open,
        summaryText: sum?.textContent || "",
        itemCount: items.length,
        firstItemText: items[0]?.textContent || "",
        firstItemHref: (items[0]?.querySelector("a") as HTMLAnchorElement | null)?.href || ""
      };
    });
    expect(detailsInfo).not.toBeNull();
    expect(detailsInfo!.open).toBe(false);
    expect(detailsInfo!.summaryText).toContain("30+ дней (2)");
    expect(detailsInfo!.itemCount).toBe(2);
    expect(detailsInfo!.firstItemText).toContain("Тестовая школа №101");
    expect(detailsInfo!.firstItemText.replace(/\u00a0/g, " ")).toContain("42 дня");
    expect(detailsInfo!.firstItemHref).toBe("https://ft3.bitrix24.kz/crm/deal/details/900501/");

    await page.evaluate(() => (document.querySelector("details.old-tasks > summary.old-tasks-sum") as HTMLElement)?.click());
    const isOpenAfterClick = await page.evaluate(() => {
      const det = document.querySelector("details.old-tasks") as HTMLDetailsElement | null;
      return det ? det.open : false;
    });
    expect(isOpenAfterClick).toBe(true);

    const badgesText = await page.evaluate(() => {
      const warnTags = [...document.querySelectorAll(".task .kick .tag.warn")].map((el) => el.textContent);
      const goodTags = [...document.querySelectorAll(".task .kick .tag.good")].map((el) => el.textContent);
      return { warnTags, goodTags };
    });
    expect(badgesText.warnTags).toContain("план на сентябрь прошёл");
    expect(badgesText.goodTags).toContain("связался — закрыть дело / поставить следующий шаг");

    await page.evaluate(() => document.body.classList.add("tv"));
    const tvDisplay = await page.evaluate(() => {
      const det = document.querySelector("details.old-tasks");
      return det ? window.getComputedStyle(det).display : "";
    });
    expect(tvDisplay).toBe("none");
    expect(consoleErrors).toEqual([]);
    await page.close();
  }, 20_000);
});

// Все данные и снимки этого сценария — выдуманные.
describe('OP contracts in the pult browser', () => {
  it('shows OP hero, monthly departments, preliminary daily source and closed OP month', async () => {
    const { fixture } = await import('../fixtures/sales-pult/contracts.js');
    const { attachRegisterContracts } = await import('../../src/bitrix/salesPult/contracts.js');
    const { buildRegisterMonthSummary } = await import('../../src/bitrix/salesPult/register/history.js');
    const f=fixture(); f.payload.asOfDate='2026-10-29';
    attachRegisterContracts(f.payload,f.register,f.deals,f.aliases);
    const closed=structuredClone(f.payload); closed.closedMonth=true; closed.asOfDate='2026-09-30';
    const summary=buildRegisterMonthSummary({month:'2026-09',fileName:'ОП итог тест.xlsx',rows:f.rows.map(r=>({...r,date:'2026-09-23'})),plans:{Алия:3000}});
    attachRegisterContracts(closed,{error:'current unavailable',history:{asOf:'2026-10-29',months:[summary]}},new Map(),f.aliases);
    f.payload.closedMonths={'2026-09':closed};
    const browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1100}, reducedMotion:'reduce'});
    const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
    const screenshotDir=path.resolve('exports/pult-contracts-fixture'); fs.mkdirSync(screenshotDir,{recursive:true});
    try {
      await page.setContent(renderPultHtml(f.payload));
      await page.locator('.month-more > summary').click();
      await page.waitForFunction(()=>document.querySelector('#month .big')?.textContent==='3');
      expect(await page.locator('#month').innerText()).toContain('600 ₸');
      expect((await page.locator('#month .awaiting-register').innerText()).replace(/\s+/g,' ')).toContain('ещё 1 сделка');
      expect(await page.locator('#sales').innerText()).toContain('по Битриксу, предварительно');
      expect(await page.locator('#tenders').innerText()).toContain('по Битриксу, предварительно');
      await page.locator('#month').screenshot({path:path.join(screenshotDir,'current-month.png')});
      await page.locator('[data-p="month"]').click();
      expect(await page.locator('#sales').innerText()).toContain('по реестру ОП');
      expect(await page.locator('#tenders').innerText()).toContain('по реестру ОП');
      expect(await page.locator('#tenders .num').first().innerText()).toContain('1');
      await page.locator('#tenders').screenshot({path:path.join(screenshotDir,'tenders-month.png')});
      expect(await page.locator('#signals').innerText()).toContain('Сумма сделки 0');
      expect(await page.locator('#signals').innerText()).toContain('договор у другого поставщика');
      expect(await page.locator('#signals').innerText()).not.toContain('Закрыто в Битриксе, нет в ОП');
      await page.locator('#signals').screenshot({path:path.join(screenshotDir,'signals.png')});
      await page.locator('#monthSelect').selectOption('2026-09');
      await page.locator('.month-more > summary').click();
      expect(await page.locator('#month').innerText()).toContain('ОП итог тест.xlsx');
      expect(await page.locator('#sales').innerText()).toContain('по реестру ОП');
      expect(await page.locator('#month .awaiting-register').count()).toBe(0);
      await page.locator('#month').screenshot({path:path.join(screenshotDir,'closed-month.png')});
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });

  it('shows a clean amount line when monthly contracts fall back to Bitrix', async () => {
    const { fixture } = await import('../fixtures/sales-pult/contracts.js');
    const { attachRegisterContracts } = await import('../../src/bitrix/salesPult/contracts.js');
    const f=fixture(); attachRegisterContracts(f.payload,{error:'unavailable'},f.deals,f.aliases);
    const browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1100}, reducedMotion:'reduce'});
    try {
      await page.setContent(renderPultHtml(f.payload));
      await page.locator('.month-more > summary').click();
      const amount=(await page.locator('#month .hero-amt').innerText()).replace(/\s+/g,' ');
      expect(amount).not.toMatch(/·\s*·/);
      expect(amount).not.toContain('без НДС');
      expect(amount).toContain('плана договоров');
    } finally { await browser.close(); }
  });
});
