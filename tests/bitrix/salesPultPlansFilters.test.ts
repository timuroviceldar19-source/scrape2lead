import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { normalizePlanDeal } from "../../src/bitrix/salesPult/plans/collect.js";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import { renderPultHtml, renderRegisterHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

const options = { asOfDate: "2026-11-06" };
function fixture() {
  return ["ИП", "КТ"].flatMap((group, g) => Array.from({ length: 1025 }, (_, i) => normalizePlanDeal({
    ID: String(g * 2000 + i + 1), CATEGORY_ID: 41, ORIGINATOR_ID: "scrape2lead-gz-plans",
    TITLE: `[GZ ${i + 1}] Тестовый товар`, DATE_CREATE: "2026-11-01", CLOSED: i === 1024 ? "Y" : "N",
    ASSIGNED_BY_ID: String(i === 1023 ? 9 : 7 + (i & 1)), UF_CRM_ENSTRU_NAME: group === "ИП" ? (i & 2 ? "Доска" : "Панель") : (i & 2 ? "Ноутбук" : "Компьютер"),
    UF_CRM_MONTH: i & 16 ? "2026-10" : "2026-11", UF_CRM_PLAN_STATUS: i & 4 ? "Опубликован" : "Утвержден",
    UF_CRM_6627AEBD4503E: i & 8 ? "Конкурс" : "Электронный магазин", UF_CRM_COUNT: (i % 17) + 1,
    OPPORTUNITY: (i + 1) * 12345, UF_CRM_6627AEBD72587: "Тестовая школа", UF_CRM_PLAN_LINK: "https://example.com/plan"
  }, { ...options, managerNames: new Map([["7", "Тестовый менеджер А"], ["8", "Тестовый менеджер Б"], ["9", "Тестовый менеджер В"]]) })!));
}
function payload() {
  const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
  p.plans = buildPlansMonitorView(fixture(), options);
  return p;
}
it("распознаёт обратный порядок слов мультимедийной системы без кода", () => {
  expect(normalizePlanDeal({ ID: "99", CATEGORY_ID: 9, ORIGINATOR_ID: "scrape2lead-gz-plans", UF_CRM_ENSTRU_NAME: "Система мультимедийная учебная" }, options)?.group).toBe("ИП");
});
it("хранит полный список открытых планов один раз на группу, без повторов в срезах", () => {
  const p = payload();
  const html = renderPultHtml(p);
  for (const group of [p.plans!.ip!, p.plans!.kt!]) {
    expect(group.openPlans).toHaveLength(1024);
    expect(group.openPlans.every(d => !["1025", "3025"].includes(d.id))).toBe(true);
    for (const slice of Object.values(group.monthViews)) expect(slice).not.toHaveProperty("openPlans");
    expect(group.openPlans[0]).toHaveProperty("managerId");
  }
  expect(html.match(/"openPlans":/g)).toHaveLength(2);
  expect(html).not.toContain("topOpenPlans");
  const reg = renderRegisterHtml({ asOfDate: p.asOfDate, generatedAt: p.generatedAt, register: {} as never });
  expect(reg).not.toContain('"openPlans":');
  expect(reg).not.toContain("data-plan-filter");
  if (process.env.PLANS_SCREENSHOTS_DIR) {
    fs.mkdirSync(process.env.PLANS_SCREENSHOTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PLANS_SCREENSHOTS_DIR, "page-size.json"), JSON.stringify({ bytes: Buffer.byteLength(html), gzip: gzipSync(html).length }));
  }
});

