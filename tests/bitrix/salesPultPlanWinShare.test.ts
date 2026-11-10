import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import type { NormalizedPlanDeal, PlanOutcome } from "../../src/bitrix/salesPult/plans/types.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

function fixture() {
  const deals: NormalizedPlanDeal[] = [];
  for (const group of ["ИП", "КТ"] as const) {
    const add = (month: string, manager: string, outcomeCategory: PlanOutcome, count: number, sum: number) => {
      for (let i = 0; i < count; i++) deals.push({
        id: String(deals.length + 1), group, month, managerId: manager, managerName: `Вымышленный ${manager}`,
        sum, qty: 1, price: sum, customerName: "Выдуманная школа", customerBin: "000000000000",
        itemName: "Тестовый товар", truCode: "", kind: "Тестовый вид", method: "Тестовый способ",
        portalStatus: "Тестовый статус", dateCreate: "2026-11-01", isOpen: outcomeCategory === "open",
        isNewStage: outcomeCategory === "open", outcomeCategory, outcomeKey: outcomeCategory,
        isWonCrm: false, isLostCrm: false, dealUrl: "https://example.com/deal", planUrl: "https://example.com/plan", planNumber: "123"
      });
    };
    // November: 9/22 => 29%, 1/0 => insufficient, 0/10 => exactly threshold.
    add("2026-11", "Альфа", "won", 9, 100);
    add("2026-11", "Альфа", "lost", 22, 200);
    add("2026-11", "Альфа", "open", 2, 300);
    add("2026-11", "Альфа", "cancelled", 20, 400);
    add("2026-11", "Альфа", "published", 20, 500);
    add("2026-11", "Бета", "won", 1, 100);
    add("2026-11", "Гамма", "lost", 10, 200);
    add("2026-10", "Альфа", "won", 4, 700);
    add("2026-10", "Альфа", "lost", 1, 300);
    add("2026-09", "Альфа", "won", 10, 0);
  }
  const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
  p.plans = buildPlansMonitorView(deals, { asOfDate: "2026-11-10" });
  return p;
}
async function withPage(width: number, run: (page: Page) => Promise<void>, payload = fixture()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-win-share-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.setDefaultTimeout(5000);
    await page.route("https://fonts.googleapis.com/**", r => r.abort());
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, renderPultHtml(payload));
    await page.goto(pathToFileURL(file).href);
    await run(page);
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

it.each([1440, 375])("доля побед менеджеров и итога, смена месяца на обеих страницах, %s px", async width => {
  await withPage(width, async page => {
    for (const tab of ["plans-ip", "plans-kt"]) {
      await page.locator(`[data-t="${tab}"]`).click();
      await page.locator('#planMonths [data-month="2026-11"]').click();
      const pane = page.locator(`#tab-${tab}`);
      const managers = pane.locator(".share");
      const alpha = managers.locator("summary.r").filter({ hasText: "Вымышленный Альфа" });
      const beta = managers.locator(".r").filter({ hasText: "Вымышленный Бета" });
      const gamma = managers.locator(".r").filter({ hasText: "Вымышленный Гамма" });
      expect(await alpha.locator(".plan-win-share").textContent()).toBe("29%");
      expect(await alpha.locator(".plan-win-share .hbar > span").getAttribute("style")).toContain("width:29%");
      expect(await beta.locator(".plan-win-share").textContent()).toBe("мало итогов");
      expect(await beta.locator(".plan-win-share .hbar").count()).toBe(0);
      expect(await gamma.locator(".plan-win-share").textContent()).toBe("0%");
      expect(await gamma.locator(".hbar > span").getAttribute("style")).toContain("width:0%");
      expect(await alpha.locator(".plan-win-counts .plan-win-desktop").textContent()).toBe("9 / 22");
      expect(await managers.locator(".r.head > span").allTextContents()).toEqual([
        "Место", "Менеджер", "Доля побед", "Выиграл / Проиграл", "Сумма", "Шт. / В работе / Новых"
      ]);
      expect(await managers.textContent()).toContain("Доля побед — выигранные (F3 и партнёр) из закупок с известным итогом; показывается от 10 итогов");
      // Sorting and expansion remain intact.
      expect(await managers.locator(".nm").allTextContents()).toEqual(["Вымышленный Альфа", "Вымышленный Гамма", "Вымышленный Бета"]);
      await alpha.click();
      expect(await managers.locator("details[open] .plan-list-row").count()).toBe(2);
      const tile = pane.locator(".plans-outcomes .plan-win-total");
      expect(await tile.locator(".v").textContent()).toBe("24%по сумме 14% · из 42 с итогом");
      expect(await pane.locator(".plans-outcomes > div > .label").allTextContents()).toEqual([
        "Забрали мы (F3 + партнёр)", "Ушло конкурентам", "Доля побед", "Отменено / изменено", "Новые за 7 дней"
      ]);
      expect(await pane.locator(".readout:not(.plans-outcomes) .label").allTextContents()).toEqual([
        "В работе", "Ждут разбора (стадия «Новая»)", "Опубликовано / Договор"
      ]);
      if (width === 1440) {
        expect(await alpha.locator(".plan-win-counts").innerText()).toBe("9 / 22");
        const boxes = await pane.locator(".plans-outcomes > div").evaluateAll(els => els.map(el => ({ top: el.getBoundingClientRect().top, left: el.getBoundingClientRect().left })));
        expect(boxes[0].top).toBe(boxes[2].top);
        expect(boxes[3].top).toBeGreaterThan(boxes[0].top);
        expect(boxes[3].left).toBe(boxes[0].left);
      } else {
        expect(await alpha.locator(".plan-win-share").evaluate(el => getComputedStyle(el, "::before").content)).toContain("доля побед");
        expect(await alpha.locator(".plan-win-counts").innerText()).toBe("выиграл 9 · проиграл 22");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await page.locator('#planMonths [data-month="2026-10"]').click();
      expect(await tile.locator(".v").textContent()).toBe("мало итоговиз 5 с итогом");
      expect(await managers.locator(".plan-win-share").textContent()).toBe("мало итогов");
      expect(await managers.locator(".plan-win-share .hbar").count()).toBe(0);
      await page.locator('#planMonths [data-month="2026-09"]').click();
      expect(await managers.locator(".plan-win-share").textContent()).toBe("100%");
      expect(await tile.locator(".v").textContent()).toBe("100%из 10 с итогом");
      await page.locator('#planMonths [data-month="all"]').click();
      expect(await tile.locator(".v").textContent()).toBe("42%по сумме 36% · из 57 с итогом");
    }
  });
}, 60000);

it("полоски доли побед имеют одинаковую ширину при 9% и 92% на 1440 px", async () => {
  const payload = fixture();
  for (const group of [payload.plans!.ip!, payload.plans!.kt!]) {
    Object.assign(group.monthViews.all.managers[0], { wonCount: 9, lostCount: 91 });
    Object.assign(group.monthViews.all.managers[1], { wonCount: 92, lostCount: 8 });
  }
  await withPage(1440, async page => {
    for (const tab of ["plans-ip", "plans-kt"]) {
      await page.locator(`[data-t="${tab}"]`).click();
      const shares = page.locator(`#tab-${tab} .share .plan-win-share`);
      expect(await shares.nth(0).textContent()).toBe("9%");
      expect(await shares.nth(1).textContent()).toBe("92%");
      const widths = await shares.locator(".hbar").evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
      expect(widths[0]).toBeGreaterThan(0);
      expect(widths[0]).toBeCloseTo(widths[1], 5);
    }
  }, payload);
});
