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
    expect(ytdCardText).toContain("С начала года");
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
  it("loads main pult tab: no console errors with outcomeMismatches, renders error box and valid deal URL", async () => {
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

    // 2. Mismatches box is rendered with deal title and ddmm date
    const boxText = await page.evaluate(() => {
      const el = document.querySelector(".mismatches-box");
      return el ? el.textContent : "";
    });
    expect(boxText).toContain("Ошибка в CRM: сделки выиграны на портале, но закрыты как проигрыш");
    expect(boxText).toContain("Школа №72");
    expect(boxText).toContain("от 29.09");

    // 3. Link has valid single-https URL
    const linkHref = await page.evaluate(() => {
      const a = document.querySelector(".mismatches-box a") as HTMLAnchorElement | null;
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
      const box = document.querySelector(".mismatches-box") as HTMLElement | null;
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

    await page.close();
  }, 20_000);

});
