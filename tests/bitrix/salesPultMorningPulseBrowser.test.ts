import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { financeWorkbook } from "../fixtures/sales-pult/financeWorkbook.js";
import { parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import { buildMorningPulse, type PulseView } from "../../src/bitrix/salesPult/pulse.js";
import { renderPultHtml } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import type { RadarCard, RadarView } from "../../src/bitrix/salesPult/radar/types.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";

// Все данные выдуманные.
const kpis = { totalCount: 0, totalSum: 0, submitCount: 0, submitSum: 0, discussionCount: 0, discussionSum: 0, secondChanceCount: 0, secondChanceSum: 0, missedCount: 0, missedSum: 0 };
const lot = (id: string, endAt: string, sum: number): RadarCard => ({
  id, dealUrl: "https://example.invalid/crm/deal/details/1/", sourceType: "lot", lotNumber: `L-${id}`, title: "Лот выдуманный",
  itemName: "Панель выдуманная", qty: 1, sum, method: "ЗЦП", status: "Опубликован (прием заявок)", group: "ИП", kind: "Интерактивные панели",
  customerName: "Школа Тест", customerBin: "000000000001", managerId: "s", managerName: "Алия Тестовая", startAt: null, endAt,
  hoursLeft: 2, isToday: true, isWithin48h: true, column: "submitToday"
});
const radar: RadarView = {
  asOf: "2026-10-28",
  ip: { group: "ИП", kpis, submitToday: [lot("1", "2026-11-21 11:00", 12_000_000), lot("2", "2026-11-22 15:00", 64_000_000)], discussion: [], secondChance: [], missed: [] },
  kt: { group: "КТ", kpis, submitToday: [], discussion: [], secondChance: [], missed: [] }
};

function payload(pulse?: PulseView | null) {
  const f = fixture();
  f.payload.radar = radar;
  f.payload.outcomeMismatches = [{ id: "d9", title: "Сделка тест", amount: 1, managerId: "s", managerName: "Алия Тестовая", outcome: "lost:other" }];
  f.payload.pulse = pulse !== undefined ? pulse : buildMorningPulse({
    asOfDate: "2026-11-21", nowIso: "2026-11-21T04:00:00.000Z", radar, outcomeMismatchesCount: 1,
    finance: { report: parseFinanceWorkbook(financeWorkbook({ stockSheets: true })), snapshots: [] }
  });
  const closed: SalesPultPayload = JSON.parse(JSON.stringify({ ...f.payload, pulse: undefined, closedMonth: true, closedMonths: undefined, asOfDate: "2026-09-30" }));
  f.payload.closedMonths = { "2026-09": closed };
  return f;
}

describe("утренний пульс на главной", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  async function open(html: string, width: number, height = 900): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
    await page.clock.install();
    await page.setContent(html);
    return { page, errors };
  }

  for (const width of [375, 1440]) {
    it(`над «01» компактные строки со ссылками, без переполнения и ошибок, на ${width}`, async () => {
      const f = payload();
      const items = f.payload.pulse!.items;
      expect(items.length).toBeGreaterThanOrEqual(4);
      const { page, errors } = await open(renderPultHtml(f.payload), width);
      try {
        const pulse = page.locator("#pulse");
        expect(await pulse.isVisible()).toBe(true);
        expect(await page.locator("#tab-pult > section").first().getAttribute("id")).toBe("pulse");
        const labelledBy = await pulse.getAttribute("aria-labelledby");
        expect(await page.locator(`#${labelledBy}`).innerText()).toBe("Утренний пульс");
        const links = pulse.locator("a.pulse-link");
        expect(await links.count()).toBe(items.length);
        expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")))).toEqual(items.map((i) => i.href));
        expect(await pulse.locator(".pulse-row.pulse-red").count()).toBe(items.filter((i) => i.severity === "red").length);
        expect(await links.first().innerText()).toContain(items[0].title);
        expect(await links.first().getAttribute("aria-label")).toMatch(/^Срочно: /);
        expect(await pulse.locator(".pulse-missing").innerText()).toContain("Финансы: отчёт на 16.11");
        // Каждая строка — одна-две строки текста.
        const heights = await links.evaluateAll((as) => as.map((a) => {
          const cs = getComputedStyle(a);
          const line = parseFloat(getComputedStyle(a.querySelector(".pulse-title")!).lineHeight);
          return (a.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / line;
        }));
        // На 375 px заголовок и детали переносятся, а не режутся многоточием (суть пункта важнее высоты):
        // до двух строк на каждую часть. На компьютере — одна строка.
        for (const lines of heights) expect(lines).toBeLessThanOrEqual(width === 375 ? 4.2 : 1.2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        // С клавиатуры: Tab идёт по строкам пульса.
        await links.first().focus();
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest("#pulse") !== null && document.activeElement !== document.querySelector("#pulse a"))).toBe(true);
        // Одним тапом — к списку лотов на «Радаре».
        await pulse.locator('a[href="#radar-ip"]').first().click();
        await expect.poll(() => page.locator("#tab-radar-ip").getAttribute("class")).toContain("on");
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }

  it("пусто — одна строка «Всё спокойно»; пульса нет — секции не видно", async () => {
    const calm = await open(renderPultHtml(payload({ asOf: "2026-10-28", items: [], missing: [] }).payload), 375);
    try {
      expect(await calm.page.locator("#pulse .pulse-row").count()).toBe(1);
      expect(await calm.page.locator("#pulse .pulse-row").innerText()).toBe("Всё спокойно");
      expect(await calm.page.locator("#pulse a").count()).toBe(0);
      expect(calm.errors).toEqual([]);
    } finally { await calm.page.close(); }
    const none = await open(renderPultHtml(payload(null).payload), 375);
    try {
      expect(await none.page.locator("#pulse").isVisible()).toBe(false);
      expect(none.errors).toEqual([]);
    } finally { await none.page.close(); }
  }, 30000);

  it("в закрытом месяце пульса нет, в текущем возвращается", async () => {
    const { page, errors } = await open(renderPultHtml(payload().payload), 1440);
    try {
      await page.locator("#monthSelect").selectOption("2026-09");
      expect(await page.locator("#pulse").isVisible()).toBe(false);
      await page.locator("#monthSelect").selectOption("2026-10");
      expect(await page.locator("#pulse").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it("в ТВ-режиме на 1920 пульс скрыт и в сцены не входит", async () => {
    const { page, errors } = await open(renderPultHtml(payload().payload), 1920, 1080);
    try {
      expect(await page.locator("#pulse").isVisible()).toBe(true);
      await page.keyboard.press("t");
      await expect.poll(() => page.locator("#scenes i").count()).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(await page.locator("#pulse").isVisible()).toBe(false);
        expect(await page.locator("#pulse").evaluate((el) => el.classList.contains("scene"))).toBe(false);
        await page.clock.fastForward(15_100);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.keyboard.press("t");
      expect(await page.locator("#pulse").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it("вид менеджера: без финансовых строк и ссылок на «Финансы»", async () => {
    const f = payload();
    const variant = buildManagerVariant({
      pult: f.payload, reg: { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, register: f.register },
      planDeals: null, managerId: "s", aliases: f.aliases
    })!;
    const { page, errors } = await open(renderManagerVariant(variant).index, 375);
    try {
      const text = await page.locator("#pulse").innerText();
      expect(text).toContain("Всё спокойно");
      expect(text).not.toMatch(/Кассовый|Долги|млн/);
      expect(await page.locator('#pulse a[href*="fin.html"]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});
