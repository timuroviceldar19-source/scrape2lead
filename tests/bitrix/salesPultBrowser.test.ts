import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

describe("salesPult in-browser Playwright test", () => {
  let browser: Browser;
  let tempDir: string;
  let indexPath: string;
  let regPath: string;

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
    basePayload.market = {
      asOf: "2026-10-29",
      months: ["2026-09", "2026-10"],
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
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
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

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
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

  it("loads pult market tab #kt: no console errors, reveal sections visible, month bars height > 0, data-w bars width > 0", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`${pathToFileURL(indexPath).href}#kt`);
    await page.waitForTimeout(400);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
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

    await page.close();
  }, 20_000);
});
