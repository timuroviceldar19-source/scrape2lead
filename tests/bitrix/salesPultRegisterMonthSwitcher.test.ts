import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { chromium } from "playwright";
import { buildFullRegisterHistory } from "../../src/bitrix/salesPult/register/history.js";
import { renderRegisterHtml } from "../../src/bitrix/salesPult/site.js";

async function fixture() {
  const files = [];
  for (const [month, day, product, type] of [["09", "30", "моноблок", "ом"], ["10", "31", "панель", "зцп"], ["11", "03", "ноутбук", "b2b"]]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");
    ws.getRow(1).values = [null, "Дата договора", "Тип продажи", "Контрагент", "Кол-во", "Товар", "Сумма без НДС", "Сумма продажи без НДС", "ИТОГО вал", "Менеджер"];
    ws.getRow(2).values = [null, `2026-${month}-01`, type, `Заказчик ${month}`, 1, product, 100000, Number(month) * 1000000, 50000, `Менеджер ${month}`];
    files.push({ fileName: `ОП ${day}.${month}.26.xlsx`, buffer: Buffer.from(await wb.xlsx.writeBuffer()) });
  }
  return buildFullRegisterHistory({ files, todayAlmaty: "2026-11-03", fetchPortal: false, crmWonDealsByMonth: new Map() });
}

describe("переключатель месяцев реестра", () => {
  it("сохраняет независимые полные срезы после сверки CRM", async () => {
    const history = await fixture();
    // Проверка через JSON сохраняет компиляцию RED-теста до расширения типа.
    const views = JSON.parse(JSON.stringify(history)).monthViews;
    expect(Object.keys(views || {})).toEqual(["2026-09", "2026-10", "2026-11"]);
    for (const summary of history.months) {
      const view = views[summary.month];
      expect(view.file).toBe(summary.fileName);
      expect(view.asOf.startsWith(summary.month)).toBe(true);
      expect(view.total.sale).toBe(summary.sale);
      expect(view.managers[0].name).toBe(summary.byManager[0].name);
      expect(view.rows[0].customer).toBe(`Заказчик ${summary.month.slice(5)}`);
      expect(view.mix[0].sale).toBe(summary.sale);
      expect(view.channels[0].sale).toBe(summary.sale);
      expect(view.missing).toEqual(summary.missingCrm);
      expect(view).not.toHaveProperty("history");
    }
  });

  it("переключает весь отчёт кнопкой/hash и поддерживает старый кэш", async () => {
    const history = await fixture();
    const { buildRegisterView } = await import("../../src/bitrix/salesPult/register/buildView.js");
    // Независимый текущий view позволяет проверить UI даже в RED без monthViews.
    const register = buildRegisterView({ rows: [], plans: {}, missing: [], extraDealsCount: 0, fileName: "current.xlsx", asOf: "2026-11-03", month: "2026-11", history });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.setContent(renderRegisterHtml({ register, asOfDate: "2026-11-03", generatedAt: "test" }));
      expect(await page.locator("#registerMonths button").count()).toBe(3);
      await page.locator('#registerMonths button[data-month="2026-09"]').click();
      expect(await page.locator("#dateLabel").textContent()).toContain("2026-09-30");
      expect(await page.locator("#srcLabel").textContent()).toContain("30.09.26.xlsx");
      expect(await page.locator("#footSource").textContent()).toContain("30.09.26.xlsx");
      expect(await page.locator("#r-month").textContent()).toContain("Сентябрь");
      expect(await page.locator(".mgr").textContent()).toContain("Менеджер 09");
      expect(await page.locator("#regAll").textContent()).toContain("Заказчик 09");
      expect(await page.locator('#r-history [data-month="2026-09"]').getAttribute("aria-current")).toBe("true");
      await page.evaluate(() => { location.hash = "2026-10"; });
      await page.waitForFunction(() => document.querySelector("#r-month")?.textContent?.includes("Октябрь"));
      await page.evaluate(() => { location.hash = "constructor"; });
      await page.waitForTimeout(30);
      expect(await page.locator("#r-month").textContent()).toContain("Ноябрь");
      delete (history as any).monthViews;
      await page.goto("about:blank");
      await page.setContent(renderRegisterHtml({ register: { ...register, history }, asOfDate: "2026-11-03", generatedAt: "test" }));
      await page.locator('#registerMonths button[data-month="2026-09"]').click();
      expect(await page.locator(".mgr").textContent()).toContain("Менеджер 09");
      expect(await page.locator("#regAll").textContent()).not.toContain("Заказчик 11");
      expect(await page.locator("#r-history").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 30000);
});
