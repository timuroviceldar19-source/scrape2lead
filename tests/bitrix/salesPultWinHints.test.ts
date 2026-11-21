import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import type { NormalizedPlanDeal } from "../../src/bitrix/salesPult/plans/types.js";
import type { RadarCard } from "../../src/bitrix/salesPult/radar/types.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { buildCompetitorsView } from "../../src/kz/competitors/aggregate.js";
import { loadCompetitorsConfig } from "../../src/kz/competitors/config.js";
import type { CompetitorBid, CompetitorLot } from "../../src/kz/competitors/types.js";

const asOfDate = "2026-11-21";
const deal: NormalizedPlanDeal = {
  id: "1", dealUrl: "https://example.com/deal/1", planNumber: "123", planUrl: "",
  month: "2026-11", customerName: "Школа «Макет»", customerBin: "000000000001",
  itemName: 'Панель 75"', truCode: "", kind: "Интерактивные панели", qty: 2,
  price: 120000, sum: 240000, method: "Конкурс", portalStatus: "Утвержден",
  managerName: "Тестовый менеджер", isNewStage: true, outcomeCategory: "open",
  group: "ИП", managerId: "s", dateCreate: "2026-11-01", outcomeKey: "",
  isOpen: true, isWonCrm: false, isLostCrm: false
};
const otherDeal: NormalizedPlanDeal = {
  ...deal, id: "3", dealUrl: "https://example.com/deal/3", managerId: "t", month: "2026-12", customerBin: "000000000003",
  itemName: 'Панель 86"', price: 0, sum: 80000, isNewStage: false
};
const planDeals: NormalizedPlanDeal[] = [deal, otherDeal, {
  ...deal, id: "2", planNumber: "124", customerName: "Старое название школы",
  isOpen: false, outcomeCategory: "lost", lostTo: { bin: "000000000002", name: "ТОО Макет", contractSum: 211200 }
}, {
  ...deal, id: "4", customerName: "Прежнее название школы", isOpen: false, outcomeCategory: "won"
}];
const plans = buildPlansMonitorView(planDeals, { asOfDate, formerManagerIds: ["s"] });

function sample() {
  const { payload, register } = fixture();
  const card: RadarCard = {
    ...deal, id: "10", sourceType: "lot", lotNumber: "900-1", title: deal.itemName,
    status: "Обсуждение", startAt: null, endAt: null, hoursLeft: 8, column: "discussion",
    isToday: false, isWithin48h: true
  };
  const kpis = { totalCount: 1, totalSum: deal.sum, submitCount: 0, submitSum: 0,
    discussionCount: 1, discussionSum: deal.sum, secondChanceCount: 0, secondChanceSum: 0 };
  const lot = { customerBin: deal.customerBin, customerName: "Старое название школы", lotNumber: "800-1", annoId: "800" };
  const market = { kinds: [{ kind: "Интерактивные панели", med: 85000, usMed: 80000 }] };
  Object.assign(payload, {
    asOfDate, plans, market: { ip: market },
    radar: { asOf: asOfDate, ip: { group: "ИП", kpis, discussion: [card], submitToday: [], secondChance: [] } },
    competitors: { ip: {
      competitors: [{ bin: "000000000002", name: "ТОО Макет", us: false,
        lotList: [{ ...lot, isWinner: true, discountPct: 12 }] }],
      headToHead: [{ lots: [{ ...lot, rivalWon: true, winnerBin: "000000000002", winnerName: "ТОО Макет" }] }],
      specTemplates: [
        { templateName: "Макет прошлых лет", winners: [{ name: "ТОО Макет", sharePct: 60 }],
          lots: [{ ...lot, strength: "strong" }] },
        { templateName: "Макет из объявления", winners: [{ name: "ТОО Образец", sharePct: 80 }],
          lots: [{ lotNumber: card.lotNumber, strength: "partial" }] }
      ],
      prices: { rows: [
        { label: 'Панель 65"', compWinner: { med: 60000 } },
        { label: 'Панель 75"', compWinner: { med: 100000 } },
        { label: 'Панель 86"', ourWinner: { med: 90000 } }
      ] }
    } }
  } satisfies Partial<Record<keyof SalesPultPayload, unknown>>);
  return { payload, reg: { asOfDate, generatedAt: payload.generatedAt, register }, planDeals };
}

it("сохраняет БИН в истории и помечает только открытые планы ушедшего менеджера", () => {
  expect(plans.ip!.lostTo.competitors[0].deals[0]).toHaveProperty("customerBin", deal.customerBin);
  expect(plans.ip!.openPlans[0]).toHaveProperty("isFormerManager", true);
  expect(plans.ip!.openPlans[1].isFormerManager).toBeUndefined();
  expect(plans.ip!.wonCustomers).toContainEqual({ bin: deal.customerBin, name: "Прежнее название школы" });
});

