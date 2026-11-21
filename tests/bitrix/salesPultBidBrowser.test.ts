import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { renderPultHtml } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { bidPayload } from "../fixtures/sales-pult/bid.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";

// Пункт 5 RFC в браузере: вердикт рисуется из payload, порядок «по ценности» на Радаре, роли all / manager / tv.
// Все данные выдуманные (tests/fixtures/sales-pult/bid.ts).

let browser: Browser;
let dir: string;
let fullFile: string;
let managerFile: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-bid-"));
  const { payload, planDeals } = bidPayload();
  fullFile = path.join(dir, "index.html");
  fs.writeFileSync(fullFile, renderPultHtml(payload));
  const reg = { asOfDate: payload.asOfDate, generatedAt: payload.generatedAt, register: fixture().register };
  managerFile = path.join(dir, "manager.html");
  fs.writeFileSync(managerFile, renderManagerVariant(buildManagerVariant({ pult: payload, reg, planDeals, managerId: "s" })!).index);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function open(file: string, suffix: string, width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // шрифты в тесте отключены: их отказ — не ошибка страницы
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)/.test(m.location().url)) errors.push(m.text()); });
  await page.goto(`${pathToFileURL(file).href}${suffix}`);
  await page.waitForTimeout(300);
  return { page, errors };
}

const submitIds = (page: Page) => page.locator('[data-col="submitToday"] .radar-card').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.dealId));

describe("вердикт на Радаре (all)", () => {
  for (const width of [375, 1440]) {
    it(`вердикт на карточке и порядок «по ценности»; ${width} px`, async () => {
      const { page, errors } = await open(fullFile, "#radar-ip", width);
      try {
        // логика подсказок больше не живёт в браузере
        expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).__buildWinHintsIndex)).toBe("undefined");
        const nogo = page.locator('.radar-card[data-deal-id="9101"] .bid-verdict');
        expect(await nogo.innerText()).toBe("не идём");
        expect(await nogo.getAttribute("class")).toContain("nogo");
        expect(await nogo.getAttribute("title")).toContain("Шаблон ТС: Шаблон-тест Соперника");
        expect(await page.locator('.radar-card[data-deal-id="9103"] .bid-verdict').innerText()).toBe("идём");
        expect(await page.locator('.radar-card[data-deal-id="9102"] .bid-verdict').innerText()).toBe("осторожно");
        expect(await page.locator('.radar-card[data-deal-id="9104"] .bid-verdict').count()).toBe(0);
        expect(await page.locator('.radar-card[data-deal-id="9106"]').innerText()).toContain("нас отклоняли: Несоответствие ТС · 2×");
        expect(await page.locator('.radar-card[data-deal-id="9103"] .win-price.good').innerText()).toMatch(/~120\s000\/шт · победы ~100\s000 · запас/);

        expect(await submitIds(page)).toEqual(["9101", "9102", "9103", "9104", "9105", "9106"]);
        const byDeadline = page.locator('#tab-radar-ip button[data-radar-order="deadline"]');
        const byValue = page.locator('#tab-radar-ip button[data-radar-order="value"]');
        expect(await byDeadline.getAttribute("aria-pressed")).toBe("true");
        await byValue.click();
        expect(await byValue.getAttribute("aria-pressed")).toBe("true");
        expect(await submitIds(page)).toEqual(["9103", "9105", "9102", "9104", "9106", "9101"]);
        // живые таймеры не пропали после пересортировки
        expect(await page.locator('[data-col="submitToday"] .radar-card[data-end] [data-radar-timer]').count()).toBe(6);
        // порядок переживает фильтр по сроку
        await page.locator('#tab-radar-ip button[data-radar-time="today"]').click();
        expect(await submitIds(page)).toEqual(["9102", "9101"]);
        await byDeadline.click();
        expect(await submitIds(page)).toEqual(["9101", "9102"]);

        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }

  it("вердикт читается: контраст текста плашек не ниже 4,5:1", async () => {
    const { page, errors } = await open(fullFile, "#radar-ip", 1440);
    try {
      const ratios = await page.evaluate(() => {
        const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        return [...document.querySelectorAll("#tab-radar-ip .bid-verdict")].map((el) => {
          let n: Element | null = el; let bg = "rgba(0, 0, 0, 0)";
          while (n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; }
          const a = lum(rgb(getComputedStyle(el).color)); const b = lum(rgb(bg));
          return { cls: el.className, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
      });
      expect(new Set(ratios.map((r) => r.cls))).toEqual(new Set(["bid-verdict go", "bid-verdict caution", "bid-verdict nogo"]));
      for (const r of ratios) expect(r.ratio, r.cls).toBeGreaterThanOrEqual(4.5);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});

describe("вердикт в «Планах» (all)", () => {
  it("открытый план: вердикт рядом с метками, «Риск ТС / конкурента» по причинам", async () => {
    const { page, errors } = await open(fullFile, "#plans-ip", 1440);
    try {
      const row = page.locator('[data-plan-id="9201"]');
      expect(await row.locator(".bid-verdict").innerText()).toBe("идём");
      expect(await row.innerText()).toContain("покупал у нас");
      const other = page.locator('[data-plan-id="9202"]');
      expect(await other.locator(".bid-verdict").innerText()).toBe("осторожно");
      expect(await other.locator(".win-price.bad").innerText()).toMatch(/~40\s000\/шт · победы ~100\s000 · низкая цена/);
      await page.locator('[data-plan-quick="risk"]').click();
      expect(await page.locator("[data-plan-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.planId))).toEqual(["9202"]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});

describe("изоляция ролей в браузере", () => {
  for (const width of [375, 1440]) {
    it(`manager: метки и цена из его данных, без вердикта и без порядка «по ценности»; ${width} px`, async () => {
      const { page, errors } = await open(managerFile, "#radar-ip", width);
      try {
        expect(await page.locator(".radar-card").count()).toBe(6);
        expect(await page.locator(".bid-verdict").count()).toBe(0);
        expect(await page.locator("button[data-radar-order]").count()).toBe(0);
        expect(await page.locator('.radar-card[data-deal-id="9102"]').innerText()).toContain("забирал ТОО Соперник-тест · 1× · −12%");
        expect(await page.locator('.radar-card[data-deal-id="9103"] .win-price').innerText()).toMatch(/победы ~100\s000/);
        const html = await page.content();
        for (const secret of ["Шаблон-тест", "нас отклоняли"]) expect(html).not.toContain(secret);
        await page.goto(`${pathToFileURL(managerFile).href}#plans-ip`);
        await page.waitForTimeout(200);
        expect(await page.locator("[data-plan-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.planId))).toEqual(["9201"]);
        expect(await page.locator(".bid-verdict").count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }

  it("tv (1920): Радар и «Планы» не открываются, вердиктов на экране нет", async () => {
    const { page, errors } = await open(fullFile, "?tv=1#radar-ip", 1920);
    try {
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      expect(await page.locator("#tab-radar-ip").isVisible()).toBe(false);
      expect(await page.locator(".bid-verdict:visible").count()).toBe(0);
      await page.evaluate(() => { location.hash = "#plans-ip"; });
      await page.waitForTimeout(200);
      expect(await page.locator(".bid-verdict:visible, .win-hints:visible").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});
