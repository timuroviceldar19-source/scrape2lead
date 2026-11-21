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

  it("платежи: все списки, и календарь тоже, свёрнуты и раскрываются по клику", async () => {
    const v = view();
    const { page, errors } = await open(renderFinanceHtml(payload(v)), 1440);
    try {
      const boxes = page.locator("#f-payments details.fin-more");
      expect(await boxes.count()).toBe(v.report!.payments.length);
      expect(await boxes.evaluateAll((es) => es.map((e) => (e as HTMLDetailsElement).open))).toEqual(v.report!.payments.map(() => false));
      expect(await page.locator("#f-payments h3").count()).toBe(0);
      const cal = boxes.first();
      expect((await cal.locator("summary").innerText()).replace(/\s/g, " ")).toMatch(/^Календарь платежей \d+ платеж\S* · [\d ,]+ (млн|тыс) ₸$/);
      expect(await cal.locator(".r.body").first().isVisible()).toBe(false);
      await cal.locator("summary").click();
      expect(await cal.locator(".r.body").first().isVisible()).toBe(true);
      expect(await page.locator("#f-payments .lead").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it("дебиторы: свёрнуты, сортировка по «Сумма» и «Прошло» не закрывает список", async () => {
    const v = view();
    // долг без даты реализации — при сортировке по дням всегда внизу
    v.report!.debtors.rows.push({ name: "Без даты", company: "Альфа", amount: 9_000_000 });
    for (const width of [1440, 375]) {
      const { page, errors } = await open(renderFinanceHtml(payload(v)), width);
      try {
        const box = page.locator("#debtMainBox");
        expect(await box.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
        expect((await box.locator("summary").innerText()).replace(/\s/g, " ")).toMatch(/^Список дебиторов 4 долга · /);
        expect(await page.locator("#debtProblemBox").evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
        await box.locator("summary").click();
        const names = () => box.locator(".fin-debt .r.body .nm").evaluateAll((es) => es.map((e) => e.getAttribute("title")));
        const sortState = () => box.locator('[role="columnheader"]').evaluateAll((es) => es.map((e) => `${e.textContent!.trim()}=${e.getAttribute("aria-sort")}`));
        // по умолчанию — сумма от большей к меньшей
        expect(await names()).toEqual(["Без даты", "Школа Тест №1", "Колледж Пример", "Учреждение Образец"]);
        expect(await sortState()).toEqual(["Сумма ↓=descending", "Прошло ↕=none"]);
        await box.locator('.fin-sort[data-sort="days"]').click();
        expect(await names()).toEqual(["Учреждение Образец", "Колледж Пример", "Школа Тест №1", "Без даты"]);
        expect(await sortState()).toEqual(["Сумма ↕=none", "Прошло ↓=descending"]);
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.sort)).toBe("days");
        await box.locator('.fin-sort[data-sort="days"]').click();
        expect(await names()).toEqual(["Школа Тест №1", "Колледж Пример", "Учреждение Образец", "Без даты"]);
        expect(await sortState()).toEqual(["Сумма ↕=none", "Прошло ↑=ascending"]);
        await box.locator('.fin-sort[data-sort="amount"]').click();
        expect(await names()).toEqual(["Без даты", "Школа Тест №1", "Колледж Пример", "Учреждение Образец"]);
        await box.locator('.fin-sort[data-sort="amount"]').click();
        expect(await names()).toEqual(["Учреждение Образец", "Колледж Пример", "Школа Тест №1", "Без даты"]);
        expect(await box.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true);
        // проблемные долги сортируются так же, фильтр компании их не трогает
        await page.locator('#debtChips button[data-c="Бета"]').click();
        expect(await names()).toEqual(["Учреждение Образец"]);
        const problem = page.locator("#debtProblemBox");
        await problem.locator("summary").click();
        expect(await problem.locator(".fin-debt .r.body .nm").evaluateAll((es) => es.map((e) => e.getAttribute("title")))).toEqual(["ИП Пропавший", "ТОО Должник"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  }, 20000);

  it("дебиторы: фильтр по компании, «показать все», давность цветом", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Должник ${i + 1}`, company: 0 as const, amount: 10_000 + i, date: "2026-10-01" }));
    const { page, errors } = await open(renderFinanceHtml(payload(view({ debtors: [...DEFAULT_DEBTORS, ...many] }))), 1440);
    try {
      const rows = () => page.locator("#f-debtors .fin-debt").first().locator(".r.body").count();
      await page.locator("#debtMainBox summary").click();
      expect(await rows()).toBe(12);
      await page.locator("#debtAll").click();
      expect(await rows()).toBe(23);
      await page.locator('#debtChips button[data-c="Бета"]').click();
      expect(await rows()).toBe(1);
      expect(await page.locator('#debtChips button[data-c="Бета"]').getAttribute("aria-pressed")).toBe("true");
      expect(await text(page, "#f-debtors .block-head .idx")).toBe("02");
      // продажа 01.06, сегодня 17.11 — больше 60 дней, красным
      expect(await page.locator("#f-debtors .fin-debt .r.body .num.bad").count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);

  it("склад: ведомости по компаниям, склады свёрнуты, поиск раскрывает найденное", async () => {
    for (const width of [1440, 375]) {
      const { page, errors } = await open(renderFinanceHtml(payload(view({ stockSheets: true }))), width);
      try {
        const stock = page.locator("#f-stock");
        expect(await stock.locator(".block-head .meta").innerText()).toMatch(/материальная ведомость 1С за ноябрь 2026/i);
        // компания с большим остатком — первой
        expect((await stock.locator("#stockChips button").allTextContents()).map((t) => t.trim())).toEqual(["Альфа", "Бета"]);
        const summaries = () => stock.locator("details.fin-wh summary").evaluateAll((es) => es.map((e) => e.textContent!.replace(/\s+/g, " ").trim()));
        expect(await summaries()).toEqual(["Склад Один 3 позиции · 805 тыс ₸", "Склад Два 1 позиция · 150 тыс ₸"]);
        expect(await stock.locator("details.fin-wh[open]").count()).toBe(0);
        // внутри склада: дороже — выше, проданное в ноль — внизу и серым
        await stock.locator("details.fin-wh summary").first().click();
        const first = stock.locator("details.fin-wh").first();
        expect(await first.locator(".r.body .nm").evaluateAll((es) => es.map((e) => e.getAttribute("title")))).toEqual(["Ноутбук Тест 15", "Кабель тестовый", "Монитор Пример 24"]);
        expect(await first.locator(".r.body.is-gone").count()).toBe(1);
        if (width === 1440) {
          expect((await first.locator(".r.head .label").allTextContents()).map((t) => t.trim())).toEqual(["Товар", "На начало", "Приход", "Расход", "На конец", "Сумма"]);
        } else {
          expect((await first.locator(".fin-stock-m").first().innerText()).replace(/\s/g, " ")).toBe("остаток 2 → 4 · приход 3 · расход 1");
        }
        await stock.locator("details.fin-wh summary").first().click();
        // поиск: раскрывает склады с найденным, считает по компаниям, очистка закрывает раскрытое поиском
        await page.locator("#stockQ").fill("ноутбук");
        expect(await page.locator("#stockFound").innerText()).toBe("найдено: 2 позиции");
        expect(await stock.locator("details.fin-wh[open]").count()).toBe(2);
        expect(await stock.locator(".r.body:not([hidden])").count()).toBe(2);
        expect((await stock.locator("#stockChips button").allTextContents()).map((t) => t.trim())).toEqual(["Альфа · 2", "Бета · 1"]);
        await page.locator("#stockQ").fill("кабель тест");
        expect(await stock.locator("details.fin-wh:not([hidden])").count()).toBe(1);
        await page.locator("#stockQ").fill("");
        expect(await stock.locator("details.fin-wh[open]").count()).toBe(0);
        expect(await stock.locator("details.fin-wh[hidden], .r.body[hidden]").count()).toBe(0);
        expect((await stock.locator("#stockChips button").allTextContents()).map((t) => t.trim())).toEqual(["Альфа", "Бета"]);
        // у второй компании прихода и расхода в выгрузке нет — и колонок нет
        await stock.locator('#stockChips button[data-c="Бета"]').click();
        expect(await stock.locator("details.fin-wh").count()).toBe(1);
        expect(await stock.locator(".fin-note").first().innerText()).toMatch(/Прихода и расхода в выгрузке этой компании нет/);
        expect(await stock.locator(".fin-stock.moves").count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  }, 20000);

  it("нет листов ведомости — нет и раздела «Склад»", async () => {
    const { page } = await open(renderFinanceHtml(payload(view())), 1440);
    try {
      expect(await page.locator("#f-stock").count()).toBe(0);
    } finally { await page.close(); }
  });

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
