import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { financeSnapshot, parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import type { FinanceView } from "../../src/bitrix/salesPult/finance/types.js";
import { renderFinanceHtml, renderPultHtml, type FinancePagePayload, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { DEFAULT_DEBTORS, financeWorkbook } from "../fixtures/sales-pult/financeWorkbook.js";

// Все данные выдуманные.

function view(options: Parameters<typeof financeWorkbook>[0] = {}, history = 1): FinanceView {
  const report = parseFinanceWorkbook(financeWorkbook(options));
  const snap = financeSnapshot(report);
  const snapshots = Array.from({ length: history }, (_, i) => ({
    ...snap,
    dataDate: new Date(Date.parse(snap.dataDate) - (history - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    cash: snap.cash + i * 100_000
  }));
  return { report, file: { id: "7", name: "Ежедневный отчет.xlsx", uploadedAt: "2026-11-17T06:58:16Z" }, snapshots };
}

const payload = (finance: FinanceView): FinancePagePayload => ({ asOfDate: "2026-11-17", generatedAt: "2026-11-17 12:15 (UTC+5)", finance });

describe("страница «Финансы»", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  async function open(html: string, width: number): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(html);
    return { page, errors };
  }
  const text = (page: Page, sel: string) => page.locator(sel).first().innerText();

  for (const width of [1440, 375]) {
    it(`показывает отчёт целиком и не шире экрана на ${width}`, async () => {
      const { page, errors } = await open(renderFinanceHtml(payload(view({}, 5))), width);
      try {
        expect(await page.locator(".sections a").evaluateAll((es) => es.map((e) => e.textContent!.trim())))
          .toEqual(["Сегодня", "Радар", "Выручка", "Финансы", "Планы", "Рынок", "Конкуренты"]);
        expect(await text(page, '.sections a[aria-current="page"]')).toBe("Финансы");
        for (const id of ["f-overview", "f-pnl", "f-payments", "f-debtors", "f-cash", "f-incoming", "f-balance"]) {
          expect(await page.locator(`#${id}`).count(), id).toBe(1);
        }
        expect(await text(page, "#dateLabel")).toMatch(/Данные на 16\.11 · период 01\.11\. - 16\.11\.2026/i);
        expect(await text(page, "#srcLabel")).toMatch(/Ежедневный отчет\.xlsx · загружен 17\.11 11:58/i);
        const tiles = await page.locator(".fin-tile").evaluateAll((es) => es.map((e) => e.querySelector(".label")!.textContent + "=" + e.querySelector(".v")!.textContent!.replace(/\s/g, " ")));
        expect(tiles).toEqual([
          "Деньги на счетах=1,6 млн ₸",
          "Календарь платежей=2,2 млн ₸",
          "Дебиторка=10,0 млн ₸",
          "Кредиторка=4,1 млн ₸",
          "Кредит Банк Один=12,0 млн ₸",
          "Товар на складе=10,0 млн ₸"
        ]);
        expect(await page.locator(".fin-spark").count()).toBe(6);
        expect((await text(page, "#f-payments .lead")).replace(/\s/g, " ")).toContain("не хватает 650 тыс ₸");
        expect(await page.locator("#f-debtors .fin-debt").first().locator(".r.body").count()).toBe(3);
        // в «Кассе» только 0,27 ₸ — колонка с копейками не показывается
        expect((await page.locator("#f-cash .r.head .label").allTextContents()).map((t) => t.trim())).toEqual(["Компания", "Банк Один", "Банк Два", "Всего", "ТМЦ"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const navOk = await page.locator(".sections a").evaluateAll((es, w) => es.every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= w; }), width);
        expect(navOk).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 20000);
  }

  it("дебиторы: фильтр по компании, «показать все», давность цветом", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Должник ${i + 1}`, company: 0 as const, amount: 10_000 + i, date: "2026-10-01" }));
    const { page, errors } = await open(renderFinanceHtml(payload(view({ debtors: [...DEFAULT_DEBTORS, ...many] }))), 1440);
    try {
      const rows = () => page.locator("#f-debtors .fin-debt").first().locator(".r.body").count();
      expect(await rows()).toBe(12);
      await page.locator("#debtAll").click();
      expect(await rows()).toBe(23);
      await page.locator('#debtChips button[data-c="Бета"]').click();
      expect(await rows()).toBe(1);
      expect(await page.locator('#debtChips button[data-c="Бета"]').getAttribute("aria-pressed")).toBe("true");
      expect(await text(page, "#f-debtors .block-head .idx")).toBe("04");
      // продажа 01.06, сегодня 17.11 — больше 60 дней, красным
      expect(await page.locator("#f-debtors .fin-debt .r.body .num.bad").count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);

  it("одна запись в истории — без графиков, с пояснением", async () => {
    const { page } = await open(renderFinanceHtml(payload(view())), 1440);
    try {
      expect(await page.locator(".fin-spark").count()).toBe(0);
      expect(await text(page, "#f-overview .fin-note")).toMatch(/накопится несколько дней/);
    } finally { await page.close(); }
  });

  it("нет отчёта — ошибка вместо страницы; есть пояснение — над отчётом", async () => {
    let { page } = await open(renderFinanceHtml(payload({ snapshots: [], error: "В чате «Финансовый отчет» пока нет ни одного .xlsx." })), 1440);
    try {
      expect(await text(page, "#tab-fin")).toMatch(/пока нет ни одного \.xlsx/);
      expect(await page.locator(".fin-tile").count()).toBe(0);
    } finally { await page.close(); }
    ({ page } = await open(renderFinanceHtml(payload({ ...view(), notice: "Последний файл «x.xlsx» не разобран." })), 1440));
    try {
      expect(await text(page, "#tab-fin > .note-warn")).toBe("Последний файл «x.xlsx» не разобран.");
      expect(await page.locator(".fin-tile").count()).toBe(6);
    } finally { await page.close(); }
  });

  it("старый отчёт помечается, текст из файла экранируется", async () => {
    const v = view({ debtors: [{ name: '<img src=x onerror="window.hacked=1">', company: 0, amount: 1, date: "2026-11-01" }] });
    v.report!.dataDate = "2026-11-10";
    const { page, errors } = await open(renderFinanceHtml(payload(v)), 1440);
    try {
      expect(await text(page, "#tab-fin > .note-warn")).toMatch(/Отчёт старый: данные на 10\.11/);
      expect(await page.evaluate(() => (window as unknown as { hacked?: number }).hacked)).toBeUndefined();
      expect(await page.locator("#f-debtors img").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it("в виде менеджера ссылки «Финансы» нет ни на главной, ни на «Выручке»", async () => {
    const f = fixture();
    const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, portal: "https://example.invalid", register: f.register };
    const pages = renderManagerVariant(buildManagerVariant({ pult: f.payload, reg, planDeals: [], managerId: "s", aliases: f.aliases })!);
    // Каждая страница в своей вкладке: повторный setContent объявляет PAYLOAD второй раз.
    for (const [html, links] of [[renderPultHtml(f.payload), 1], [pages.index, 0], [pages.reg, 0]] as const) {
      const { page, errors } = await open(html, 1440);
      try {
        expect(await page.locator('a[href="./fin.html"]').count()).toBe(links);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  }, 20000);
});