it.each([1440, 390])("месяц + четыре фильтра + сортировка, пагинация, пустой результат и ТВ на %s px", async width => {
  const p = payload();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plans-filters-"));
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, renderPultHtml(p));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("https://fonts.googleapis.com/**", r => r.abort());
  const shots = process.env.PLANS_SCREENSHOTS_DIR;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    for (const tab of ["plans-ip", "plans-kt"]) {
      await page.goto(pathToFileURL(file).href + `#${tab}`);
      const pane = page.locator(`#tab-${tab}`);
      const rows = pane.locator(".plans-table [data-plan-id]");
      await expect.poll(() => rows.count()).toBe(50);
      await pane.getByRole("button", { name: "Показать ещё" }).click();
      expect(await rows.count()).toBe(100);
      const group = tab === "plans-ip" ? p.plans!.ip! : p.plans!.kt!;
      const source = fixture().filter(d => d.group === group.group && d.isOpen);
      // На всех месяцах сортировка по месяцу должна менять порядок, а не только ID.
      for (const sort of ["month", "qty"] as const) {
        for (let click = 0; click < 2; click++) {
          await pane.locator(`[data-plan-sort="${sort}"]`).click();
          const direction = await pane.locator(`[data-plan-sort="${sort}"]`).getAttribute("data-direction");
          const expected = [...source].sort((a, b) => {
            const cmp = sort === "month" ? a.month.localeCompare(b.month) : a.qty - b.qty;
            return (direction === "asc" ? cmp : -cmp) || a.id.localeCompare(b.id, "ru", { numeric: true });
          });
          expect(await rows.evaluateAll(rs => rs.map(r => r.getAttribute("data-plan-id")))).toEqual(expected.slice(0, 50).map(d => d.id));
        }
      }
      for (const month of ["2026-10", "2026-11"]) {
        await page.locator(`#planMonths [data-month="${month}"]`).click();
        const summary = await pane.locator(".plans-summary").innerHTML();
        for (let bits = 0; bits < 16; bits++) {
          const filters = {
            managerId: String(7 + (bits & 1)), kind: bits & 2 ? (tab === "plans-ip" ? "Интерактивные и спец. доски" : "Ноутбуки") : (tab === "plans-ip" ? "Интерактивные панели" : "Компьютеры и системные блоки"),
            portalStatus: bits & 4 ? "Опубликован" : "Утвержден", method: bits & 8 ? "Конкурс" : "Электронный магазин"
          };
          for (const [key, value] of Object.entries(filters)) await pane.locator(`.plan-filters [data-plan-filter="${key}"][data-value="${value}"]`).click();
          const selected = source.filter(d => d.month === month && Object.entries(filters).every(([k, v]) => d[k as keyof typeof d] === v));
          for (const sort of ["sum", "month", "qty"] as const) {
            for (let click = 0; click < 2; click++) {
              await pane.locator(`[data-plan-sort="${sort}"]`).click();
              const direction = await pane.locator(`[data-plan-sort="${sort}"]`).getAttribute("data-direction");
              const expected = [...selected].sort((a, b) => {
                const cmp = sort === "month" ? a.month.localeCompare(b.month) : a[sort] - b[sort];
                return (direction === "asc" ? cmp : -cmp) || a.id.localeCompare(b.id, "ru", { numeric: true });
              });
              expect(await rows.evaluateAll(rs => rs.map(r => r.getAttribute("data-plan-id")))).toEqual(expected.slice(0, 50).map(d => d.id));
            }
          }
          expect(await pane.locator(".plans-summary").innerHTML()).toBe(summary);
          expect(await page.locator('#planMonths [aria-pressed="true"]').getAttribute("data-month")).toBe(month);
        }
      }
      const screenshot = async (selector: string, name: string) => {
        if (!shots) return;
        await page.locator(selector).evaluate(el => {
          const offset = (document.querySelector(".bar")?.getBoundingClientRect().height || 0) + (document.querySelector(".dateline")?.getBoundingClientRect().height || 0) + 16;
          window.scrollTo({ top: scrollY + el.getBoundingClientRect().top - offset, behavior: "instant" });
        });
        await page.screenshot({ path: path.join(shots, `${tab}-${width}-${name}.png`) });
      };
      await screenshot(`#tab-${tab} .plan-filters`, "filters");
      await screenshot(`#tab-${tab} .plans-open`, "table");
      // У этого менеджера есть план только в октябре, а выбран ноябрь.
      await pane.locator('.plan-filters [data-plan-filter="managerId"]').filter({ hasText: "Тестовый менеджер В" }).click();
      expect(await rows.count()).toBe(0);
      expect(await pane.locator(".plans-open").textContent()).toContain("Ничего не найдено");
      expect(await pane.getByRole("button", { name: "Показать ещё" }).count()).toBe(0);
      await screenshot(`#tab-${tab} .plans-open`, "empty");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await pane.locator(".plan-filters").evaluate(el => getComputedStyle(el).position)).toBe("static");
      await page.keyboard.press("t");
      expect(await page.locator("body").getAttribute("class")).toContain("tv");
      expect(await page.locator(".plan-filters:visible").count()).toBe(0);
      expect(await pane.isVisible()).toBe(false);
      expect(await page.locator('#tab-pult [data-plan-id]').count()).toBe(0);
      await page.keyboard.press("t");
    }
    for (const tab of ["pult", "ip", "kt"]) {
      await page.goto(pathToFileURL(file).href + `#${tab}`);
      expect(await page.locator(".plan-filters:visible").count()).toBe(0);
      expect(await page.locator(`#tab-${tab} [data-plan-id]`).count()).toBe(0);
    }
    // При ошибке сбора не оставляем старые фильтры от предыдущей группы.
    const errorFile = path.join(dir, "error.html");
    fs.writeFileSync(errorFile, renderPultHtml({ ...p, plans: { asOf: options.asOfDate, error: "Тестовая ошибка загрузки" } }));
    await page.goto(pathToFileURL(errorFile).href + "#plans-ip");
    expect(await page.locator(".plan-filters:visible").count()).toBe(0);
    expect(await page.locator("#tab-plans-ip").textContent()).toContain("Тестовая ошибка загрузки");
    expect(errors).toEqual([]);
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 180000);

