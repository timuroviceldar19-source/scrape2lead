import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { RADAR_PORTAL, radarMissedView } from "../fixtures/sales-pult/radarMissed.js";
import { renderPultHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";

// Все данные выдуманные: tests/fixtures/sales-pult/radarMissed.ts. Часы страницы стоят на 21.11.2026 09:49:30 (Алматы).
const CLOCK = new Date("2026-11-21T09:49:30+05:00");

let browser: Browser;
let dir: string;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-radar-live-"));
});
afterAll(async () => {
  await browser?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writePage(name: string, html: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

function samplePayloads() {
  const f = fixture();
  f.payload.portal = RADAR_PORTAL;
  f.payload.radar = radarMissedView();
  const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, portal: RADAR_PORTAL, register: f.register };
  return { pult: f.payload, reg };
}

async function openPage(width: number, opts: { clock?: boolean; me?: string } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  if (opts.clock) {
    await page.clock.install({ time: CLOCK });
    // Считаем минутные интервалы и снимаем автоперезагрузку раз в 15 минут: проверяем тиканье в одной загрузке страницы.
    await page.addInitScript(() => {
      type Timer = (fn: unknown, ms?: number, ...rest: unknown[]) => unknown;
      const w = window as unknown as { __minuteIntervals: number; setInterval: Timer; setTimeout: Timer };
      w.__minuteIntervals = 0;
      const si = w.setInterval.bind(window);
      const st = w.setTimeout.bind(window);
      w.setInterval = (fn, ms, ...rest) => {
        if (ms === 60_000) w.__minuteIntervals++;
        return si(fn, ms, ...rest);
      };
      w.setTimeout = (fn, ms, ...rest) => (ms === 15 * 60 * 1000 ? 0 : st(fn, ms, ...rest));
    });
  }
  if (opts.me !== undefined) {
    const me = opts.me;
    await page.addInitScript((id) => { try { localStorage.setItem("pult-me", id); } catch { /* нет хранилища */ } }, me);
  }
  return { page, errors };
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

describe("Радар: живые таймеры и пропущенные сроки", () => {
  for (const width of [1440, 375]) {
    it(`бейдж тикает раз в минуту без перерисовки и закрывается «приём окончен», на ${width}`, async () => {
      const { pult } = samplePayloads();
      const url = writePage(`live-${width}.html`, renderPultHtml(pult));
      const { page, errors } = await openPage(width, { clock: true });
      try {
        await page.goto(`${url}#radar-ip`);
        await page.evaluate(() => { (window as unknown as { __sameDocument: boolean }).__sameDocument = true; });
        const card = page.locator('#tab-radar-ip .radar-col[data-col="submitToday"] .radar-card[data-deal-id="8101"]');
        expect(await card.getAttribute("data-end")).toBe("2026-11-21 13:00");
        const badge = card.locator("[data-radar-timer]");
        expect(await badge.getAttribute("role")).toBe("timer");
        expect(await badge.innerText()).toBe("осталось 3 ч 10 мин");
        expect(await badge.getAttribute("class")).toContain("bad");

        // Поиск в фокусе: тиканье не должно сбивать ни текст, ни фокус.
        const search = page.locator("#tab-radar-ip .radar-search-input");
        await search.fill("Панель");
        await search.focus();
        const searchHandle = await search.elementHandle();
        const cardHandle = await card.elementHandle();

        await page.clock.fastForward(60_000);
        expect(await badge.innerText()).toBe("осталось 3 ч 9 мин");

        await page.clock.fastForward("03:12:00");
        expect(await badge.innerText()).toBe("приём окончен");
        expect(await badge.getAttribute("class")).toContain("bad");
        // Карточка не прыгнула: та же колонка, тот же узел DOM; поиск тот же и в фокусе; перезагрузки не было.
        expect(await card.count()).toBe(1);
        expect(await card.evaluate((el, prev) => el === prev, cardHandle)).toBe(true);
        expect(await search.evaluate((el, prev) => el === prev && document.activeElement === el, searchHandle)).toBe(true);
        expect(await search.inputValue()).toBe("Панель");
        expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);

        // Повторные рендеры вкладки не плодят интервалы.
        for (const product of ["kt", "ip", "kt", "ip"]) await page.locator(`#productSwitch button[data-product="${product}"]`).click();
        await page.locator('.sections a[data-t="pult"]').click();
        await page.locator('.sections a[data-t="radar"]').click();
        expect(await page.evaluate(() => (window as unknown as { __minuteIntervals: number }).__minuteIntervals)).toBe(1);
        expect(await noOverflow(page)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);

    it(`плитка и список «Пропущенные сроки за 7 дней» раскрываются с клавиатуры, на ${width}`, async () => {
      const { pult } = samplePayloads();
      const url = writePage(`missed-${width}.html`, renderPultHtml(pult));
      const { page, errors } = await openPage(width, { clock: true });
      try {
        await page.goto(`${url}#radar-ip`);
        const tab = page.locator("#tab-radar-ip");
        const tile = tab.locator('[data-radar-counter="missed"]');
        expect(await tile.textContent()).toContain("Пропущенные сроки");
        expect(await tile.innerText()).toMatch(/3\s+лота/);
        expect(await tile.innerText()).toContain("13,0 млн ₸");
        expect(await tile.getAttribute("class")).toContain("is-bad");

        const details = tab.locator("details.radar-missed");
        const summary = details.locator("summary");
        expect(await details.evaluate((d: HTMLDetailsElement) => d.open)).toBe(false);
        expect(await summary.innerText()).toContain("Пропущенные сроки за 7 дней");
        expect(await summary.innerText()).toMatch(/3\s+лота · 13,0 млн ₸/);
        await summary.focus();
        expect(await summary.evaluate((el) => document.activeElement === el)).toBe(true);
        await page.keyboard.press("Enter");
        expect(await details.evaluate((d: HTMLDetailsElement) => d.open)).toBe(true);

        const rows = details.locator(".radar-missed-row");
        expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-deal-id")))).toEqual(["8108", "8103", "8104"]);
        const first = await rows.first().innerText();
        expect(first).toContain("Панель Чужая-дорогая");
        expect(first).toContain("Школа-пример 8108");
        expect(first).toContain("6,0 млн ₸");
        expect(first).toContain("приём закрыт 20.11 18:00");
        expect(first).toContain("Борис Тестовый");
        expect(await rows.first().locator('a[href$="/crm/deal/details/8108/"]').count()).toBe(1);
        expect(await rows.first().locator('a[href*="/registry/lots/8108"]').count()).toBe(1);
        expect(await rows.first().locator("a").first().getAttribute("rel")).toBe("noopener");
        // Пропущенные не карточки активных колонок.
        expect(await tab.locator('.radar-card[data-deal-id="8108"]').count()).toBe(0);
        expect(await noOverflow(page)).toBe(true);

        // Фильтр по менеджеру: список и плитка пересчитаны, раскрытый список остаётся раскрытым.
        await tab.locator('button[data-radar-mgr="s"]').click();
        expect(await details.evaluate((d: HTMLDetailsElement) => d.open)).toBe(true);
        expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-deal-id")))).toEqual(["8103"]);
        expect(await tile.innerText()).toContain("2,0 млн ₸");
        // Поиск по заказчику тоже режет список.
        await tab.locator(".radar-search-input").fill("ничего-такого-нет");
        expect(await rows.count()).toBe(0);
        await tab.locator(".radar-search-input").fill("");

        // КТ: свой список.
        await page.locator('#productSwitch button[data-product="kt"]').click();
        const kt = page.locator("#tab-radar-kt");
        await kt.locator("details.radar-missed summary").focus();
        await page.keyboard.press("Space");
        expect(await kt.locator(".radar-missed-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-deal-id")))).toEqual(["8110"]);
        expect(await kt.locator(".radar-missed-row").innerText()).toContain("приём закрыт 21.11 09:00");
        expect(await noOverflow(page)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);

    it(`менеджер видит свой «Радар» без чипов команды, «Финансов» и «Конкурентов», на ${width}`, async () => {
      const { pult, reg } = samplePayloads();
      const variant = buildManagerVariant({ pult, reg, planDeals: [], managerId: "s" })!;
      const pages = renderManagerVariant(variant);
      const url = writePage(`manager-${width}.html`, pages.index);
      const regUrl = writePage(`manager-reg-${width}.html`, pages.reg);
      const { page, errors } = await openPage(width, { clock: true, me: "t" });
      try {
        await page.goto(`${url}#radar-ip`);
        expect(await page.locator('.sections a[data-t="radar"]').count()).toBe(1);
        expect(await page.locator('.sections a[data-t="competitors"]').count()).toBe(0);
        expect(await page.locator('.sections a[href="./fin.html"]').count()).toBe(0);
        expect(await page.evaluate(() => (0, eval)("PAYLOAD.competitors"))).toBeNull();

        const tab = page.locator("#tab-radar-ip");
        expect(await tab.getAttribute("class")).toContain("on");
        expect(await tab.locator(".radar-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-deal-id")))).toEqual(["8101"]);
        expect(await tab.locator(".radar-card [data-radar-timer]").innerText()).toBe("осталось 3 ч 10 мин");
        // Чипы «Менеджер» не нужны: в радаре только он сам.
        expect(await tab.locator("button[data-radar-mgr]").count()).toBe(0);
        expect(await tab.innerText()).not.toContain("Вся команда");

        await tab.locator("details.radar-missed summary").focus();
        await page.keyboard.press("Enter");
        expect(await tab.locator(".radar-missed-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-deal-id")))).toEqual(["8103"]);
        const body = await page.locator("body").innerText();
        for (const other of ["Борис", "Чужая", "8102", "8104", "8108"]) expect(body, other).not.toContain(other);
        expect(await noOverflow(page)).toBe(true);

        await page.locator('#productSwitch button[data-product="kt"]').click();
        expect(await page.locator("#tab-radar-kt .radar-missed summary").innerText()).toMatch(/1\s+лот · 2,5 млн ₸/);
        expect(await noOverflow(page)).toBe(true);

        // «Выручка» менеджера ведёт на его «Радар», «Финансов» и «Конкурентов» нет.
        await page.goto(regUrl);
        expect(await page.locator('a[href="./#radar-ip"]').count()).toBe(1);
        expect(await page.locator('a[href="./fin.html"]').count()).toBe(0);
        expect(await page.locator('a[href="./#competitors-ip"]').count()).toBe(0);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }
});
