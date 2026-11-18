import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { attachRegisterContracts } from "../../src/bitrix/salesPult/contracts.js";
import { loadRegisterView } from "../../src/bitrix/salesPult/register/load.js";
import { buildRegisterMonthSummary } from "../../src/bitrix/salesPult/register/history.js";
import type { RegisterSuccessView } from "../../src/bitrix/salesPult/register/types.js";
import { renderPultHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { buildCompetitorsView } from "../../src/kz/competitors/aggregate.js";
import { loadCompetitorsConfig } from "../../src/kz/competitors/config.js";
import type { CompetitorBid, CompetitorLot } from "../../src/kz/competitors/types.js";
import { buildMarketGroupView } from "../../src/kz/market/aggregate.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import type { MarketUnit } from "../../src/kz/market/types.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";

// Все названия, БИН, имена и суммы в этом файле выдуманные.
vi.setConfig({ testTimeout: 30_000 });

async function buildRegisterXlsxBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Лист1");
  ws.addRow([
    "Дата договора",
    "Тип продажи",
    "Контрагент",
    "Кол-во",
    "Товар",
    "Сумма без НДС (закуп)",
    "Сумма продажи без НДС",
    "Итого вал",
    "Бонус МОП",
    "Бонус РОП",
    "Менеджер"
  ]);
  ws.addRow(["2026-10-23", "B2B", "Альфа Тест", 1, "Панель", 50, 100, 50, 5, 2, "Алия"]);
  ws.addRow([]);
  ws.addRow(["Менеджер", "План на месяц"]);
  ws.addRow(["Алия", 1000]);
  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

function buildCompetitorsInput() {
  const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
  const ourBin = [...cfg.ourBins][0];
  const ourName = cfg.ourCompanyNames[ourBin] || "F3";
  const lots: CompetitorLot[] = [
    {
      annoId: "9101",
      annoNumber: "9101-1",
      annoName: "Панель",
      lotNumber: "L-9101",
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
      startDate: "2026-10-10",
      endDate: "2026-10-20",
      customerBin: "777777777777",
      customerName: "КГУ «Тестовая школа №1»",
      qty: 1,
      plannedUnitPriceNoVat: 1_200_000,
      plannedSumNoVat: 1_200_000,
      numSubmitted: 2,
      numAdmitted: 2,
      winnerBin: "333333333333",
      winnerName: "ТОО «Тест Соперник»",
      winnerIsOurs: "",
      winnerBidUnitPriceNoVat: 1_100_000,
      winnerBidTotalPriceNoVat: 1_100_000,
      winnerDiscountFromPlanPct: 8.33,
      winnerCondDiscountPct: 2,
      secondBin: ourBin,
      secondName: ourName,
      failureReason: "",
      lotUrl: "https://procurement.gov.kz/ru/announce/index/9101",
      annoUrl: "https://procurement.gov.kz/ru/announce/index/9101",
      protocolUrl: "",
      techspecUrl: "",
      hasTechspec: false,
      hasItogi: true
    }
  ];
  const bids: CompetitorBid[] = [
    {
      annoId: "9101",
      lotNumber: "L-9101",
      isLatestLotVersion: true,
      group: "ИП",
      kind: "Интерактивная панель",
      diagonal: '75"',
      cpu: "",
      isCombinedLot: false,
      isKit: false,
      startDate: "2026-10-10",
      lotStatus: "Закупка состоялась",
      plannedQty: 1,
      plannedUnitPriceNoVat: 1_200_000,
      plannedSumNoVat: 1_200_000,
      bidderBin: "333333333333",
      bidderName: "ТОО «Тест Соперник»",
      ourCompany: "",
      admittedStatus: "Допущен",
      rejectionShort: "",
      rejectionDetail: "",
      bidUnitPriceNoVat: 1_100_000,
      bidTotalPriceNoVat: 1_100_000,
      discountFromPlanPct: 8.33,
      condDiscountPct: 2,
      otpKtpPct: 0,
      condPriceNoVat: 1_078_000,
      isWinner: true,
      isSecondPlace: false
    },
    {
      annoId: "9101",
      lotNumber: "L-9101",
      isLatestLotVersion: true,
      group: "ИП",
      kind: "Интерактивная панель",
      diagonal: '75"',
      cpu: "",
      isCombinedLot: false,
      isKit: false,
      startDate: "2026-10-10",
      lotStatus: "Закупка состоялась",
      plannedQty: 1,
      plannedUnitPriceNoVat: 1_200_000,
      plannedSumNoVat: 1_200_000,
      bidderBin: ourBin,
      bidderName: ourName,
      ourCompany: ourName,
      admittedStatus: "Допущен",
      rejectionShort: "",
      rejectionDetail: "",
      bidUnitPriceNoVat: 1_150_000,
      bidTotalPriceNoVat: 1_150_000,
      discountFromPlanPct: 4.17,
      condDiscountPct: 0,
      otpKtpPct: 0,
      condPriceNoVat: 1_150_000,
      isWinner: false,
      isSecondPlace: true
    }
  ];
  return { lots, bids, cfg };
}

function buildMarketSection(updatedAt?: string, stale?: boolean): SalesPultPayload["market"] {
  const cfg = loadMarketConfig();
  const units: MarketUnit[] = [
    {
      id: 1,
      month: "2026-10",
      date: "2026-10-10",
      group: "ИП",
      code: "262030.100.000021",
      kind: "Интерактивные панели",
      sum: 10_000_000,
      qty: 10,
      price: 1_000_000,
      supplier: "061140003942",
      customer: "111111111111",
      supplierName: "F3",
      customerName: "КГУ «Тест Заказчик»",
      method: "Открытый конкурс",
      us: true
    }
  ];
  return {
    asOf: "2026-10-29",
    months: ["2026-10"],
    ip: buildMarketGroupView("ИП", units, "2026-10-29", cfg),
    kt: buildMarketGroupView("КТ", units, "2026-10-29", cfg),
    educationPending: {},
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(stale !== undefined ? { stale } : {})
  };
}

function buildFreshnessPayload(opts?: {
  registerUpdatedAt?: string;
  closedUpdatedAt?: string;
  competitorsMode?: "fresh" | "stale" | "missing";
  marketMode?: "fresh" | "stale" | "missing";
}) {
  const f = fixture();
  f.payload.asOfDate = "2026-10-29";
  f.payload.generatedAt = "2026-10-29 14:30 (UTC+5)";

  const register = f.register as RegisterSuccessView;
  register.asOf = "2026-10-28";
  if (opts?.registerUpdatedAt !== undefined) {
    register.updatedAt = opts.registerUpdatedAt;
  } else {
    delete register.updatedAt;
  }

  attachRegisterContracts(f.payload, register, f.deals, f.aliases);

  const closed = structuredClone(f.payload);
  closed.closedMonth = true;
  closed.asOfDate = "2026-09-30";
  closed.generatedAt = "2026-09-30 23:59 (UTC+5)";
  closed.closedMonths = undefined;
  const septRows = f.rows.map((r) => ({ ...r, date: "2026-09-23" }));
  const septSummary = buildRegisterMonthSummary({
    month: "2026-09",
    fileName: "ОП 30.09.26.xlsx",
    rows: septRows,
    plans: { Алия: 1000, Борис: 1000 }
  });
  if (opts?.closedUpdatedAt) {
    septSummary.updatedAt = opts.closedUpdatedAt;
  }
  attachRegisterContracts(
    closed,
    {
      error: "current unavailable",
      history: { asOf: "2026-10-29", months: [septSummary] }
    },
    new Map(),
    f.aliases
  );
  f.payload.closedMonths = { "2026-09": closed };

  const compInput = buildCompetitorsInput();
  const compMode = opts?.competitorsMode ?? "fresh";
  f.payload.competitors = buildCompetitorsView({
    lots: compInput.lots,
    bids: compInput.bids,
    templateMatches: [],
    asOfDate: "2026-10-29",
    updatedAt: compMode === "fresh" ? "2026-10-29" : compMode === "stale" ? "2026-10-20" : undefined,
    cfg: compInput.cfg
  });

  const mMode = opts?.marketMode ?? "fresh";
  f.payload.market =
    mMode === "fresh"
      ? buildMarketSection("2026-10-29", false)
      : mMode === "stale"
        ? buildMarketSection("2026-10-20", true)
        : buildMarketSection(undefined, false);

  const reg: RegisterPagePayload = {
    asOfDate: f.payload.asOfDate,
    generatedAt: f.payload.generatedAt,
    portal: f.payload.portal,
    register,
    reconciliation: f.payload.contractSource?.reconciliation
  };
  return { payload: f.payload, reg, aliases: f.aliases };
}

describe("wave 2 freshness: данные источников и проброс дат", () => {
  it("register/load сохраняет updateTime с Диска отдельно от asOf и не подменяет отсутствующий updateTime", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-reg-fresh-"));
    const origFetch = globalThis.fetch;
    try {
      const buf = await buildRegisterXlsxBuffer();
      globalThis.fetch = (async () => new Response(new Uint8Array(buf), { status: 200 })) as typeof fetch;

      const readerWithTime = {
        listAllBatched: async () => [
          {
            ID: "1",
            NAME: "ОП 28.10.26.xlsx",
            TYPE: "file",
            DOWNLOAD_URL: "https://example.invalid/reg.xlsx",
            UPDATE_TIME: "2026-10-28T12:45:00Z"
          }
        ]
      };

      const viewWithTime = (await loadRegisterView({
        reader: readerWithTime as never,
        diskFolderId: 42,
        todayAlmaty: "2026-10-29",
        historyCachePath: path.join(tmpDir, "h1.json"),
        attemptPath: path.join(tmpDir, "a1.json")
      })) as RegisterSuccessView;

      expect(viewWithTime.error).toBeUndefined();
      expect(viewWithTime.asOf).toBe("2026-10-28");
      expect(viewWithTime.updatedAt).toBe("2026-10-28T12:45:00Z");

      const readerWithoutTime = {
        listAllBatched: async () => [
          {
            ID: "2",
            NAME: "ОП 28.10.26.xlsx",
            TYPE: "file",
            DOWNLOAD_URL: "https://example.invalid/reg.xlsx",
            UPDATE_TIME: ""
          }
        ]
      };

      const viewWithoutTime = (await loadRegisterView({
        reader: readerWithoutTime as never,
        diskFolderId: 42,
        todayAlmaty: "2026-10-29",
        historyCachePath: path.join(tmpDir, "h2.json"),
        attemptPath: path.join(tmpDir, "a2.json")
      })) as RegisterSuccessView;

      expect(viewWithoutTime.error).toBeUndefined();
      expect(viewWithoutTime.asOf).toBe("2026-10-28");
      expect(viewWithoutTime.updatedAt).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("contracts.ts пробрасывает asOf и updatedAt в PultContractSource без подмены и сохраняет итоги", () => {
    const f = fixture();
    const reg = f.register as RegisterSuccessView;
    reg.asOf = "2026-10-28";
    reg.updatedAt = "2026-10-28T09:15:00+03:00";
    attachRegisterContracts(f.payload, reg, f.deals, f.aliases);

    expect(f.payload.contractSource?.available).toBe(true);
    expect(f.payload.contractSource?.asOf).toBe("2026-10-28");
    expect(f.payload.contractSource?.updatedAt).toBe("2026-10-28T09:15:00+03:00");
    expect(f.payload.contractSource?.fact).toBe(3);
    expect(f.payload.contractSource?.amount).toBe(600);

    // Если updatedAt отсутствует, он остаётся undefined
    delete reg.updatedAt;
    attachRegisterContracts(f.payload, reg, f.deals, f.aliases);
    expect(f.payload.contractSource?.asOf).toBe("2026-10-28");
    expect(f.payload.contractSource?.updatedAt).toBeUndefined();
  });

  it("competitors/aggregate.ts оставляет updatedAt=undefined при отсутствии options.updatedAt", () => {
    const { lots, bids, cfg } = buildCompetitorsInput();
    const view = buildCompetitorsView({
      lots,
      bids,
      templateMatches: [],
      asOfDate: "2026-10-29",
      cfg
    });
    expect(view.asOf).toBe("2026-10-29");
    expect(view.updatedAt).toBeUndefined();
    expect(view.stale).toBe(false);
  });
});

describe("wave 2 freshness: Playwright (1440 и 375 px)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  const setPageHtml = async (page: Awaited<ReturnType<Browser["newPage"]>>, html: string) => {
    await page.goto("about:blank");
    await page.setContent(html);
  };

  for (const width of [1440, 375]) {
    it(`«Сегодня»: свежесть CRM и реестра ОП без раскрытия подробностей, закрытый месяц, ТВ и роль manager на ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        // 1. Текущий месяц с updateTime (UTC -> Алматы UTC+5: 12:45Z -> 17:45)
        const withUpd = buildFreshnessPayload({ registerUpdatedAt: "2026-10-28T12:45:00Z" });
        await setPageHtml(page, renderPultHtml(withUpd.payload));

        // Подробности по умолчанию закрыты, но #monthFreshness виден
        expect(await page.locator("#month .month-more").getAttribute("open")).toBeNull();
        const freshness = page.locator("#monthFreshness");
        expect(await freshness.isVisible()).toBe(true);
        const fText = await freshness.innerText();
        expect(fText).toContain("Октябрь 2026");
        expect(fText).toContain("срез по 29.10");
        expect(fText).toContain("сборка Пульта 29.10 14:30 (UTC+5)");
        expect(fText).toContain("срез по 28.10");
        expect(fText).toContain("28.10 17:45 (UTC+5)");

        // Суммы сохраняются
        expect(await page.locator("#month .month-tiles").innerText()).toContain("600 ₸");

        // Шапка #liveText показывает сборку Пульта (не дату среза реестра)
        const liveInitial = await page.locator("#liveText").innerText();
        expect(liveInitial).toContain("Сборка");
        expect(liveInitial).toContain("14:30");

        // 2. Закрытый месяц: текущая сборка (14:30) и фиктивный 23:59 НЕ выдаются за обновление закрытого месяца
        await page.selectOption("#monthSelect", "2026-09");
        const liveClosed = await page.locator("#liveText").innerText();
        expect(liveClosed).toContain("Архив");
        expect(liveClosed).toContain("30.09");
        expect(liveClosed).not.toContain("14:30");
        expect(liveClosed).not.toContain("23:59");

        const closedFreshness = await freshness.innerText();
        expect(closedFreshness).toContain("Сентябрь 2026");
        expect(closedFreshness).toContain("архивный срез по 30.09");
        expect(closedFreshness).toContain("время обновления с Диска неизвестно");
        expect(closedFreshness).not.toContain("14:30");
        expect(closedFreshness).not.toContain("23:59");

        const closedSrc = await page.locator("#srcLabel").textContent();
        expect(closedSrc).toContain("Архив: CRM по 30.09");
        expect(closedSrc).not.toContain("23:59");

        // Переключение обратно на текущий месяц восстанавливает #liveText и текущую свежесть
        await page.selectOption("#monthSelect", "2026-10");
        const liveRestored = await page.locator("#liveText").innerText();
        expect(liveRestored).toContain("Сборка");
        expect(liveRestored).toContain("14:30");
        expect(await freshness.innerText()).toContain("28.10 17:45 (UTC+5)");

        // Проверка отсутствия горизонтального переполнения в обычном виде
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        // 3. Компактный ТВ-вид на существующих сценах (помещается в fitTv(), без переполнения)
        await page.keyboard.press("t");
        expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
        expect(await freshness.isVisible()).toBe(true);
        const tvBox = await page.evaluate(() => {
          const month = document.getElementById("month")!.getBoundingClientRect();
          const mf = document.getElementById("monthFreshness")!.getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            mfHeight: mf.height,
            fitsHeight: month.bottom <= innerHeight + 4
          };
        });
        expect(tvBox.overflow).toBe(false);
        expect(tvBox.mfHeight).toBeLessThan(120);
        if (width >= 1280) {
          expect(tvBox.fitsHeight).toBe(true);
        }
        await page.keyboard.press("t");

        // 4. Отсутствие updateTime у реестра ОП: явно пишем, не подменяем временем сборки
        const withoutUpd = buildFreshnessPayload({ registerUpdatedAt: undefined });
        await setPageHtml(page, renderPultHtml(withoutUpd.payload));
        const noUpdText = await page.locator("#monthFreshness").innerText();
        expect(noUpdText).toContain("срез по 28.10");
        expect(noUpdText).toContain("время обновления с Диска неизвестно");
        expect(noUpdText).not.toContain("файл с Диска от 29.10 14:30");

        // 5. Роль manager (viewer): нет radar, competitors, fin.html; свои суммы и свежесть CRM + ОП видны, чужих нет
        const variant = buildManagerVariant({
          pult: withUpd.payload,
          reg: withUpd.reg,
          planDeals: [],
          managerId: "s",
          aliases: withUpd.aliases
        })!;
        expect(variant.pult.radar).toBeNull();
        expect(variant.pult.competitors).toBeNull();
        const renderedViewer = renderManagerVariant(variant);
        await setPageHtml(page, renderedViewer.index);
        expect(await page.locator('.sections a[data-t="radar"]').count()).toBe(0);
        expect(await page.locator('.sections a[data-t="competitors"]').count()).toBe(0);
        expect(await page.locator('.sections a[href="./fin.html"]').count()).toBe(0);
        const viewerFreshness = await page.locator("#monthFreshness").innerText();
        expect(viewerFreshness).toContain("сборка Пульта 29.10 14:30 (UTC+5)");
        expect(viewerFreshness).toContain("28.10 17:45 (UTC+5)");
        expect(await page.locator("#month .month-tiles").innerText()).toContain("600 ₸");
        expect(await page.locator("body").innerText()).not.toContain("Борис");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        // Закрытый месяц у viewer тоже без утечки чужих имён и без подмены временем сборки
        await page.selectOption("#monthSelect", "2026-09");
        expect(await page.locator("#liveText").innerText()).toContain("Архив");
        expect(await page.locator("#liveText").innerText()).not.toContain("23:59");
        expect(await page.locator("body").innerText()).not.toContain("Борис");

        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });

    it(`«Конкуренты» и шапка «Рынка»: свежий, stale и отсутствие updatedAt на ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        // 1. Свежий источник (не только при stale!)
        const freshData = buildFreshnessPayload({ competitorsMode: "fresh", marketMode: "fresh" });
        await setPageHtml(page, renderPultHtml(freshData.payload));

        await page.locator('.sections [data-t="competitors"]').click();
        expect(await page.locator("#tab-competitors-ip").innerText()).toContain("Данные конкурентов обновлены 29.10");
        expect(await page.locator("#srcLabel").textContent()).toContain("обновлены 29.10");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        await page.locator('.sections [data-t="market"]').click();
        expect(await page.locator("#srcLabel").textContent()).toContain("обновлено 29.10");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        // 2. Устаревший источник (stale)
        const staleData = buildFreshnessPayload({ competitorsMode: "stale", marketMode: "stale" });
        await setPageHtml(page, renderPultHtml(staleData.payload));

        await page.locator('.sections [data-t="competitors"]').click();
        expect(await page.locator("#tab-competitors-ip").innerText()).toContain("Данные конкурентов не обновлены с 20.10");
        expect(await page.locator("#srcLabel").textContent()).toContain("не обновлены с 20.10");

        await page.locator('.sections [data-t="market"]').click();
        expect(await page.locator("#tab-ip").innerText()).toContain("Данные рынка не обновлены с 20.10");
        expect(await page.locator("#srcLabel").textContent()).toContain("не обновлены с 20.10");

        // 3. Отсутствие даты обновления
        const missingData = buildFreshnessPayload({ competitorsMode: "missing", marketMode: "missing" });
        await setPageHtml(page, renderPultHtml(missingData.payload));

        await page.locator('.sections [data-t="competitors"]').click();
        expect(await page.locator("#tab-competitors-ip").innerText()).toContain("Дата обновления неизвестна");
        expect(await page.locator("#srcLabel").textContent()).toContain("Дата обновления неизвестна");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        await page.locator('.sections [data-t="market"]').click();
        expect(await page.locator("#srcLabel").textContent()).toContain("Дата обновления неизвестна");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }
});
