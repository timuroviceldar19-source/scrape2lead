import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { buildMarketGroupView } from "../../src/kz/market/aggregate.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import type { MarketUnit } from "../../src/kz/market/types.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

const cfg = loadMarketConfig();
const ourBin = typeof cfg.ourBins[0] === "string" ? cfg.ourBins[0] : cfg.ourBins[0].bin;
const months = ["2025-12", "2026-01", "2026-08", "2026-09", "2026-10", "2026-11"];
const units: MarketUnit[] = ["ИП", "КТ"].flatMap((group, gi) => months.flatMap((month, i) => [true, false].map((us, j) => ({
  id: gi * 1000 + i * 10 + j + 1, month, date: `${month}-${month === "2026-11" ? "02" : j ? "20" : "10"}`,
  group: group as "ИП" | "КТ", code: "test", kind: `Товар ${group} ${month}`, sum: (i + 1) * (j + 1) * 1e6,
  qty: (i + 1) * (j + 1), price: (i + 1) * (j + 1) * 100000,
  supplier: us ? ourBin : `competitor-${group}-${month}`, customer: `customer-${group}-${month}-${j}`,
  supplierName: us ? "F3" : `Поставщик ${group} ${month}`, customerName: `Заказчик ${group} ${month}-${j}`,
  method: `Канал ${group} ${month}`, us
}))));

function payload() {
  const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
  p.market = { asOf: "2026-11-03", ip: buildMarketGroupView("ИП", units, "2026-11-03", cfg), kt: buildMarketGroupView("КТ", units, "2026-11-03", cfg) };
  return p;
}

describe("месячные срезы рынка", () => {
  it.each(["ИП", "КТ"] as const)("строит независимые полные срезы %s без рекурсии и считает YTD до выбранного месяца", group => {
    const view = buildMarketGroupView(group, units, "2026-11-03", cfg);
    const views = JSON.parse(JSON.stringify(view)).monthViews;
    expect(Object.keys(views || {})).toEqual(months);
    expect(view.month).toBe("2026-10");
    for (const [i, month] of months.entries()) {
      const v = views[month];
      expect(v.total).toEqual({ sum: (i + 1) * 3e6, contracts: 2, qty: (i + 1) * 3, suppliers: 2, customers: 2 });
      expect(v.us.sum).toBe((i + 1) * 1e6);
      expect(v.us.share).toBeCloseTo(1 / 3);
      expect(v.us.rank).toBe(2);
      expect(v.suppliers[0].name).toBe(`Поставщик ${group} ${month}`);
      expect(v.suppliers[0].contractList[0].date).toContain(month);
      expect(v.methods[0].name).toBe(`Канал ${group} ${month}`);
      expect(v.kinds[0].kind).toBe(`Товар ${group} ${month}`);
      expect(v.kinds[0].med).toBe((i + 1) * 150000);
      expect(v.lost[0].customer).toBe(`Заказчик ${group} ${month}-1`);
      expect(v.customers[0].contractList[0].sum).toBe((i + 1) * 2e6);
      const ytd = months.slice(0, i + 1).reduce((s, m, n) => s + (m.slice(0, 4) === month.slice(0, 4) ? (n + 1) * 1e6 : 0), 0);
      expect(v.ytd.sum).toBe(ytd);
      expect(v.ytd.totalSum).toBe(ytd * 3);
      expect(v).not.toHaveProperty("months");
      expect(v).not.toHaveProperty("monthViews");
    }
    expect(views["2026-10"].prev).toEqual({ sum: 12000000, contracts: 2, toDay: "20" });
    expect(views["2026-11"].prev).toEqual({ sum: 0, contracts: 0, toDay: "02" });
  });
});

