import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { buildFinanceInsights, classifyDebtorsByPayment } from "../../src/bitrix/salesPult/finance/insights.js";
import { financeSnapshot, parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import type { FinanceView } from "../../src/bitrix/salesPult/finance/types.js";
import { renderFinanceHtml, type FinancePagePayload } from "../../src/bitrix/salesPult/site.js";
import { DEFAULT_DEBTORS, financeWorkbook, type FinanceDebtorFixture } from "../fixtures/sales-pult/financeWorkbook.js";

// Все данные выдуманные.

const AS_OF = "2026-11-17";

function buildView(options: Parameters<typeof financeWorkbook>[0] = {}): FinanceView {
  const report = parseFinanceWorkbook(financeWorkbook(options));
  return {
    report,
    file: { id: "12", name: "Ежедневный отчет.xlsx", uploadedAt: "2026-11-17T06:58:16Z" },
    snapshots: [financeSnapshot(report)]
  };
}

const makePayload = (finance: FinanceView, asOfDate = AS_OF): FinancePagePayload => ({
  asOfDate,
  generatedAt: `${asOfDate} 12:15 (UTC+5)`,
  finance
});

describe("разделение дебиторов на просроченную и непросроченную задолженность", () => {
  it("классифицирует долги по дате оплаты: строго до даты сборки — просрочено, сегодня и позже или без даты — непросрочено", () => {
    const report = parseFinanceWorkbook(financeWorkbook({
      debtorColumns: true,
      debtors: [
        // paymentDate = saleDate + 30 дней; asOfDate = 2026-11-17
        { name: "Просрочен на 1 день", company: 0, amount: 1_000_000, date: "2026-10-17" }, // pay 2026-11-16 (-1д)
        { name: "Просрочен давно и крупно", company: 1, amount: 4_000_000, date: "2026-09-01" }, // pay 2026-10-01 (-47д)
        { name: "Оплата сегодня", company: 0, amount: 2_000_000, date: "2026-10-18" }, // pay 2026-11-17 (0д)
        { name: "Оплата впереди", company: 1, amount: 3_000_000, date: "2026-11-05" } // pay 2026-12-05 (+18д)
      ]
    }));
    // Добавляем долг без даты оплаты
    report.debtors.rows.push({ name: "Без даты оплаты", company: "Альфа", amount: 500_000, saleDate: "2026-11-10" });
    report.debtors.totals[0] += 500_000;
    report.debtors.total += 500_000;

    const split = classifyDebtorsByPayment(report.debtors, AS_OF);
    expect(split).not.toBeNull();
    expect(split!.overdue.count).toBe(2);
    expect(split!.overdue.total).toBe(5_000_000);
    expect(split!.overdue.byCompany).toEqual([
      { company: "Альфа", count: 1, total: 1_000_000 },
      { company: "Бета", count: 1, total: 4_000_000 }
    ]);
    expect(split!.overdue.top5.map((x) => [x.name, x.overdueDays])).toEqual([
      ["Просрочен давно и крупно", 47],
      ["Просрочен на 1 день", 1]
    ]);

    expect(split!.current.count).toBe(3);
    expect(split!.current.total).toBe(5_500_000);
    expect(split!.current.undated).toEqual({ count: 1, total: 500_000 });
    expect(split!.current.byCompany).toEqual([
      { company: "Альфа", count: 2, total: 2_500_000 },
      { company: "Бета", count: 1, total: 3_000_000 }
    ]);
    expect(split!.overdue.total + split!.current.total).toBe(report.debtors.total);
  });

  it("возвращает null, если в отчёте нет колонки «Дата оплаты» и ни у одного долга нет даты оплаты", () => {
    const report = parseFinanceWorkbook(financeWorkbook());
    expect(classifyDebtorsByPayment(report.debtors, AS_OF)).toBeNull();
    const insights = buildFinanceInsights({ snapshots: [], report }, AS_OF);
    expect(insights.debt.byPayment).toBeNull();
  });

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

  for (const width of [1440, 375]) {
    it(`разделяет дебиторов на две таблицы с итогами, фильтрами и сортировкой на ${width}px`, async () => {
      const debtors: FinanceDebtorFixture[] = [
        ...DEFAULT_DEBTORS.slice(0, 2),
        { ...DEFAULT_DEBTORS[2], claimDate: "2026-11-13", claimNo: "Иск подан в суд Пример" },
        { name: "Гимназия В срок", company: 1, amount: 1_500_000, date: "2026-10-18" } // оплата 17.11 (сегодня -> непросроченная)
      ];
      const v = buildView({ debtors, debtorColumns: true, debtorGap: true });
      v.report!.debtors.rows.push({ name: "Лицей Без даты", company: "Альфа", amount: 500_000, saleDate: "2026-11-10" });
      v.report!.debtors.totals[0] += 500_000;
      v.report!.debtors.total += 500_000;

      const { page, errors } = await open(renderFinanceHtml(makePayload(v)), width);
      try {
        await page.evaluate(() => {
          Object.defineProperty(navigator, "clipboard", {
            value: { writeText: async (value: string) => { document.body.dataset.clipboard = value; } }
          });
        });

        // Плитка «Дебиторка» сразу показывает просроченную и непросроченную суммы
        const debtTileSub = (await page.locator("#f-overview .fin-tile").nth(2).locator(".sub").innerText()).replace(/\s+/g, " ");
        expect(debtTileSub).toContain("просрочено 5,0 млн ₸");
        expect(debtTileSub).toContain("непросрочено 7,0 млн ₸");

        // В блоке дебиторов нет старого единого #debtMainBox, вместо него две отдельные таблицы + проблемные
        expect(await page.locator("#debtMainBox").count()).toBe(0);
        const overdueBox = page.locator("#debtOverdueBox");
        const currentBox = page.locator("#debtCurrentBox");
        const problemBox = page.locator("#debtProblemBox");
        expect(await overdueBox.count()).toBe(1);
        expect(await currentBox.count()).toBe(1);
        expect(await problemBox.count()).toBe(1);

        // Обе таблицы свёрнуты по умолчанию, итоги видны прямо в заголовках
        expect(await overdueBox.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
        expect(await currentBox.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
        expect((await overdueBox.locator("summary").innerText()).replace(/\s+/g, " "))
          .toMatch(/^Просроченная задолженность 2 долга · 5,0 млн ₸/);
        expect((await currentBox.locator("summary").innerText()).replace(/\s+/g, " "))
          .toMatch(/^Непросроченная задолженность 3 долга · 7,0 млн ₸/);

        // Фокус-блок сразу виден: сводка и топ просроченных
        const focusText = (await page.locator(".fin-debt-focus").innerText()).replace(/\s+/g, " ");
        expect(focusText).toContain("Просроченная 2 долга · 5,0 млн ₸");
        expect(focusText).toContain("Непросроченная 3 долга · 7,0 млн ₸");
        expect(focusText).toContain("Колледж Пример");
        expect(focusText).not.toContain("Школа Тест №1");

        // Кнопка копирования копирует просроченных должников
        await page.locator('[data-fin-copy="debt"]').click();
        const copied = (await page.locator("body").getAttribute("data-clipboard"))!.replace(/\s+/g, " ");
        expect(copied).toContain("Просроченная задолженность");
        expect(copied).toContain("Колледж Пример");
        expect(copied).toContain("просрочено 47 дн.");
        expect(copied).not.toContain("Школа Тест №1");

        // Кнопка «Открыть просроченные» раскрывает таблицу просроченных
        await page.locator('[data-debt-open="overdue"]').click();
        expect(await overdueBox.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true);
        const overdueNames = () => overdueBox.locator(".fin-debt .r.body .nm").evaluateAll((es) => es.map((e) => e.getAttribute("title")));
        expect(await overdueNames()).toEqual(["Колледж Пример", "Учреждение Образец"]);
        expect((await overdueBox.locator(".fin-debt .r.total").innerText()).replace(/\s+/g, " ")).toContain("5,0 млн");

        // Фильтр по компании работает независимо внутри просроченных
        await overdueBox.locator('.chips button[data-c="Бета"]').click();
        expect(await overdueNames()).toEqual(["Учреждение Образец"]);
        expect((await overdueBox.locator(".fin-debt .r.total").innerText()).replace(/\s+/g, " ")).toContain("2,0 млн");
        await overdueBox.locator('.chips button[data-c=""]').click();
        expect(await overdueNames()).toEqual(["Колледж Пример", "Учреждение Образец"]);

        // Раскрываем непросроченную таблицу: все 3 строки (включая «сегодня» и «без даты»), свой итог и пометка про без даты
        await currentBox.locator("summary").click();
        const currentNames = () => currentBox.locator(".fin-debt .r.body .nm").evaluateAll((es) => es.map((e) => e.getAttribute("title")));
        expect(await currentNames()).toEqual(["Школа Тест №1", "Гимназия В срок", "Лицей Без даты"]);
        expect((await currentBox.locator(".fin-debt-meta").innerText()).replace(/\s+/g, " ")).toContain("без даты оплаты: 1");
        expect((await currentBox.locator(".fin-debt .r.total").innerText()).replace(/\s+/g, " ")).toContain("7,0 млн");

        // Фильтр компании в непросроченных не сбивает просроченные
        await currentBox.locator('.chips button[data-c="Бета"]').click();
        expect(await currentNames()).toEqual(["Гимназия В срок"]);
        expect(await overdueNames()).toEqual(["Колледж Пример", "Учреждение Образец"]);

        // Сортировка по «До оплаты» в просроченных не закрывает таблицы и сортирует обе
        await currentBox.locator('.chips button[data-c=""]').click();
        await overdueBox.locator('.fin-sort[data-sort="toPay"]').click();
        expect(await overdueNames()).toEqual(["Колледж Пример", "Учреждение Образец"]);
        await overdueBox.locator('.fin-sort[data-sort="toPay"]').click();
        expect(await overdueNames()).toEqual(["Учреждение Образец", "Колледж Пример"]);
        expect(await currentNames()).toEqual(["Гимназия В срок", "Школа Тест №1", "Лицей Без даты"]);
        expect(await overdueBox.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true);
        expect(await currentBox.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true);

        // Проблемные долги по-прежнему отдельно
        await problemBox.locator("summary").click();
        expect(await problemBox.locator(".fin-debt .r.body").count()).toBe(2);

        // Верстка без горизонтальной прокрутки
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 20000);
  }

  it("корректно показывает случай без просроченных долгов и кнопку «Показать все» при >12 строках", async () => {
    const manyCurrent: FinanceDebtorFixture[] = Array.from({ length: 15 }, (_, i) => ({
      name: `Свежий должник ${i + 1}`,
      company: (i % 2) as 0 | 1,
      amount: 100_000 + i * 1_000,
      date: "2026-11-10" // pay 2026-12-10 (+23д)
    }));
    const v = buildView({ debtors: manyCurrent, debtorColumns: true });
    const { page, errors } = await open(renderFinanceHtml(makePayload(v)), 1440);
    try {
      expect((await page.locator("#debtOverdueBox summary").innerText()).replace(/\s+/g, " "))
        .toBe("Просроченная задолженность нет · 0 ₸");
      expect((await page.locator(".fin-debt-focus").innerText()).replace(/\s+/g, " "))
        .toContain("Просроченных долгов на 17.11.2026 нет.");
      await page.locator("#debtCurrentBox summary").click();
      expect(await page.locator("#debtCurrent .fin-debt .r.body").count()).toBe(12);
      await page.locator('[data-debt-all="current"]').click();
      expect(await page.locator("#debtCurrent .fin-debt .r.body").count()).toBe(15);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20000);
});