it("передаёт БИН в лоты таблицы конкурентов, очных встреч и шаблонов ТС", () => {
  const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
  const [template] = cfg.templates.templates;
  const [ourBin] = cfg.ourBins;
  const lot: CompetitorLot = {
    annoId: "800", annoNumber: "800-1", annoName: "Учебный макет", lotNumber: "800-1", lotName: deal.itemName,
    enstruCode: "", group: "ИП", kind: "Интерактивная панель", diagonal: '75"', cpu: "",
    isCombinedLot: false, isKit: false, isLatestVersion: true, status: "Закупка состоялась",
    startDate: "2026-11-01", endDate: "2026-11-06", customerBin: deal.customerBin, customerName: deal.customerName,
    qty: 2, plannedUnitPriceNoVat: 120000, plannedSumNoVat: 240000, numSubmitted: 2, numAdmitted: 2,
    winnerBin: "000000000002", winnerName: "ТОО Макет", winnerIsOurs: "",
    winnerBidUnitPriceNoVat: 105600, winnerBidTotalPriceNoVat: 211200, winnerDiscountFromPlanPct: 12,
    winnerCondDiscountPct: null, secondBin: "", secondName: "", failureReason: "", lotUrl: "", annoUrl: "",
    protocolUrl: "", techspecUrl: "", hasTechspec: true, hasItogi: true
  };
  const bid: CompetitorBid = {
    annoId: lot.annoId, lotNumber: lot.lotNumber, isLatestLotVersion: true, group: lot.group, kind: lot.kind,
    diagonal: lot.diagonal, cpu: "", isCombinedLot: false, isKit: false, startDate: lot.startDate,
    lotStatus: lot.status, plannedQty: lot.qty, plannedUnitPriceNoVat: lot.plannedUnitPriceNoVat,
    plannedSumNoVat: lot.plannedSumNoVat, bidderBin: lot.winnerBin, bidderName: lot.winnerName, ourCompany: "",
    admittedStatus: "Допущен", rejectionShort: "", rejectionDetail: "", bidUnitPriceNoVat: 105600,
    bidTotalPriceNoVat: 211200, discountFromPlanPct: 12, condDiscountPct: null, otpKtpPct: 0,
    condPriceNoVat: 211200, isWinner: true, isSecondPlace: false
  };
  const view = buildCompetitorsView({
    lots: [lot], bids: [bid, { ...bid, bidderBin: ourBin, bidderName: "Тестовый поставщик", isWinner: false }],
    templateMatches: [{ templateId: template.id, templateName: template.name, note: "", annoId: lot.annoId,
      lotNumber: lot.lotNumber, strength: "strong", share: 0.8, matchedPhrases: [], coreMatchesCount: 0 }],
    asOfDate, updatedAt: asOfDate, cfg
  }).ip!;
  expect(view.competitors.find(c => c.bin === lot.winnerBin)?.lotList[0]).toHaveProperty("customerBin", deal.customerBin);
  expect(view.headToHead[0].lots[0]).toMatchObject({ customerBin: deal.customerBin, winnerDiscountPct: 12 });
  expect(view.specTemplates[0].lots[0]).toHaveProperty("customerBin", deal.customerBin);
});