describe("переключатель месяцев рынка в браузере", () => {
  let browser: Browser;
  let dir: string;
  let url: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-months-"));
    fs.writeFileSync(path.join(dir, "index.html"), renderPultHtml(payload()));
    url = pathToFileURL(path.join(dir, "index.html")).href;
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => { await browser?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  async function open(hash: string, legacy = false) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("https://fonts.**/*", route => route.abort());
    if (legacy) {
      const p = payload();
      delete (p.market!.ip as any).monthViews;
      fs.writeFileSync(path.join(dir, "legacy.html"), renderPultHtml(p));
    }
    await page.goto((legacy ? pathToFileURL(path.join(dir, "legacy.html")).href : url) + hash);
    return { page, errors };
  }
  async function assertMonth(page: Page, tab: string, month: string) {
    const group = tab === "ip" ? "ИП" : "КТ";
    const pane = page.locator(`#tab-${tab}`);
    const n = months.indexOf(month) + 1;
    expect(await pane.locator("h2").first().textContent()).toContain(month.endsWith("01") ? "январь" : month.endsWith("09") ? "сентябрь" : "октябрь");
    expect(await pane.locator(".big").textContent()).toBe(String(n * 3));
    expect(await pane.locator(".share").textContent()).toContain(`Поставщик ${group} ${month}`);
    expect(await pane.locator(".meth").textContent()).toContain(`Канал ${group} ${month}`);
    expect(await pane.locator(".price").textContent()).toContain(`Товар ${group} ${month}`);
    expect(await pane.locator(".price .num").first().textContent()).toContain(new Intl.NumberFormat("ru-RU").format(n * 150000));
    expect(await pane.locator(".lost").textContent()).toContain(`Заказчик ${group} ${month}-1`);
    expect(await pane.locator(".cust.rows").textContent()).toContain(`Заказчик ${group} ${month}-1`);
    const ytd = months.slice(0, n).reduce((s, m, i) => s + (m.startsWith("2026") ? i + 1 : 0), 0);
    expect(await pane.locator(".ytd-box").textContent()).toContain(`${ytd},0 млн`);
    expect(await page.locator('#marketMonths [aria-pressed="true"]').getAttribute("data-month")).toBe(month);
    expect(await pane.locator('.months .col[aria-current="true"]').getAttribute("data-m")).toBe(month);
    expect(await pane.locator(".months .col").count()).toBe(months.length);
    expect(await pane.locator(".mlabels > span").count()).toBe(months.length);
  }

  it.each(["ip", "kt"])("переключает все блоки %s кнопкой, столбиком, подписью и hash", async tab => {
    const { page, errors } = await open(`#${tab}`);
    try {
      expect(await page.locator("#marketMonths button").count()).toBe(months.length);
      expect(await page.locator("#periodsNav").isVisible()).toBe(false);
      await assertMonth(page, tab, "2026-10");
      await page.locator('#marketMonths button[data-month="2026-09"]').click();
      await assertMonth(page, tab, "2026-09");
      expect(page.url()).toContain(`#${tab}/2026-09`);
      await page.locator(`#tab-${tab} .months .col[data-m="2026-01"]`).click();
      await assertMonth(page, tab, "2026-01");
      await page.locator(`#tab-${tab} .mlabels > span[data-m="2026-10"]`).click();
      await assertMonth(page, tab, "2026-10");
      await page.evaluate(tab => { location.hash = `#${tab}/2026-09`; }, tab);
      await page.waitForFunction(tab => document.querySelector(`#tab-${tab} h2`)?.textContent?.includes("сентябрь"), tab);
      await assertMonth(page, tab, "2026-09");
      expect(await page.locator(`#tab-${tab} .mlabels`).textContent()).not.toContain("окт · по");
      await page.locator('.sections [data-t="pult"]').click();
      expect(await page.locator("#marketMonths").isVisible()).toBe(false);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it("поддерживает прямые ссылки, возвращает месяц по умолчанию для невалидных hash и скрывает кнопки в ТВ", async () => {
    const { page, errors } = await open("#kt/2026-01");
    try {
      await assertMonth(page, "kt", "2026-01");
      for (const hash of ["#ip/constructor", "#kt/__proto__", "#ip/2026-13", "#kt/toString", "#kt/2099-01", "#ip"]) {
        await page.evaluate(hash => { location.hash = hash; }, hash);
        await page.waitForFunction(() => document.querySelector('#marketMonths [aria-pressed="true"]')?.getAttribute("data-month") === "2026-10");
        await assertMonth(page, hash.startsWith("#ip") ? "ip" : "kt", "2026-10");
      }
      await page.locator("#tvBtn").click();
      expect(await page.locator("#marketMonths").isVisible()).toBe(false);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it("открывает прямую ссылку ИП и безопасно показывает сводку старого кэша", async () => {
    const { page, errors } = await open("#ip/2026-09", true);
    try {
      expect(await page.locator("#tab-ip .big").textContent()).toBe("12");
      expect(await page.locator("#tab-ip").textContent()).toContain("после обновления кэша");
      expect(await page.locator("#tab-ip .share").textContent()).not.toContain("Поставщик ИП 2026-10");
      expect(await page.locator("#tab-ip .ytd-box").count()).toBe(0);
      expect(await page.locator("#tab-ip .months .col").count()).toBe(months.length);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});
