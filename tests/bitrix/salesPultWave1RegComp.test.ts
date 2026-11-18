import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { renderPultHtml, renderRegisterHtml, type RegisterPagePayload, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";
import { buildRegisterView } from "../../src/bitrix/salesPult/register/buildView.js";
import type { RegisterContract, RegisterRow } from "../../src/bitrix/salesPult/register/types.js";
import { buildManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { loadCompetitorsConfig } from "../../src/kz/competitors/config.js";
import { buildCompetitorsView } from "../../src/kz/competitors/aggregate.js";
import type { CompetitorBid, CompetitorLot } from "../../src/kz/competitors/types.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";

// Все названия, БИН и суммы в этом файле выдуманные.

function makeRow(manager: string, customer: string, sale: number, date = "2026-10-20"): RegisterRow {
  return {
    date,
    type: "Госзакупки",
    customer,
    qty: 1,
    product: "Интерактивная панель Тест",
    cost: Math.round(sale * 0.7),
    extras: 0,
    sale,
    portal: Math.round(sale * 1.12),
    val: Math.round(sale * 0.3),
    bonusMop: Math.round(sale * 0.02),
    bonusRop: Math.round(sale * 0.005),
    manager,
    note: null,
    group: "ИП",
    kind: "Интерактивная панель",
    channel: "Открытый конкурс"
  };
}

function makeMissing(manager: string, customer: string, sale: number, date = "2026-10-22"): RegisterContract {
  return {
    date,
    customer,
    manager,
    sale,
    val: Math.round(sale * 0.3),
    bonusMop: 10000,
    bonusRop: 2000,
    lines: 1,
    products: ["Панель тест"],
    type: "Госзакупки",
    channel: "Открытый конкурс",
    group: "ИП",
    kind: "Интерактивная панель",
    qty: 1
  };
}

function buildRegisterPayloadWithMismatches(): RegisterPagePayload {
  const rows: RegisterRow[] = [
    makeRow("Алия", "Школа Тест 1", 2_000_000, "2026-10-10"),
    makeRow("Алия", "Школа Тест 2", 3_000_000, "2026-10-12"),
    makeRow("Алия", "Школа Тест 3", 1_500_000, "2026-10-14"),
    makeRow("Борис", "Колледж Тест 1", 4_000_000, "2026-10-11"),
    makeRow("Борис", "Колледж Тест 2", 2_500_000, "2026-10-15")
  ];
  const missing: RegisterContract[] = [
    makeMissing("Алия", "Школа Тест 2", 3_000_000, "2026-10-12"),
    makeMissing("Алия", "Школа Тест 3", 1_500_000, "2026-10-14")
  ];
  const pastRows: RegisterRow[] = [
    makeRow("Алия", "Школа Прошлая 1", 2_200_000, "2026-09-18"),
    makeRow("Борис", "Колледж Прошлый 1", 1_800_000, "2026-09-20")
  ];
  const pastMissing: RegisterContract[] = [
    makeMissing("Алия", "Школа Прошлая 1", 2_200_000, "2026-09-18")
  ];
  const pastView = buildRegisterView({
    fileName: "ОП 30.09.26.xlsx",
    asOf: "2026-09-30",
    month: "2026-09",
    rows: pastRows,
    plans: { Алия: 5_000_000, Борис: 5_000_000, B2B: 1_000_000 },
    missing: pastMissing,
    extraDealsCount: 0
  });
  if (pastView.error !== undefined) throw new Error(pastView.error);
  const { history: _h, historyError: _he, error: _e, ...pastSnapshot } = pastView;

  const currentView = buildRegisterView({
    fileName: "ОП 28.10.26.xlsx",
    asOf: "2026-10-28",
    month: "2026-10",
    rows,
    plans: { Алия: 6_000_000, Борис: 6_000_000, B2B: 1_000_000 },
    missing,
    extraDealsCount: 2,
    history: {
      asOf: "2026-10-28",
      months: [
        {
          month: "2026-09",
          label: "Сентябрь 2026",
          fileName: "ОП 30.09.26.xlsx",
          sale: 4_000_000,
          val: 1_200_000,
          margin: 0.3,
          contracts: 2,
          plan: 10_000_000,
          planPct: 40,
          hasVal: true,
          byManager: [
            { name: "Алия", sale: 2_200_000, val: 660_000, margin: 0.3, contracts: 1, plan: 5_000_000, planPct: 44 },
            { name: "Борис", sale: 1_800_000, val: 540_000, margin: 0.3, contracts: 1, plan: 5_000_000, planPct: 36 }
          ],
          missingCrm: pastMissing,
          reconciliationPerformed: true
        },
        {
          month: "2026-10",
          label: "Октябрь 2026",
          fileName: "ОП 28.10.26.xlsx",
          sale: 13_000_000,
          val: 3_900_000,
          margin: 0.3,
          contracts: 5,
          plan: 12_000_000,
          planPct: 108.3,
          hasVal: true,
          byManager: [
            { name: "Алия", sale: 6_500_000, val: 1_950_000, margin: 0.3, contracts: 3, plan: 6_000_000, planPct: 108.3 },
            { name: "Борис", sale: 6_500_000, val: 1_950_000, margin: 0.3, contracts: 2, plan: 6_000_000, planPct: 108.3 }
          ],
          missingCrm: missing,
          reconciliationPerformed: true
        }
      ],
      monthViews: {
        "2026-09": pastSnapshot
      }
    }
  });

  return {
    asOfDate: "2026-10-28",
    generatedAt: "2026-10-28 15:00 (UTC+5)",
    portal: "https://example.invalid",
    register: currentView,
    reconciliation: {
      closedNotInRegister: [
        { dealId: "901", title: "Тестовая сделка 1", manager: "Алия Тестовая", amount: 1_100_000, date: "2026-10-21" }
      ],
      possibleDuplicates: [
        { dealId: "902", title: "Тестовый дубль 2", manager: "Борис Тестовый", registerManager: "Алия" }
      ]
    }
  };
}

function buildSampleCompetitorsPayload(): SalesPultPayload {
  const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
  const ourBin = [...cfg.ourBins][0];
  const ourName = cfg.ourCompanyNames[ourBin] || "F3";
  const rivalBin = "333333333333";
  const rivalName = "ТОО «Соперник Альфа»";

  // 4 admitted bids for rival, 2 wins -> winRateAdmittedPct === 50.0
  const lots: CompetitorLot[] = [1, 2, 3, 4].map((n) => {
    const annoId = String(7000 + n);
    const rivalWon = n <= 2;
    return {
      annoId,
      annoNumber: `${annoId}-1`,
      annoName: `Панель тест ${n}`,
      lotNumber: `L-${annoId}`,
      lotName: "Панель интерактивная 75",
      enstruCode: "262030.100.000021",
      group: "ИП",
      kind: "Интерактивная панель",
      diagonal: '75"',
      cpu: "",
      isCombinedLot: false,
      isKit: false,
      isLatestVersion: true,
      status: "Закупка состоялась",
      startDate: "2026-05-10",
      endDate: "2026-05-20",
      customerBin: "777777777777",
      customerName: `КГУ «Тестовая школа №${n}»`,
      qty: 1,
      plannedUnitPriceNoVat: 1_000_000,
      plannedSumNoVat: 1_000_000,
      numSubmitted: 2,
      numAdmitted: 2,
      winnerBin: rivalWon ? rivalBin : ourBin,
      winnerName: rivalWon ? rivalName : ourName,
      winnerIsOurs: rivalWon ? "" : ourName,
      winnerBidUnitPriceNoVat: 900_000,
      winnerBidTotalPriceNoVat: 900_000,
      winnerDiscountFromPlanPct: 10,
      winnerCondDiscountPct: 2,
      secondBin: rivalWon ? ourBin : rivalBin,
      secondName: rivalWon ? ourName : rivalName,
      failureReason: "",
      lotUrl: `https://procurement.gov.kz/ru/announce/index/${annoId}`,
      annoUrl: `https://procurement.gov.kz/ru/announce/index/${annoId}`,
      protocolUrl: "",
      techspecUrl: "",
      hasTechspec: false,
      hasItogi: true
    };
  });

  const bids: CompetitorBid[] = lots.flatMap((lot, idx) => {
    const rivalWon = idx < 2;
    return [
      {
        annoId: lot.annoId,
        lotNumber: lot.lotNumber,
        isLatestLotVersion: true,
        group: "ИП",
        kind: "Интерактивная панель",
        diagonal: '75"',
        cpu: "",
        isCombinedLot: false,
        isKit: false,
        startDate: lot.startDate,
        lotStatus: lot.status,
        plannedQty: 1,
        plannedUnitPriceNoVat: 1_000_000,
        plannedSumNoVat: 1_000_000,
        bidderBin: rivalBin,
        bidderName: rivalName,
        ourCompany: "",
        admittedStatus: "Допущен",
        rejectionShort: "",
        rejectionDetail: "",
        bidUnitPriceNoVat: rivalWon ? 900_000 : 950_000,
        bidTotalPriceNoVat: rivalWon ? 900_000 : 950_000,
        discountFromPlanPct: rivalWon ? 10 : 5,
        condDiscountPct: 2,
        otpKtpPct: 0,
        condPriceNoVat: rivalWon ? 882_000 : 931_000,
        isWinner: rivalWon,
        isSecondPlace: !rivalWon
      },
      {
        annoId: lot.annoId,
        lotNumber: lot.lotNumber,
        isLatestLotVersion: true,
        group: "ИП",
        kind: "Интерактивная панель",
        diagonal: '75"',
        cpu: "",
        isCombinedLot: false,
        isKit: false,
        startDate: lot.startDate,
        lotStatus: lot.status,
        plannedQty: 1,
        plannedUnitPriceNoVat: 1_000_000,
        plannedSumNoVat: 1_000_000,
        bidderBin: ourBin,
        bidderName: ourName,
        ourCompany: ourName,
        admittedStatus: "Допущен",
        rejectionShort: "",
        rejectionDetail: "",
        bidUnitPriceNoVat: rivalWon ? 950_000 : 900_000,
        bidTotalPriceNoVat: rivalWon ? 950_000 : 900_000,
        discountFromPlanPct: rivalWon ? 5 : 10,
        condDiscountPct: 1,
        otpKtpPct: 0,
        condPriceNoVat: rivalWon ? 940_500 : 891_000,
        isWinner: !rivalWon,
        isSecondPlace: rivalWon
      }
    ];
  });

  const payload: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
  payload.competitors = buildCompetitorsView({
    lots,
    bids,
    templateMatches: [],
    asOfDate: "2026-10-28",
    updatedAt: "2026-10-28",
    cfg
  });
  return payload;
}

describe("Wave 1: «Выручка» и «Конкуренты» в браузере (1440 и 375 px)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const width of [1440, 375]) {
    it(`«Выручка»: переход по ссылкам расхождений (клик и клавиатура), учёт шапки, аккордеон цел (${width}px)`, async () => {
      const payload = buildRegisterPayloadWithMismatches();
      const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.setContent(renderRegisterHtml(payload));

        // 1. В #r-month есть обе ссылки: на #r-missing и на #r-reconciliation
        const monthMissingLink = page.locator('#r-month a[href="#r-missing"]');
        const monthRecLink = page.locator('#r-month a[href="#r-reconciliation"]');
        expect(await monthMissingLink.count()).toBe(1);
        expect(await monthRecLink.count()).toBe(1);
        expect(await monthMissingLink.innerText()).toContain("2");
        expect(await monthRecLink.innerText()).toContain("2");

        // 2. В таблице Менеджеры: у Алии (missCount = 2) ссылка есть, у Бориса (missCount = 0) ссылки нет
        const aliyaRow = page.locator('.mgr .r.body[data-m="Алия"]');
        const borisRow = page.locator('.mgr .r.body[data-m="Борис"]');
        const aliyaLink = aliyaRow.locator('a[href="#r-missing"]');
        expect(await aliyaLink.count()).toBe(1);
        expect(await aliyaLink.innerText()).toContain("нет в CRM: 2");
        expect(await borisRow.locator('a[href="#r-missing"]').count()).toBe(0);

        // 3. Клик по ссылке в #r-month прокручивает к #r-missing, шапка (.bar и .dateline) не перекрывает цель
        await monthMissingLink.click();
        const missingTopAfterClick = await page.evaluate(() => {
          const target = document.getElementById("r-missing")!;
          const bar = document.querySelector(".bar")!;
          const dateline = document.querySelector(".dateline")!;
          const stickyBottom = Math.max(bar.getBoundingClientRect().bottom, dateline.getBoundingClientRect().bottom);
          return {
            top: target.getBoundingClientRect().top,
            stickyBottom,
            opacity: getComputedStyle(target).opacity
          };
        });
        expect(missingTopAfterClick.top).toBeGreaterThanOrEqual(missingTopAfterClick.stickyBottom - 1);
        expect(missingTopAfterClick.top).toBeLessThan(700);
        expect(Number(missingTopAfterClick.opacity)).toBe(1);

        // 4. Клавиатура (Enter) на ссылке в #r-month прокручивает к #r-reconciliation без перекрытия шапкой
        await page.evaluate(() => window.scrollTo(0, 0));
        await monthRecLink.focus();
        await monthRecLink.press("Enter");
        const recTopAfterEnter = await page.evaluate(() => {
          const target = document.getElementById("r-reconciliation")!;
          const bar = document.querySelector(".bar")!;
          const dateline = document.querySelector(".dateline")!;
          const stickyBottom = Math.max(bar.getBoundingClientRect().bottom, dateline.getBoundingClientRect().bottom);
          return {
            top: target.getBoundingClientRect().top,
            stickyBottom
          };
        });
        expect(recTopAfterEnter.top).toBeGreaterThanOrEqual(recTopAfterEnter.stickyBottom - 1);
        expect(recTopAfterEnter.top).toBeLessThan(700);

        // 5. Клик и Enter по ссылке внутри строки менеджера (role="button") НЕ ломают аккордеон
        await page.evaluate(() => window.scrollTo(0, 0));
        expect(await aliyaRow.getAttribute("aria-expanded")).toBe("false");
        await aliyaLink.click();
        expect(await aliyaRow.getAttribute("aria-expanded")).toBe("false");
        const afterMgrClick = await page.evaluate(() => {
          const target = document.getElementById("r-missing")!;
          const bar = document.querySelector(".bar")!;
          const dateline = document.querySelector(".dateline")!;
          const stickyBottom = Math.max(bar.getBoundingClientRect().bottom, dateline.getBoundingClientRect().bottom);
          return target.getBoundingClientRect().top >= stickyBottom - 1;
        });
        expect(afterMgrClick).toBe(true);

        await page.evaluate(() => window.scrollTo(0, 0));
        await aliyaLink.focus();
        await aliyaLink.press("Enter");
        expect(await aliyaRow.getAttribute("aria-expanded")).toBe("false");

        // Сам аккордеон по-прежнему открывается кликом и Enter по строке
        await aliyaRow.locator(".who").click();
        expect(await aliyaRow.getAttribute("aria-expanded")).toBe("true");
        await aliyaRow.focus();
        await aliyaRow.press("Enter");
        expect(await aliyaRow.getAttribute("aria-expanded")).toBe("false");

        // 6. Прошлый месяц (reconciliation === null, R.missing есть): ссылка на #r-missing есть, на #r-reconciliation нет;
        //    клик по #r-missing не сбрасывает выбранный прошлый месяц
        await page.locator('#registerMonths button[data-month="2026-09"]').click();
        expect(await page.locator("#r-month").innerText()).toContain("Сентябрь");
        expect(await page.locator('#r-month a[href="#r-missing"]').count()).toBe(1);
        expect(await page.locator('#r-month a[href="#r-reconciliation"]').count()).toBe(0);
        expect(await page.locator("#r-reconciliation").count()).toBe(0);
        await page.locator('.mgr .r.body[data-m="Алия"] a[href="#r-missing"]').click();
        expect(await page.evaluate(() => location.hash)).toBe("#2026-09");
        expect(await page.locator("#r-month").innerText()).toContain("Сентябрь");

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 25_000);

    it(`«Выручка»: при 0 расхождений и при недоступной секции сверки ссылок нет (${width}px)`, async () => {
      const payload = buildRegisterPayloadWithMismatches();
      if (payload.register.error !== undefined) throw new Error(payload.register.error);
      payload.register = buildRegisterView({
        fileName: "ОП чистый.xlsx",
        asOf: "2026-10-28",
        month: "2026-10",
        rows: [makeRow("Алия", "Школа Тест 1", 2_000_000)],
        plans: { Алия: 5_000_000, B2B: 0 },
        missing: [],
        extraDealsCount: 0
      });
      payload.reconciliation = { closedNotInRegister: [], possibleDuplicates: [] };

      const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
      try {
        await page.setContent(renderRegisterHtml(payload));
        expect(await page.locator('#r-month a[href="#r-missing"]').count()).toBe(0);
        expect(await page.locator('#r-month a[href="#r-reconciliation"]').count()).toBe(0);
        expect(await page.locator('.mgr a[href="#r-missing"]').count()).toBe(0);
        expect(await page.locator('.mgr .flag-ok').first().innerText()).toBe("всё отмечено");

        // Случай недоступной секции сверки (R.missing отсутствует, reconciliation === null)
        await page.evaluate(() => {
          const R = {
            month: "2026-08",
            file: "ОП архив.xlsx",
            asOf: "2026-08-31",
            total: { sale: 2000000, val: 600000, hasVal: true, bonusMop: 40000, bonusRop: 10000, contracts: 1, plan: 5000000, b2bPlan: 0, b2bSale: 0 },
            daily: [{ d: "2026-08-10", sale: 2000000 }],
            managers: [{ name: "Алия", sale: 2000000, val: 600000, margin: 0.3, bonus: 40000, plan: 5000000, contracts: 1, missCount: 1, missSum: 500000, rows: [] }],
            mix: [],
            channels: [],
            groups: [],
            rows: []
          };
          (window as any).__renderRegisterTab(R, document.getElementById("tab-reg"), null, "https://example.invalid");
        });
        expect(await page.locator("#r-missing").count()).toBe(0);
        expect(await page.locator("#r-reconciliation").count()).toBe(0);
        expect(await page.locator("#r-month a.crm-miss-link").count()).toBe(0);
        expect(await page.locator(".mgr a.crm-miss-link").count()).toBe(0);
        expect(await page.locator(".mgr span.flag-miss").innerText()).toContain("нет в CRM: 1");
      } finally {
        await page.close();
      }
    }, 25_000);

    it(`«Выручка»: вид менеджера (VIEWER) показывает только его расхождения и ссылки работают (${width}px)`, async () => {
      const f = fixture();
      const baseReg = buildRegisterPayloadWithMismatches();
      const variant = buildManagerVariant({
        pult: f.payload,
        reg: baseReg,
        planDeals: null,
        managerId: "s",
        aliases: f.aliases
      });
      expect(variant).not.toBeNull();

      const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
      try {
        await page.setContent(renderRegisterHtml(variant!.reg));
        expect(await page.locator('#r-month a[href="#r-missing"]').count()).toBe(1);
        expect(await page.locator('#r-month a[href="#r-reconciliation"]').count()).toBe(1);
        expect(await page.locator('#r-month a[href="#r-reconciliation"]').innerText()).toContain("1 сделка");
        expect(await page.locator(".mgr .r.body").count()).toBe(1);
        expect(await page.locator("#r-reconciliation").innerText()).toContain("Тестовая сделка 1");
        expect(await page.locator("#r-reconciliation").innerText()).not.toContain("Тестовый дубль 2");

        await page.locator('.mgr .r.body a[href="#r-missing"]').click();
        const mgrRow = page.locator(".mgr .r.body");
        expect(await mgrRow.getAttribute("aria-expanded")).toBe("false");
        const cleared = await page.evaluate(() => {
          const target = document.getElementById("r-missing")!;
          const bar = document.querySelector(".bar")!;
          const dateline = document.querySelector(".dateline")!;
          return target.getBoundingClientRect().top >= Math.max(bar.getBoundingClientRect().bottom, dateline.getBoundingClientRect().bottom) - 1;
        });
        expect(cleared).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        await page.close();
      }
    }, 25_000);

    it(`«Конкуренты»: подпись «Победы / допуски» на 1440 и 375 px, без переполнения и с прежней формулой (${width}px)`, async () => {
      const payload = buildSampleCompetitorsPayload();
      expect(payload.competitors?.ip?.competitors.find((c) => c.bin === "333333333333")?.winRateAdmittedPct).toBe(50);

      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.setContent(renderPultHtml(payload));
        await page.locator('.sections [data-t="competitors"]').click();

        const paneIp = page.locator("#tab-competitors-ip");
        expect(await paneIp.getAttribute("class")).toContain("on");

        if (width === 1440) {
          const headLabels = await paneIp.locator(".comp-table .r.head .label").allInnerTexts();
          expect(headLabels.map((t) => t.toLowerCase())).toContain("победы / допуски");
          expect(headLabels.map((t) => t.toLowerCase())).not.toContain("от допусков");
        } else {
          const cell = paneIp.locator('.comp-table summary.r [data-l="Победы / допуски"]').first();
          expect(await cell.count()).toBe(1);
          expect(await cell.isVisible()).toBe(true);
          const beforeContent = await cell.evaluate((el) => getComputedStyle(el, "::before").content);
          expect(beforeContent).toContain("Победы / допуски");
          expect(await paneIp.locator('.comp-table [data-l="Доля побед"]').count()).toBe(0);
        }

        const winRateText = await paneIp.locator('.comp-table summary.r [data-l="Победы / допуски"]').first().innerText();
        expect(winRateText).toBe("50,0%");

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 25_000);
  }
});