it.each([375, 1440])("подсказки, фильтры, поиск и копирование в Планах на %s px", async width => {
  const browser = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-hints-plans-"));
  try {
    const { payload } = sample();
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, renderPultHtml(payload));
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route("https://fonts.googleapis.com/**", route => route.abort());
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { document.body.dataset.copied = text; } } });
    });
    await page.goto(pathToFileURL(file).href + "#plans-ip");
    const row = page.locator('[data-plan-id="1"]');
    const cells = row.getByRole("cell");
    expect(await cells.nth(1).innerText()).toMatch(/ТОО Макет · 2× · −12%/);
    expect(await cells.nth(1).innerText()).toContain("покупал у нас");
    expect(await cells.nth(1).innerText()).toContain("Шаблон ТС: Макет прошлых лет · побеждал ТОО Макет (60%)");
    expect(await cells.nth(1).innerText()).toContain("сильное совпадение");
    expect(await cells.nth(2).innerText()).not.toContain("·");
    expect(await cells.nth(4).locator(".good").innerText()).toMatch(/победы ~100\s000/);
    expect(await cells.nth(6).innerText()).toContain("Ушедший · переназначить");
    const other = page.locator('[data-plan-id="3"]');
    expect(await other.getByRole("cell").nth(1).innerText()).not.toMatch(/покупал у нас|Шаблон ТС|ТОО Макет/);
    expect(await other.getByRole("cell").nth(4).locator(".bad").innerText()).toMatch(/~40\s000\/шт · победы ~90\s000/);
    const quick = page.locator(".plan-quick-filters");
    for (const name of [/Новая · ждёт разбора \(1\)/, /Ушедшие — переназначить \(1\)/,
      /Месяц наступил\/прошёл \(1\)/, /Риск ТС \/ конкурента \(1\)/]) {
      await quick.getByRole("button", { name }).click();
      expect(await page.locator("[data-plan-id]").count()).toBe(1);
    }
    const input = page.locator(".plan-search-input");
    await input.fill('Панель 86"');
    expect(await quick.locator('[data-plan-quick="risk"]').isVisible()).toBe(true);
    expect(await quick.locator('[data-plan-quick="risk"]').getAttribute("aria-pressed")).toBe("true");
    await input.fill("");
    await quick.getByRole("button", { name: "Все", exact: true }).click();
    expect(await page.locator("[data-plan-id]").count()).toBe(2);
    const original = await input.elementHandle();
    await input.fill("Пане");
    await page.keyboard.insertText('ль 75"');
    expect(await input.evaluate((node, previous) => node === previous && document.activeElement === node, original)).toBe(true);
    expect(await page.locator("[data-plan-id]").count()).toBe(1);
    await page.getByRole("button", { name: "Скопировать выборку для чата" }).click();
    const copied = await page.locator("body").getAttribute("data-copied");
    expect(copied).toContain(deal.dealUrl);
    expect(copied).toMatch(/240\s000 ₸/);
    expect(copied).not.toContain(otherDeal.dealUrl);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 375) {
      expect(await input.evaluate(el => getComputedStyle(el).fontSize)).toBe("16px");
      expect(await quick.evaluate(el => getComputedStyle(el).overflowX)).toBe("auto");
      expect(await page.locator(".plans-outcomes").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(2);
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.each([375, 1440])("Радар и вариант менеджера на %s px", async width => {
  const browser = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-hints-radar-"));
  try {
    const { payload, reg, planDeals } = sample();
    const fullFile = path.join(dir, "index.html");
    const managerFile = path.join(dir, "manager.html");
    fs.writeFileSync(fullFile, renderPultHtml(payload));
    const manager = buildManagerVariant({ pult: payload, reg, planDeals, managerId: "s" })!;
    fs.writeFileSync(managerFile, renderManagerVariant(manager).index);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route("https://fonts.googleapis.com/**", route => route.abort());
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(pathToFileURL(fullFile).href + "#radar-ip");
    const card = page.locator('[data-col="discussion"] .radar-card');
    expect(await card.innerText()).toContain("Шаблон ТС: Макет из объявления · побеждал ТОО Образец (80%)");
    expect(await card.innerText()).toContain("ТОО Макет · 2× · −12%");
    expect(await card.innerText()).toMatch(/~120\s000\/шт · победы ~100\s000/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 375) {
      expect(await page.locator(".radar-search-input").evaluate(el => getComputedStyle(el).fontSize)).toBe("16px");
      expect(await page.locator(".radar-filter-group .chips").first().evaluate(el => getComputedStyle(el).overflowX)).toBe("auto");
    }
    await page.goto(pathToFileURL(managerFile).href + "#plans-ip");
    expect(await page.evaluate(() => (0, eval)("PAYLOAD.competitors"))).toBeNull();
    expect(await page.evaluate(() => (0, eval)("PAYLOAD.radar.ip.discussion.map(c => c.managerId)"))).toEqual(["s"]);
    expect(await page.locator("[data-plan-id]").count()).toBe(1);
    const row = page.locator('[data-plan-id="1"]');
    expect(await row.innerText()).toMatch(/победы ~85\s000/);
    expect(await row.innerText()).toContain("ТОО Макет · 1× · −12%");
    expect(await row.innerText()).not.toContain("Шаблон ТС");
    expect(await page.content()).not.toContain("Макет из объявления");
    // Свой «Радар» менеджера: цена по «Рынку», без шаблонов ТС из «Конкурентов».
    await page.goto(pathToFileURL(managerFile).href + "#radar-ip");
    const own = page.locator('[data-col="discussion"] .radar-card');
    expect(await own.innerText()).toMatch(/~120\s000\/шт · победы ~85\s000/);
    expect(await own.innerText()).not.toContain("Шаблон ТС");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
