// Склад 1С на карточках Радара, в открытых планах и спрос на «Финансах»; вид менеджера без утечек.
// Все данные выдуманные: tests/fixtures/sales-pult/stock.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { renderFinanceHtml, renderPultHtml, type RegisterPagePayload, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import { buildStockAvailability, buildStockDemand, withStockHints } from "../../src/bitrix/salesPult/stock/availability.js";
import {
  STOCK_COMPANIES, STOCK_SUMS, STOCK_WAREHOUSES, stockFinance, stockPlanDeals, stockRadar
} from "../fixtures/sales-pult/stock.js";

const AS_OF = "2026-11-21";
const plans = () => buildPlansMonitorView(stockPlanDeals(), { asOfDate: AS_OF });

function pultPayload(stock: "fresh" | "stale" | "none" = "fresh"): SalesPultPayload {
  const f = fixture();
  const radar = stockRadar();
  const plansView = plans();
  const av = buildStockAvailability(stockFinance(stock === "stale" ? "2026-11-15" : "2026-11-20"), AS_OF)!;
  return { ...f.payload, radar, plans: plansView, ...(stock === "none" ? {} : { stock: withStockHints(av, radar, plansView) }) };
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

function writePage(html: string, name = "index.html"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-stock-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

async function openPage(width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  // Шрифты без сети: пустой ответ вместо обрыва, чтобы в консоли не было ошибок загрузки.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  return { page, errors };
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
/** Видимый текст тега: первый текстовый узел (пояснение для экранного диктора — отдельным скрытым span). */
const tagText = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el.childNodes[0]?.textContent ?? "");

async function gotoTab(page: Page, url: string, tab: string) {
  await page.goto(`${url}#${tab}`);
  await page.locator(`#tab-${tab}.on`).waitFor();
}

describe("склад на карточках Радара и в открытых планах", () => {
  for (const width of [375, 1440]) {
    it(`теги склада: точный, частичный, по виду; ТВ их прячет; на ${width}`, async () => {
      const url = writePage(renderPultHtml(pultPayload()));
      const { page, errors } = await openPage(width);
      try {
        await gotoTab(page, url, "radar-ip");
        const card = (id: string) => `#tab-radar-ip .radar-card[data-deal-id="${id}"] .stock-tag`;
        await page.locator(card("5101")).waitFor();
        expect(await tagText(page, card("5101"))).toBe("склад: 69 шт · 75″");
        expect(await page.locator(card("5101")).getAttribute("class")).toBe("tag stock-tag good");
        expect(await page.locator(`${card("5101")} .stock-sr`).textContent()).toContain("хватает");
        expect(await tagText(page, card("5102"))).toBe("склад: 10 шт · 86″");
        expect(await page.locator(card("5102")).getAttribute("class")).toBe("tag stock-tag warn");
        expect(await page.locator(`${card("5102")} .stock-sr`).textContent()).toContain("20");
        expect(await tagText(page, card("5103"))).toBe("склад: 83 шт · ≈ по виду");
        expect(await page.locator(card("5103")).getAttribute("class")).toBe("tag stock-tag approx");
        expect(await page.locator(card("5104")).count()).toBe(0);
        expect(await page.locator("#tab-radar-ip .stock-tag").count()).toBe(4);
        // Тег — подпись, не элемент управления: в порядок Tab не попадает.
        expect(await page.locator(card("5101")).evaluate((el) => el.tabIndex)).toBe(-1);
        expect(await page.locator(card("5101")).getAttribute("title")).toContain("без цен");
        expect(await page.locator(card("5101")).isVisible()).toBe(true);
        expect(await noOverflow(page)).toBe(true);

        await page.evaluate(() => document.body.classList.add("tv"));
        expect(await page.locator(card("5101")).evaluate((el) => getComputedStyle(el).display)).toBe("none");
        await page.evaluate(() => document.body.classList.remove("tv"));

        await gotoTab(page, url, "radar-kt");
        expect(await tagText(page, '#tab-radar-kt .radar-card[data-deal-id="5106"] .stock-tag')).toBe("склад: 30 шт · ≈ по виду");
        expect(await tagText(page, '#tab-radar-kt .radar-card[data-deal-id="5107"] .stock-tag')).toBe("склад: 25 шт · ≈ по виду");
        expect(await noOverflow(page)).toBe(true);

        await gotoTab(page, url, "plans-ip");
        const row = (id: string) => `#tab-plans-ip .plans-table [data-plan-id="${id}"] .stock-tag`;
        await page.locator(row("6101")).waitFor();
        expect(await tagText(page, row("6101"))).toBe("склад: 69 шт · 75″");
        expect(await page.locator(row("6101")).getAttribute("class")).toBe("tag stock-tag good");
        expect(await page.locator(row("6102")).count()).toBe(1);
        expect(await noOverflow(page)).toBe(true);
        await gotoTab(page, url, "plans-kt");
        expect(await page.locator('#tab-plans-kt .plans-table [data-plan-id="6103"]').count()).toBe(1);
        expect(await page.locator("#tab-plans-kt .stock-tag").count()).toBe(0);
        expect(await noOverflow(page)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }

  it("устаревший отчёт — пометка «на dd.mm»; без склада теги не рисуются", async () => {
    const { page, errors } = await openPage(1440);
    try {
      const stale = writePage(renderPultHtml(pultPayload("stale")));
      await gotoTab(page, stale, "radar-ip");
      const tag = '#tab-radar-ip .radar-card[data-deal-id="5101"] .stock-tag';
      await page.locator(tag).waitFor();
      expect(await tagText(page, tag)).toBe("склад: 69 шт · 75″ · на 15.11");

      const none = writePage(renderPultHtml(pultPayload("none")));
      await gotoTab(page, none, "radar-ip");
      await page.locator('#tab-radar-ip .radar-card[data-deal-id="5101"]').waitFor();
      expect(await page.locator(".stock-tag").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __stockHint: (x: unknown) => string }).__stockHint({ id: "5101", qty: 1 }))).toBe("");
      await gotoTab(page, none, "plans-ip");
      await page.locator('#tab-plans-ip [data-plan-id="6101"]').waitFor();
      expect(await page.locator(".stock-tag").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});

describe("спрос на «Финансах»", () => {
  const radar = stockRadar();
  const av = buildStockAvailability(stockFinance(), AS_OF);
  const finHtml = (withDemand = true) => renderFinanceHtml({
    asOfDate: AS_OF, generatedAt: "", finance: stockFinance(),
    ...(withDemand ? { stockDemand: buildStockDemand(av, radar, plans()) } : {})
  });

  for (const width of [375, 1440]) {
    it(`у позиций без расхода — строка спроса, она же в тексте для ОП; на ${width}`, async () => {
      const { page, errors } = await openPage(width);
      try {
        await page.goto(writePage(finHtml(), "fin.html"));
        await page.evaluate(() => {
          Object.defineProperty(navigator, "clipboard", {
            value: { writeText: async (value: string) => { document.body.dataset.clipboard = value; } }
          });
        });
        const items = page.locator('#stockFocus ol[aria-label="Топ-5 позиций без расхода"] > li');
        expect(await items.count()).toBe(5);
        const demand = (i: number) => items.nth(i).locator(".fin-stock-demand");
        expect(await demand(0).innerText()).toBe("спрос: 3 лота на 24 шт · из них 1 без диагонали в названии");
        expect(await demand(1).innerText()).toBe("спрос: 2 лота на 26 шт · из них 1 без диагонали в названии");
        expect(await demand(2).innerText()).toBe("спрос: 1 лот на 30 шт");
        expect(await demand(3).count()).toBe(0);
        expect(await demand(4).count()).toBe(0);
        expect(await demand(0).getAttribute("title")).toContain("Радара");
        // С клавиатуры: фокус на кнопку копирования и Enter.
        await page.locator('[data-fin-copy="stock"]').focus();
        await page.keyboard.press("Enter");
        const copied = (await page.locator("body").getAttribute("data-clipboard"))!.replace(/\s/g, " ");
        expect(copied).toContain("Интерактивная панель Образец 75″ · ТОО «Склад-Тест Север» · Склад Образцовый · 40 · 12 345 678 ₸ · спрос: 3 лота на 24 шт");
        expect(copied).not.toMatch(/Кабель тестовый[^\n]*спрос/);
        expect(await noOverflow(page)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }

  it("без данных спроса строк нет", async () => {
    const { page, errors } = await openPage(1440);
    try {
      await page.goto(writePage(finHtml(false), "fin.html"));
      expect(await page.locator("#stockFocus li").count()).toBe(5);
      expect(await page.locator(".fin-stock-demand").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);
});

describe("вид менеджера: склад только штуками и только по своим планам", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-stock-variants-"));

  function deploy(name: string, stock: unknown) {
    const f = fixture();
    const src = path.join(dir, name, "src"); const out = path.join(dir, name, "out");
    fs.mkdirSync(src, { recursive: true });
    const payload = { ...pultPayload(), stock };
    const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, register: f.register };
    fs.writeFileSync(path.join(src, "index.html"), "ПОЛНЫЙ ПУЛЬТ");
    fs.writeFileSync(path.join(src, "reg.html"), "ПОЛНАЯ ВЫРУЧКА");
    fs.writeFileSync(path.join(src, "payload.json"), JSON.stringify(payload));
    fs.writeFileSync(path.join(src, "payload-reg.json"), JSON.stringify(reg));
    fs.writeFileSync(path.join(src, "plan-deals.json"), JSON.stringify(stockPlanDeals()));
    const config = path.join(dir, name, "config.json");
    fs.writeFileSync(config, JSON.stringify({ team: "example-team", users: { "seller@example.test": { kind: "manager", managerId: "s" } } }));
    const res = spawnSync("npx", ["tsx", "scripts/pult-variants.mts", src, out, config], { encoding: "utf8" });
    return { res, html: res.status === 0 ? fs.readFileSync(path.join(out, "_r/ms/index.html"), "utf8") : "" };
  }

  let valid: ReturnType<typeof deploy>;
  beforeAll(() => { valid = deploy("valid", pultPayload().stock); }, 60000);

  it("нет сумм, компаний, складов, номенклатуры и чужих сделок", () => {
    expect(valid.res.status, valid.res.stderr).toBe(0);
    const { html } = valid;
    expect(html).toContain('"stock":');
    expect(html).toContain("ИП|Интерактивные панели|75");
    for (const secret of [...STOCK_COMPANIES, ...STOCK_WAREHOUSES, "Образец 75", "Пример 86", "Кронштейн", "Кабель тестовый", "endSum", "startSum"]) {
      expect(html, secret).not.toContain(secret);
    }
    for (const sum of STOCK_SUMS) {
      for (const text of [String(sum), sum.toLocaleString("ru-RU"), sum.toLocaleString("ru-RU").replace(/\s/g, " ")]) expect(html).not.toContain(text);
    }
    // Подсказки — только по своим карточкам: свой план 6101 и свои лоты Радара (менеджер «s»: 5101, 5103, 5107).
    // Чужие планы и лоты (6102, 6103; 5102, 5105, 5106 у «t») не попадают ни в Радар, ни в подсказки склада.
    for (const id of ["6101", "5101"]) expect(html, id).toContain(`"${id}"`);
    for (const id of ["6102", "6103", "5102", "5105", "5106"]) expect(html, id).not.toContain(`"${id}"`);
  });

  for (const width of [375, 1440]) {
    it(`страница менеджера: тег в своём открытом плане, без переполнения; на ${width}`, async () => {
      const { page, errors } = await openPage(width);
      try {
        const url = writePage(valid.html);
        await gotoTab(page, url, "plans-ip");
        const tag = '#tab-plans-ip [data-plan-id="6101"] .stock-tag';
        await page.locator(tag).waitFor();
        expect(await tagText(page, tag)).toBe("склад: 69 шт · 75″");
        expect(await page.locator('#tab-plans-ip [data-plan-id="6102"]').count()).toBe(0);
        expect(await noOverflow(page)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }

  it("битый склад выкидывается с предупреждением (только счётчик), выкладка не падает", () => {
    const good = pultPayload().stock!;
    const { res, html } = deploy("broken", { ...good, rows: [{ ...good.rows[0], endSum: STOCK_SUMS[0] }], company: STOCK_COMPANIES[0] });
    expect(res.status, res.stderr).toBe(0);
    const log = res.stdout + res.stderr;
    expect(log).toMatch(/\[Склад\].*\d+/);
    for (const secret of [STOCK_COMPANIES[0], String(STOCK_SUMS[0]), "Интерактивные панели"]) expect(log).not.toContain(secret);
    expect(html).not.toContain('"stock":');
    expect(html).not.toContain(STOCK_COMPANIES[0]);
  }, 60000);
});