it.each([1440, 390])("правки ревью: фильтры рядом, память сессии, пустая выдача и фокус на %s px", async width => {
  const p = payload();
  p.plans = buildPlansMonitorView(fixture().filter(d => Number(d.id) % 2000 <= 110), options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plans-review-"));
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, renderPultHtml(p));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.route("https://fonts.googleapis.com/**", r => r.abort());
  try {
    await page.goto(pathToFileURL(file).href + "#plans-ip");
    const pane = page.locator("#tab-plans-ip");
    const rows = pane.locator("[data-plan-id]");
    const more = pane.getByRole("button", { name: "Показать ещё" });
    await more.scrollIntoViewIfNeeded();
    const beforeMore = await page.evaluate(() => scrollY);
    await more.click();
    expect(await page.evaluate(() => scrollY)).toBe(beforeMore);
    expect(await rows.nth(50).locator("a").first().evaluate(el => el === document.activeElement)).toBe(true);
    expect(await rows.nth(50).evaluate(el => el.getBoundingClientRect().top < innerHeight && el.getBoundingClientRect().bottom > 0)).toBe(true);
    expect(await rows.count()).toBe(100);
    await more.click();
    expect(await rows.count()).toBe(110);
    expect(await more.count()).toBe(0);
    expect(await rows.nth(100).locator("a").first().evaluate(el => el === document.activeElement)).toBe(true);
    expect(await rows.first().locator('[role="cell"]').nth(2).textContent()).not.toMatch(/·/);

    await page.locator('#planMonths [data-month="2026-11"]').click();
    await pane.locator('[data-plan-filter="managerId"][data-value="7"]').click();
    const geometry = await pane.locator(".plans-table").evaluate(el => ({ top: el.getBoundingClientRect().top, height: innerHeight,
      stickyBottom: Math.max(document.querySelector(".bar")!.getBoundingClientRect().bottom, document.querySelector(".dateline")!.getBoundingClientRect().bottom) }));
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.stickyBottom);
    expect(geometry.top).toBeLessThan(geometry.height - 40);
    expect(await pane.locator(".plan-filters").evaluate(el => el.closest(".plans-open") !== null)).toBe(true);
    if (width === 390) {
      expect(await pane.locator(".plan-filters").evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(260);
      expect(await pane.locator(".plan-filter-group .chips").evaluateAll(es => es.every(el => getComputedStyle(el).flexWrap === "nowrap" && getComputedStyle(el).overflowX === "auto"))).toBe(true);
    }
    const selectedFilters = { managerId: "7", kind: "Интерактивные панели", portalStatus: "Утвержден", method: "Электронный магазин" };
    for (const [key, value] of Object.entries(selectedFilters)) await pane.locator(`[data-plan-filter="${key}"][data-value="${value}"]`).click();
    await pane.locator('[data-plan-sort="qty"]').click();
    await page.reload();
    expect(await page.locator('#planMonths [aria-pressed="true"]').getAttribute("data-month")).toBe("2026-11");
    expect(await pane.locator('[data-plan-filter="managerId"][data-value="7"]').getAttribute("aria-pressed")).toBe("true");
    expect(await pane.locator('[data-plan-sort="qty"]').getAttribute("data-direction")).toBe("desc");
    for (const [key, value] of Object.entries(selectedFilters)) expect(await pane.locator(`[data-plan-filter="${key}"][data-value="${value}"]`).getAttribute("aria-pressed")).toBe("true");
    await page.locator('.sections [data-t="plans-kt"]').click();
    expect(await page.locator('#tab-plans-kt [data-plan-filter="managerId"][data-value=""]').getAttribute("aria-pressed")).toBe("true");
    await page.locator('#tab-plans-kt [data-plan-filter="managerId"][data-value="8"]').click();
    await page.reload();
    expect(await page.locator('#tab-plans-kt [data-plan-filter="managerId"][data-value="8"]').getAttribute("aria-pressed")).toBe("true");
    await page.locator('.sections [data-t="plans-ip"]').click();
    expect(await pane.locator('[data-plan-filter="managerId"][data-value="7"]').getAttribute("aria-pressed")).toBe("true");

    for (const key of Object.keys(selectedFilters)) await pane.locator(`[data-plan-filter="${key}"][data-value=""]`).click();
    await page.locator('#planMonths [data-month="all"]').click();
    await more.click();
    await page.reload();
    expect(await rows.count()).toBe(50);
    await page.evaluate(() => sessionStorage.setItem("sales-pult:plans:plans-ip", JSON.stringify({ filters: { managerId: "missing", kind: "missing" }, sort: "bad", direction: "bad" })));
    await page.reload();
    expect(await pane.locator('[data-plan-filter="managerId"][data-value=""]').getAttribute("aria-pressed")).toBe("true");
    expect(await pane.locator('[data-plan-filter="kind"][data-value=""]').getAttribute("aria-pressed")).toBe("true");
    expect(await pane.locator('[data-plan-sort="sum"]').getAttribute("data-direction")).toBe("desc");

    // Сохраняем выбранный фильтр, но в выбранном месяце нет открытых планов.
    const emptyMonth = "2026-12";
    p.plans!.ip!.months.push({ m: emptyMonth, count: 0, sum: 0, activeSum: 0, wonSum: 0, newCount: 0 });
    fs.writeFileSync(file, renderPultHtml(p));
    await page.reload();
    await page.locator(`#planMonths [data-month="${emptyMonth}"]`).click();
    expect(await pane.locator('[role="status"]').textContent()).toBe("Открытых планов нет");
    await pane.locator('[data-plan-filter="managerId"][data-value="7"]').click();
    expect(await pane.locator('[role="status"]').textContent()).toContain("Ничего не найдено");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Повреждённое хранилище и запрет доступа не должны ломать таблицу.
    await page.evaluate(() => sessionStorage.setItem("sales-pult:plans:plans-ip", "{bad json"));
    await page.reload();
    expect(await pane.locator('[data-plan-filter="managerId"][data-value=""]').getAttribute("aria-pressed")).toBe("true");
    await page.addInitScript(() => Object.defineProperty(window, "sessionStorage", { get() { throw new Error("Storage disabled"); } }));
    await page.reload();
    await pane.locator('[data-plan-filter="managerId"][data-value="7"]').click();
    expect(await pane.locator('[data-plan-filter="managerId"][data-value="7"]').getAttribute("aria-pressed")).toBe("true");
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 60000);

it("13 месяцев на 390×664: таблица и выбранные кнопки видны после загрузки и смены месяца", async () => {
  const months = ["2025-12", ...Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)];
  const p = payload();
  p.plans = buildPlansMonitorView(fixture().map((d, i) => ({ ...d, month: months[i % 13], managerId: String(7 + i % 24), managerName: `Тестовый менеджер ${String(i % 24 + 1).padStart(2, "0")}` })), options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plans-month-strip-"));
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, renderPultHtml(p));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 664 } });
  await page.route("https://fonts.googleapis.com/**", r => r.abort());
  try {
    await page.goto(pathToFileURL(file).href + "#plans-ip/2026-10");
    const pane = page.locator("#tab-plans-ip");
    expect(await page.locator("#planMonths button").count()).toBe(14);
    expect(await pane.locator(".plan-filters").getAttribute("role")).toBe("group");
    await pane.locator('[data-plan-filter="managerId"][data-value="30"]').click();
    const bounds = await pane.locator(".plans-table").evaluate(el => ({ top: el.getBoundingClientRect().top, stickyBottom: document.querySelector(".dateline")!.getBoundingClientRect().bottom }));
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.stickyBottom);
    expect(bounds.top).toBeLessThan(624);
    expect(await page.locator("#planMonths").evaluate(el => getComputedStyle(el).flexWrap)).toBe("nowrap");
    expect(await page.locator("#planMonths").evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(50);
    const buttonVisible = async (selector: string) => page.locator(selector).evaluate(el => {
      const b = el.getBoundingClientRect(), row = el.parentElement!.getBoundingClientRect();
      return b.left >= row.left - 1 && b.right <= row.right + 1;
    });
    await page.reload();
    expect(await pane.locator('[data-plan-filter="managerId"][data-value="30"]').getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator('#planMonths [data-month="2026-10"]').getAttribute("aria-pressed")).toBe("true");
    expect(await buttonVisible('#tab-plans-ip [data-plan-filter="managerId"][data-value="30"]')).toBe(true);
    expect(await buttonVisible('#planMonths [data-month="2026-10"]')).toBe(true);
    await page.locator('#planMonths [data-month="2026-01"]').click();
    expect(await buttonVisible('#tab-plans-ip [data-plan-filter="managerId"][data-value="30"]')).toBe(true);
    expect(await buttonVisible('#planMonths [aria-pressed="true"]')).toBe(true);
    await page.locator('#planMonths [data-month="2026-10"]').click();
    expect(await buttonVisible('#tab-plans-ip [data-plan-filter="managerId"][data-value="30"]')).toBe(true);
    expect(await buttonVisible('#planMonths [aria-pressed="true"]')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const shots = process.env.PLANS_SCREENSHOTS_DIR;
    if (shots) {
      await pane.locator('[data-plan-filter="managerId"][data-value="30"]').click();
      await page.screenshot({ path: path.join(shots, "months-13-390x664.png") });
    }
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 60000);
