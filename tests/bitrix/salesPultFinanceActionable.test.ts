import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { buildFinanceInsights, parsePaymentDueHint } from "../../src/bitrix/salesPult/finance/insights.js";
import { financeSnapshot, parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import { renderFinanceHtml } from "../../src/bitrix/salesPult/site.js";
import { financeWorkbook } from "../fixtures/sales-pult/financeWorkbook.js";

const report = parseFinanceWorkbook(financeWorkbook({ stockSheets: true }));
report.payments[0].items[0].tag = "20-е";
const snap = financeSnapshot(report);
const snapshots = [
  { ...snap, dataDate: "2026-11-09", cash: 100 },
  { ...snap, dataDate: "2026-11-16", cash: 200 },
  { ...snap, dataDate: "2026-11-17", cash: 300 }
];
const finance = { report, snapshots };
const asOfDate = "2026-11-17";

it("считает интервалы, нагрузку с КПН и сверку склада", () => {
  const result = buildFinanceInsights(finance, asOfDate);
  expect(result.deltas.cash).toEqual({ prevDay: { days: 1, change: 100 }, week: { days: 8, change: 200 } });
  expect(result.totalWithTax).toBe(report.payments[0].total + (report.tax?.total ?? 0));
  expect(result.cashGap).toBe(report.cash.total - result.totalWithTax);
  expect(result.stock.diff).toBe(report.stock!.reduce((sum, stock) => sum + stock.total.end, 0) - report.cash.inventory);
  expect(result.stock.mismatch).toBe(true);
  expect(result.stock.top5.map(({ name }) => name)).toEqual(["Ноутбук Образец 14", "Кабель тестовый"]);
  expect(result.debt.top5).toEqual(result.debt.top10.slice(0, 5));
});

it("читает сроки в пометке и получателе с переходом года", () => {
  expect(parsePaymentDueHint({ tag: "1-е", payee: "Компания" }, "2026-12-30"))
    .toEqual({ date: "2027-01-01", days: 2, isSoon: true });
  expect(parsePaymentDueHint({ payee: "Компания до 25" }, asOfDate)?.days).toBe(8);
  expect(parsePaymentDueHint({ payee: "Компания 25.11" }, asOfDate)?.date).toBe("2026-11-25");
  expect(parsePaymentDueHint({ payee: "Компания до 25.11." }, asOfDate)?.date).toBe("2026-11-25");
  expect(parsePaymentDueHint({ payee: "Компания 31.02" }, asOfDate)).toBeNull();
});

it("использует реальные интервалы и значения доступных снимков", () => {
  const result = buildFinanceInsights({ snapshots: [
    { ...snap, dataDate: "2026-11-17", cash: 300 },
    { ...snap, dataDate: "2026-11-01", cash: 0, payables: undefined },
    { ...snap, dataDate: "2026-11-11", cash: 200, payables: undefined },
    { ...snap, dataDate: "2026-11-09", cash: 100 }
  ] });
  expect(result.deltas.cash).toEqual({ prevDay: undefined, week: { days: 8, change: 200 } });
  expect(result.deltas.payables.week?.days).toBe(8);
  expect(buildFinanceInsights({ snapshots: [snapshots[0], snapshots[1]] }).deltas.cash.week?.days).toBe(7);
  expect(buildFinanceInsights({ snapshots: [{ ...snap, dataDate: "2026-11-01" }, snapshots[2]] }).deltas.cash.week?.days).toBe(16);
  expect(buildFinanceInsights({ snapshots: [snap] }).deltas.cash.week).toBeUndefined();
});

it("учитывает строгие границы возраста и исключает свежий приход и склад без данных о движении", () => {
  const agedAndStock = parseFinanceWorkbook(financeWorkbook({ stockSheets: true, debtors: [
    { name: "30 дней", company: 0, amount: 99_000, date: "2026-10-18" },
    { name: "60 дней", company: 0, amount: 70_000, date: "2026-09-18" },
    { name: "61 день", company: 1, amount: 10_000, date: "2026-09-17" },
    { name: "31 день", company: 1, amount: 90_000, date: "2026-10-17" }
  ] }));
  agedAndStock.stock!.find((sheet) => sheet.hasMoves)!.warehouses[0].items.push({
    name: "Новый товар", startQty: 0, startSum: 0, inQty: 1, inSum: 12_000, endQty: 1, endSum: 12_000
  });
  const result = buildFinanceInsights({ snapshots: [], report: agedAndStock }, asOfDate);
  expect(result.debt.over30).toEqual({ count: 3, total: 170_000 });
  expect(result.debt.over60).toEqual({ count: 1, total: 10_000 });
  expect(result.debt.top5.map(({ name }) => name)).toEqual(["61 день", "31 день", "60 дней"]);
  expect(result.stock.top5.map(({ name }) => name)).toEqual(["Ноутбук Образец 14", "Кабель тестовый"]);
  agedAndStock.cash.inventory = result.stock.statementTotal + 1000;
  expect(buildFinanceInsights({ snapshots: [], report: agedAndStock }).stock.mismatch).toBe(false);
});

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map((value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

for (const width of [375, 1440]) {
  it(`показывает сигналы и действия на ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          value: { writeText: async (value: string) => { document.body.dataset.clipboard = value; } }
        });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const renderedReport = { ...report, warnings: ["Тестовая сверка"],
        pnl: width === 375 ? { current: report.pnl.current } : report.pnl };
      await page.setContent(renderFinanceHtml({ finance: { ...finance, report: renderedReport }, asOfDate, generatedAt: "" }));
      expect(await page.locator("#tab-fin > section").first().getAttribute("id")).toBe("f-warnings");
      expect(await page.locator("#f-overview .fin-tile.is-bad .warn").innerText()).toContain("не хватает");
      expect(await page.locator("#f-overview .fin-deltas .good").first().innerText()).toContain("+");
      expect(await page.locator("#f-overview .fin-jumps a").count()).toBe(4);
      expect(await page.locator("#tab-fin > section.block:not(#f-warnings)").evaluateAll((nodes) => nodes.map((node) => node.id)))
        .toEqual(["f-overview", "f-debtors", "f-payments", "f-stock", "f-pnl", "f-cash", "f-incoming", "f-balance"]);
      expect(await page.locator("#f-overview .fin-tile").count()).toBe(6);
      expect(await page.locator(".fin-debt-focus").isVisible()).toBe(true);
      expect(await page.locator("#debtMainBox").getAttribute("open")).toBeNull();
      const copied = async (key: string) => {
        await page.locator(`[data-fin-copy="${key}"]`).click();
        return (await page.locator("body").getAttribute("data-clipboard"))!.replace(/\s/g, " ");
      };
      expect(await copied("debt")).toMatch(/Колледж Пример · Альфа · 3 000 000 ₸ · реализация 01.09.2026 · 77 дн./);
      await page.locator(".fin-debt-focus button[data-debt-focus='60']").click();
      expect(await page.locator("#debtAgeChips [data-age='60']").getAttribute("aria-pressed")).toBe("true");
      expect(await page.locator("#f-payments details[open]").count()).toBe(0);
      expect(await page.locator("#f-payments .lead").innerText()).toContain("С учётом КПН");
      expect(await copied("payments")).toContain("до 20.11.2026");
      await page.locator("#f-payments details summary").first().click();
      expect(await page.locator("#f-payments .fin-due.warn").innerText()).toContain("20.11");
      expect(await page.locator("#stockModeChips button").count()).toBe(3);
      expect(await page.locator("#f-stock > .note-warn").innerText()).toContain("Ежед.");
      expect(await copied("stock")).toContain("Кабель тестовый · Альфа · Склад Один · 10,5 м");
      const stockRows = page.locator("#stockBody .r.body:visible");
      await page.locator("#stockModeChips [data-mode=stagnant]").click();
      expect(await stockRows.count()).toBe(2);
      if (width === 375) expect(await stockRows.locator(".fin-stock-m").first().innerText()).toContain("без расхода");
      await page.locator("#stockQ").fill("ноутбук");
      expect(await stockRows.count()).toBe(1);
      await page.locator("#stockModeChips [data-mode=present]").click();
      expect(await stockRows.count()).toBe(2);
      await page.locator("#stockQ").clear();
      expect(await stockRows.count()).toBe(3);
      expect(await page.locator("#stockBody .is-gone:visible").count()).toBe(0);
      expect(await page.locator(".dateline").evaluate((element) => getComputedStyle(element).position)).toBe(width === 375 ? "static" : "sticky");
      if (width === 375) {
        expect(await page.locator(".fin-pnl.no-prev .r.head").evaluate((element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(5);
        for (const selector of [".fin-pnl", ".fin-cash"]) {
          expect(await page.locator(`${selector} .r.head > :first-child`).evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
        }
      }
      expect(errors).toEqual([]);
      expect(await page.locator("#tab-fin").innerText()).not.toMatch(/просроч/i);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const colors = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        return ["--warn-ink", "--bad-ink", "--warn-t", "--sheet", "--paper"].map((name) => css.getPropertyValue(name).trim());
      });
      const levels = colors.map((color) => luminance(color.slice(1).match(/../g)!.map((hex) => parseInt(hex, 16))));
      for (const ink of levels.slice(0, 2)) {
        for (const background of levels.slice(2)) expect((background + 0.05) / (ink + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await page.close();
    }
  });
}
