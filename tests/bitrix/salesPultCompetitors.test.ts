import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { loadCompetitorsConfig } from "../../src/kz/competitors/config.js";
import { buildCompetitorsView } from "../../src/kz/competitors/aggregate.js";
import type { CompetitorBid, CompetitorLot, LotTemplateMatch } from "../../src/kz/competitors/types.js";
import { renderPultHtml, type RegisterPagePayload, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";

// Все названия, БИН и суммы в этом файле выдуманные.

function buildSampleCompetitors() {
  const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
  const ourBin = [...cfg.ourBins][0];
  const partnerBin = [...cfg.partnerBins][0];
  const ourName = cfg.ourCompanyNames[ourBin] || "F3";
  const partnerName = cfg.ourCompanyNames[partnerBin] || "Amanat Asia";

  const lots: CompetitorLot[] = [
    {
      annoId: "9001", annoNumber: "9001-1", annoName: "Панель", lotNumber: "L-9001",
      lotName: "Панель интерактивная 75", enstruCode: "262030.100.000021",
      group: "ИП", kind: "Интерактивная панель", diagonal: '75"', cpu: "",
      isCombinedLot: false, isKit: false, isLatestVersion: true,
      status: "Закупка состоялась", startDate: "2026-05-10", endDate: "2026-05-20",
      customerBin: "777777777777", customerName: "КГУ «Тестовая школа №5»",
      qty: 2, plannedUnitPriceNoVat: 1200000, plannedSumNoVat: 2400000,
      numSubmitted: 3, numAdmitted: 2,
      winnerBin: "333333333333", winnerName: "ТОО «Соперник Альфа»", winnerIsOurs: "",
      winnerBidUnitPriceNoVat: 1100000, winnerBidTotalPriceNoVat: 2200000,
      winnerDiscountFromPlanPct: 8.33, winnerCondDiscountPct: 4,
      secondBin: ourBin, secondName: ourName, failureReason: "",
      lotUrl: "https://procurement.gov.kz/ru/announce/index/9001",
      annoUrl: "https://procurement.gov.kz/ru/announce/index/9001",
      protocolUrl: "", techspecUrl: "https://v3bl.goszakup.gov.kz/files/download_file/1/2/",
      hasTechspec: true, hasItogi: true
    },
    {
      annoId: "9002", annoNumber: "9002-1", annoName: "Комплект", lotNumber: "L-9002",
      lotName: "Учебный комплект", enstruCode: "329959.900.000019",
      group: "ИП", kind: "Учебный комплект", diagonal: "", cpu: "",
      isCombinedLot: false, isKit: true, isLatestVersion: true,
      status: "Закупка состоялась", startDate: "2026-06-11", endDate: "2026-06-21",
      customerBin: "888888888888", customerName: "ГККП «Тестовый колледж»",
      qty: 1, plannedUnitPriceNoVat: 4000000, plannedSumNoVat: 4000000,
      numSubmitted: 1, numAdmitted: 1,
      winnerBin: ourBin, winnerName: ourName, winnerIsOurs: ourName,
      winnerBidUnitPriceNoVat: 3800000, winnerBidTotalPriceNoVat: 3800000,
      winnerDiscountFromPlanPct: 5, winnerCondDiscountPct: 2,
      secondBin: "", secondName: "", failureReason: "",
      lotUrl: "https://procurement.gov.kz/ru/announce/index/9002",
      annoUrl: "https://procurement.gov.kz/ru/announce/index/9002",
      protocolUrl: "", techspecUrl: "", hasTechspec: false, hasItogi: true
    },
    {
      annoId: "9003", annoNumber: "9003-1", annoName: "Ноутбуки", lotNumber: "L-9003",
      lotName: "Ноутбук", enstruCode: "262011.100.000001",
      group: "КТ", kind: "Ноутбук", diagonal: "", cpu: "Core i5",
      isCombinedLot: false, isKit: false, isLatestVersion: true,
      status: "Закупка состоялась", startDate: "2026-05-12", endDate: "2026-05-22",
      customerBin: "999999999999", customerName: "ГУ «Тестовый акимат»",
      qty: 5, plannedUnitPriceNoVat: 450000, plannedSumNoVat: 2250000,
      numSubmitted: 2, numAdmitted: 2,
      winnerBin: "444444444444", winnerName: "ТОО «Соперник Бета»", winnerIsOurs: "",
      winnerBidUnitPriceNoVat: 400000, winnerBidTotalPriceNoVat: 2000000,
      winnerDiscountFromPlanPct: 11.11, winnerCondDiscountPct: 1,
      secondBin: partnerBin, secondName: partnerName, failureReason: "",
      lotUrl: "https://procurement.gov.kz/ru/announce/index/9003",
      annoUrl: "https://procurement.gov.kz/ru/announce/index/9003",
      protocolUrl: "", techspecUrl: "", hasTechspec: false, hasItogi: true
    }
  ];

  const bids: CompetitorBid[] = [
    {
      annoId: "9001", lotNumber: "L-9001", isLatestLotVersion: true,
      group: "ИП", kind: "Интерактивная панель", diagonal: '75"', cpu: "",
      isCombinedLot: false, isKit: false, startDate: "2026-05-10", lotStatus: "Закупка состоялась",
      plannedQty: 2, plannedUnitPriceNoVat: 1200000, plannedSumNoVat: 2400000,
      bidderBin: "333333333333", bidderName: "ТОО «Соперник Альфа»", ourCompany: "",
      admittedStatus: "Допущен", rejectionShort: "", rejectionDetail: "",
      bidUnitPriceNoVat: 1100000, bidTotalPriceNoVat: 2200000,
      discountFromPlanPct: 8.33, condDiscountPct: 4, otpKtpPct: 2, condPriceNoVat: 2112000,
      isWinner: true, isSecondPlace: false
    },
    {
      annoId: "9001", lotNumber: "L-9001", isLatestLotVersion: true,
      group: "ИП", kind: "Интерактивная панель", diagonal: '75"', cpu: "",
      isCombinedLot: false, isKit: false, startDate: "2026-05-10", lotStatus: "Закупка состоялась",
      plannedQty: 2, plannedUnitPriceNoVat: 1200000, plannedSumNoVat: 2400000,
      bidderBin: ourBin, bidderName: ourName, ourCompany: ourName,
      admittedStatus: "Допущен", rejectionShort: "", rejectionDetail: "",
      bidUnitPriceNoVat: 1080000, bidTotalPriceNoVat: 2160000,
      discountFromPlanPct: 10, condDiscountPct: 0, otpKtpPct: 0, condPriceNoVat: 2160000,
      isWinner: false, isSecondPlace: true
    },
    {
      annoId: "9001", lotNumber: "L-9001", isLatestLotVersion: true,
      group: "ИП", kind: "Интерактивная панель", diagonal: '75"', cpu: "",
      isCombinedLot: false, isKit: false, startDate: "2026-05-10", lotStatus: "Закупка состоялась",
      plannedQty: 2, plannedUnitPriceNoVat: 1200000, plannedSumNoVat: 2400000,
      bidderBin: partnerBin, bidderName: partnerName, ourCompany: partnerName,
      admittedStatus: "Отклонен", rejectionShort: "Нет авторизационного письма", rejectionDetail: "Не приложено письмо",
      bidUnitPriceNoVat: 1020000, bidTotalPriceNoVat: 2040000,
      discountFromPlanPct: 15, condDiscountPct: null, otpKtpPct: 0, condPriceNoVat: null,
      isWinner: false, isSecondPlace: false
    },
    {
      annoId: "9002", lotNumber: "L-9002", isLatestLotVersion: true,
      group: "ИП", kind: "Учебный комплект", diagonal: "", cpu: "",
      isCombinedLot: false, isKit: true, startDate: "2026-06-11", lotStatus: "Закупка состоялась",
      plannedQty: 1, plannedUnitPriceNoVat: 4000000, plannedSumNoVat: 4000000,
      bidderBin: ourBin, bidderName: ourName, ourCompany: ourName,
      admittedStatus: "Допущен", rejectionShort: "", rejectionDetail: "",
      bidUnitPriceNoVat: 3800000, bidTotalPriceNoVat: 3800000,
      discountFromPlanPct: 5, condDiscountPct: 2, otpKtpPct: 2, condPriceNoVat: 3724000,
      isWinner: true, isSecondPlace: false
    },
    {
      annoId: "9003", lotNumber: "L-9003", isLatestLotVersion: true,
      group: "КТ", kind: "Ноутбук", diagonal: "", cpu: "Core i5",
      isCombinedLot: false, isKit: false, startDate: "2026-05-12", lotStatus: "Закупка состоялась",
      plannedQty: 5, plannedUnitPriceNoVat: 450000, plannedSumNoVat: 2250000,
      bidderBin: "444444444444", bidderName: "ТОО «Соперник Бета»", ourCompany: "",
      admittedStatus: "Допущен", rejectionShort: "", rejectionDetail: "",
      bidUnitPriceNoVat: 400000, bidTotalPriceNoVat: 2000000,
      discountFromPlanPct: 11.11, condDiscountPct: 1, otpKtpPct: 0, condPriceNoVat: 1980000,
      isWinner: true, isSecondPlace: false
    }
  ];

  const matches: LotTemplateMatch[] = [
    {
      annoId: "9001", lotNumber: "L-9001", templateId: "demo",
      templateName: "Шаблон «Демо» (выдуманный)",
      note: "выдуманная пометка для тестов",
      share: 0.78, strength: "strong", matchedPhrases: ["полив по лунному календарю"], coreMatchesCount: 2
    }
  ];

  return buildCompetitorsView({
    lots, bids, templateMatches: matches,
    asOfDate: "2026-11-16", updatedAt: "2026-11-10", cfg
  });
}

function payloadWithCompetitors(): SalesPultPayload {
  const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
  p.competitors = buildSampleCompetitors();
  return p;
}

describe("Вкладка «Конкуренты» в браузере и варианте менеджера", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  for (const width of [1440, 375]) {
    it(`renders all 7 blocks, switches ИП/КТ and months without horizontal scroll at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.setContent(renderPultHtml(payloadWithCompetitors()));
        await page.locator('.sections [data-t="competitors"]').click();

        const paneIp = page.locator("#tab-competitors-ip");
        expect(await paneIp.getAttribute("class")).toContain("on");
        expect(await page.locator("#productSwitch").isVisible()).toBe(true);
        expect(await page.locator("#competitorsMonths").isVisible()).toBe(true);

        // Список «Наших отклонений» свёрнут под <details> (сводка — в «Потерях по причинам»)
        await paneIp.locator("details.comp-rej-d > summary").click();
        const textIp = await paneIp.innerText();
        expect(textIp).toContain("Потери по причинам");
        expect(textIp).toContain("Итоги");
        expect(textIp).toContain("Конкуренты");
        expect(textIp).toContain("Где мы встречались");
        expect(textIp).toContain("Наши отклонения");
        expect(textIp).toContain("Цены");
        expect(textIp).toContain("Шаблоны ТС");
        expect(textIp).toContain("Соперник Альфа");
        expect(textIp).toContain("цена ниже победителя");
        expect(textIp).toContain("Шаблон «Демо»");
        expect(textIp).toContain("Данные конкурентов не обновлены");

        // Expand competitor row
        await paneIp.locator(".comp-table details.cust-d > summary").first().click();
        expect(await paneIp.locator(".comp-table details.cust-d[open]").count()).toBe(1);

        // Switch month
        await page.locator('#competitorsMonths button[data-month="2026-05"]').click();
        expect(await page.evaluate(() => location.hash)).toBe("#competitors-ip/2026-05");
        expect(await paneIp.locator('[data-comp-lots]').getAttribute("data-comp-lots")).toBe("1");

        // Switch to КТ
        await page.locator('#productSwitch [data-product="kt"]').click();
        const paneKt = page.locator("#tab-competitors-kt");
        expect(await paneKt.getAttribute("class")).toContain("on");
        expect(await paneKt.innerText()).toContain("Соперник Бета");

        // No horizontal overflow
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 25000);
  }

  it("limits Конкуренты and Где мы встречались to 15 rows (+ always our companies) with «показать всех», fixes quotes/0.0%/₸/month labels", async () => {
    const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
    const ourBin = [...cfg.ourBins][0];
    const lots: CompetitorLot[] = [];
    const bids: CompetitorBid[] = [];
    // Create 20 lots across 20 distinct rivals + our company so we rank #19 (beyond 15) and verify F3 stays visible
    for (let i = 1; i <= 20; i++) {
      const bin = String(100000000000 + i);
      const isDoubleQuoted = i === 1;
      const rivalName = isDoubleQuoted ? 'ТОО ""VArMA Tech""' : `ТОО «Соперник ${i}»`;
      const annoId = String(8000 + i);
      const lotNumber = `L-${8000 + i}`;
      const startDate = `2026-0${Math.min(9, ((i - 1) % 9) + 1)}-15`;
      lots.push({
        annoId, annoNumber: `${annoId}-1`, annoName: "Панель", lotNumber,
        lotName: "Панель", enstruCode: "262030.100.000021",
        group: "ИП", kind: "Интерактивная панель", diagonal: '75"', cpu: "",
        isCombinedLot: false, isKit: false, isLatestVersion: true,
        status: "Закупка состоялась", startDate, endDate: startDate,
        customerBin: "777777777777", customerName: "КГУ Тест",
        qty: 1, plannedUnitPriceNoVat: 1000000, plannedSumNoVat: 1000000,
        numSubmitted: 2, numAdmitted: i === 20 ? 1 : 2,
        winnerBin: bin, winnerName: rivalName, winnerIsOurs: "",
        winnerBidUnitPriceNoVat: 900000, winnerBidTotalPriceNoVat: 900000,
        winnerDiscountFromPlanPct: 10, winnerCondDiscountPct: 1,
        secondBin: "", secondName: "", failureReason: "",
        lotUrl: `https://procurement.gov.kz/ru/announce/index/${annoId}`,
        annoUrl: `https://procurement.gov.kz/ru/announce/index/${annoId}`,
        protocolUrl: "", techspecUrl: "", hasTechspec: false, hasItogi: true
      });
      // Rival wins higher sums for i=1..19 (i=1 won 20 lots' worth)
      bids.push({
        annoId, lotNumber, isLatestLotVersion: true,
        group: "ИП", kind: "Интерактивная панель", diagonal: '75"', cpu: "",
        isCombinedLot: false, isKit: false, startDate, lotStatus: "Закупка состоялась",
        plannedQty: 1, plannedUnitPriceNoVat: 1000000, plannedSumNoVat: 1000000,
        bidderBin: bin, bidderName: rivalName, ourCompany: "",
        admittedStatus: "Допущен", rejectionShort: "", rejectionDetail: "",
        bidUnitPriceNoVat: 900000, bidTotalPriceNoVat: i === 20 ? 900000 : 900000 * (22 - i),
        discountFromPlanPct: 10, condDiscountPct: 1, otpKtpPct: 0, condPriceNoVat: 891000,
        isWinner: true, isSecondPlace: false
      });
      bids.push({
        annoId, lotNumber, isLatestLotVersion: true,
        group: "ИП", kind: "Интерактивная панель", diagonal: '75"', cpu: "",
        isCombinedLot: false, isKit: false, startDate, lotStatus: "Закупка состоялась",
        plannedQty: 1, plannedUnitPriceNoVat: 1000000, plannedSumNoVat: 1000000,
        bidderBin: ourBin, bidderName: cfg.ourCompanyNames[ourBin] || "F3", ourCompany: "F3",
        admittedStatus: "Отклонен", rejectionShort: "Нет письма", rejectionDetail: "Детали",
        bidUnitPriceNoVat: 900000, bidTotalPriceNoVat: 900000,
        discountFromPlanPct: 10, condDiscountPct: null, otpKtpPct: 0, condPriceNoVat: null,
        isWinner: false, isSecondPlace: false
      });
    }

    const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
    p.competitors = buildCompetitorsView({ lots, bids, templateMatches: [], asOfDate: "2026-11-16", updatedAt: "2026-11-16", cfg });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.setContent(renderPultHtml(p));
      await page.goto("about:blank");
      await page.setContent(renderPultHtml(p));
      await page.evaluate(() => { location.hash = "#competitors-ip"; });
      await page.waitForSelector("#tab-competitors-ip.on .comp-hero");

      const pane = page.locator("#tab-competitors-ip");
      await pane.locator("details.comp-rej-d > summary").click();
      const text = await pane.innerText();
      // Quote normalization
      expect(text).toContain('ТОО "VArMA Tech"');
      expect(text).not.toContain('""VArMA Tech""');
      // Equal price phrasing instead of 0,0%
      expect(text).toContain("равна цене победителя");
      expect(text).not.toContain("на 0,0%");
      // Non-breaking space before tenge symbol in HTML
      const html = await pane.innerHTML();
      expect(html.includes("&nbsp;₸") || html.includes("\u00a0₸")).toBe(true);

      // Top 15 + F3 always visible even if outside top 15
      const initialCompRows = await pane.locator(".comp-table details.cust-d").count();
      expect(initialCompRows).toBe(16); // 15 rivals + F3
      expect(await pane.locator(".comp-table details.cust-d summary.us").count()).toBe(1);

      // Expand button shows all 21 rows
      await pane.locator('[data-comp-more="competitors"]').click();
      expect(await pane.locator(".comp-table details.cust-d").count()).toBe(21);

      // Head-to-head initially 15 rows + expand button shows all 20
      expect(await pane.locator(".comp-h2h details.cust-d").count()).toBe(15);
      await pane.locator('[data-comp-more="h2h"]').click();
      expect(await pane.locator(".comp-h2h details.cust-d").count()).toBe(20);

      // Month labels stay inside chart bounds
      const labelOverflow = await page.evaluate(() => {
        const chart = document.querySelector("#tab-competitors-ip .comp-chart")?.getBoundingClientRect();
        if (!chart) return true;
        return [...document.querySelectorAll("#tab-competitors-ip .comp-chart .mlabels span")].some((el) => {
          const r = el.getBoundingClientRect();
          return r.right > chart.right + 2 || r.left < chart.left - 2;
        });
      });
      expect(labelOverflow).toBe(false);
    } finally {
      await page.close();
    }
  }, 20000);

  it("hides «Конкуренты» from manager variant (payload, index.html, reg.html)", async () => {
    const f = fixture();
    f.payload.competitors = buildSampleCompetitors();
    const reg: RegisterPagePayload = {
      asOfDate: f.payload.asOfDate,
      generatedAt: f.payload.generatedAt,
      portal: "https://example.invalid",
      register: f.register
    };
    const variant = buildManagerVariant({ pult: f.payload, reg, planDeals: [], managerId: "s", aliases: f.aliases })!;
    expect(variant.pult.competitors).toBeNull();
    expect(JSON.stringify(variant)).not.toContain("Соперник Альфа");

    const rendered = renderManagerVariant(variant);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.setContent(rendered.index);
      expect(await page.locator('.sections a[data-t="competitors"]').count()).toBe(0);
      await page.evaluate(() => { location.hash = "#competitors-ip"; });
      await page.waitForTimeout(150);
      expect(await page.locator("#tab-pult").getAttribute("class")).toContain("on");

      await page.setContent(rendered.reg);
      expect(await page.locator('a[href="./#competitors-ip"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 20000);
});
