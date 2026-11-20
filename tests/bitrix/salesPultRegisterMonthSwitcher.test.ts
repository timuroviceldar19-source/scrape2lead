import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegisterView } from "../../src/bitrix/salesPult/register/load.js";
import type { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import { saveEncryptedRegisterHistory, shouldRefreshRegisterHistory, recordRegisterHistoryAttempt, REGISTER_HISTORY_VERSION } from "../../src/bitrix/salesPult/register/crypto.js";
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
  it("hiddenManagers убирает менеджера из списка, но не из плана отдела и не из договоров", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");
    ws.getRow(1).values = [null, "Дата договора", "Контрагент", "Товар", "Сумма продажи без НДС", "Менеджер"];
    ws.getRow(2).values = [null, "2026-11-02", "Заказчик", "панель", 100, "Менеджер В"];
    ws.getRow(4).values = [null, null, "Менеджер", "План на месяц"];
    ws.getRow(5).values = [null, null, "Менеджер Б", 2000];
    ws.getRow(6).values = [null, null, "Менеджер В", 0];
    ws.getRow(7).values = [null, null, "Менеджер А", 3000];
    const history = await buildFullRegisterHistory({
      files: [{ fileName: "ОП 03.11.26.xlsx", buffer: Buffer.from(await wb.xlsx.writeBuffer()) }],
      hiddenManagers: ["Менеджер Б", "Менеджер В"],
      todayAlmaty: "2026-11-03",
      fetchPortal: false,
      crmWonDealsByMonth: new Map()
    });

    const [month] = history.months;
    expect(month.byManager.map((m) => m.name).sort()).toEqual(["Менеджер А", "Менеджер В"]);
    expect(month.plan).toBe(5000);
    expect(month.sale).toBe(100);

    const view = history.monthViews!["2026-11"];
    expect(view.managers.map((m) => m.name).sort()).toEqual(["Менеджер А", "Менеджер В"]);
    expect(view.total.plan).toBe(5000);
    expect(view.rows).toHaveLength(1);
  });

  it("hiddenManagers работает и для текущего файла", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");
    ws.getRow(1).values = [null, "Дата договора", "Контрагент", "Товар", "Сумма продажи без НДС", "Менеджер"];
    ws.getRow(2).values = [null, "2026-11-02", "Заказчик", "панель", 100, "Менеджер А"];
    ws.getRow(4).values = [null, null, "Менеджер", "План на месяц"];
    ws.getRow(5).values = [null, null, "Менеджер Б", 2000];
    ws.getRow(6).values = [null, null, "Менеджер А", 3000];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "register-hidden-"));
    try {
      const registerFilePath = path.join(dir, "ОП 03.11.26.xlsx");
      await wb.xlsx.writeFile(registerFilePath);
      const reader = { call: async () => [], listAllBatched: async () => [] } as unknown as ReadOnlyBitrixClient;

      const view = await loadRegisterView({
        reader,
        registerFilePath,
        hiddenManagers: ["Менеджер Б"],
        todayAlmaty: "2026-11-03",
        historyCachePath: path.join(dir, "history.json"),
        secretKey: "test-key",
        fetchPortal: false
      });

      expect(view.error).toBeUndefined();
      expect(view.managers?.map((m) => m.name)).toEqual(["Менеджер А"]);
      expect(view.total?.plan).toBe(5000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("сохраняет независимые полные срезы после сверки CRM", async () => {
    const history = await fixture();
    const views = history.monthViews!;
    expect(Object.keys(views || {})).toEqual(["2026-09", "2026-10", "2026-11"]);
    for (const summary of history.months) {
      const view = views[summary.month];
      expect(view.file).toBe(summary.fileName);
      expect(view.asOf).toBe(`${summary.month}-${summary.month.endsWith("09") ? "30" : summary.month.endsWith("10") ? "31" : "03"}`);
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
      expect(await page.locator('#registerMonths [aria-pressed="true"]').getAttribute("data-month")).toBe("2026-09");
      expect(await page.locator("#regChart svg").count()).toBe(1);
      expect(await page.locator(".mgr").textContent()).toContain("Менеджер 09");
      expect(await page.locator("#regAll").textContent()).toContain("Заказчик 09");
      expect(await page.locator('#r-history [data-month="2026-09"]').getAttribute("aria-current")).toBe("true");
      await page.evaluate(() => { location.hash = "2026-10"; });
      await page.waitForFunction(() => document.querySelector("#r-month")?.textContent?.includes("Октябрь"));
      await page.evaluate(() => { location.hash = "constructor"; });
      await page.waitForTimeout(30);
      expect(await page.locator("#r-month").textContent()).toContain("Ноябрь");
      delete history.monthViews;
      await page.goto("about:blank");
      await page.setContent(renderRegisterHtml({ register: { ...register, history }, asOfDate: "2026-11-03", generatedAt: "test" }));
      await page.locator('#registerMonths button[data-month="2026-09"]').click();
      expect(await page.locator(".mgr").textContent()).toContain("Менеджер 09");
      expect(await page.locator("#regAll").textContent()).not.toContain("Заказчик 11");
      expect(await page.locator("#r-history").count()).toBe(1);
      expect(await page.locator("#r-month .big").textContent()).toBe("9");
      expect(await page.locator("#regChart svg").count()).toBe(1);
      await page.evaluate(register => { (window as any).__testRegister = register; }, { ...register, history });
      for (const [month, lastDay] of [["2028-02", 29], ["2026-02", 28], ["2026-09", 30], ["2026-10", 31]] as const) {
        const result = await page.evaluate(({ month, lastDay }) => {
          const view = (window as any).__registerViewForMonth((window as any).__testRegister, "2026-09");
          view.month = month;
          view.daily = [{ d: `${month}-${lastDay}`, sale: view.total.sale }];
          (window as any).__renderRegisterTab(view, document.getElementById("tab-reg"));
          const svg = document.querySelector("#regChart svg")!;
          const width = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
          return { cx: Number(svg.querySelector("circle")!.getAttribute("cx")), edge: width - (innerWidth < 760 ? 70 : 92), labels: Array.from(svg.querySelectorAll("text")).map(t => t.textContent) };
        }, { month, lastDay });
        expect(result.cx).toBeCloseTo(result.edge);
        if (lastDay === 28) expect(result.labels).not.toContain("29");
      }
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 30000);
});


describe("кэш срезов реестра", () => {
  it("обновляет старую схему кэша, соблюдая часовой антиспам", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-month-cache-"));
    try {
      const history = await fixture();
      delete history.monthViews;
      const cacheFilePath = path.join(dir, "history.json");
      const attemptFilePath = path.join(dir, "last_attempt.json");
      const nowIso = "2026-11-03T05:00:00Z";
      saveEncryptedRegisterHistory(cacheFilePath, history, "test-key");
      fs.utimesSync(cacheFilePath, new Date(nowIso), new Date(nowIso));
      expect(shouldRefreshRegisterHistory({ cacheFilePath, attemptFilePath, nowIso, cachedPayload: history })).toBe(true);
      for (const success of [false, true]) {
        recordRegisterHistoryAttempt(attemptFilePath, { success, timestamp: "2026-11-03T04:30:00Z" });
        expect(shouldRefreshRegisterHistory({ cacheFilePath, attemptFilePath, nowIso, cachedPayload: history })).toBe(false);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("сразу пересобирает кэш, собранный старым расчётом, соблюдая часовой антиспам", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-month-version-"));
    try {
      const history = await fixture();
      expect(history.version).toBe(REGISTER_HISTORY_VERSION);
      const cacheFilePath = path.join(dir, "history.json");
      const attemptFilePath = path.join(dir, "last_attempt.json");
      // 10:00 Алматы, кэш собран в 10:00 — по суточному правилу пересборки нет.
      const nowIso = "2026-11-03T05:00:00Z";
      saveEncryptedRegisterHistory(cacheFilePath, history, "test-key");
      fs.utimesSync(cacheFilePath, new Date(nowIso), new Date(nowIso));
      expect(shouldRefreshRegisterHistory({ cacheFilePath, attemptFilePath, nowIso, cachedPayload: history })).toBe(false);
      const old = { ...history };
      delete old.version;
      expect(shouldRefreshRegisterHistory({ cacheFilePath, attemptFilePath, nowIso, cachedPayload: old })).toBe(true);
      expect(shouldRefreshRegisterHistory({ cacheFilePath, attemptFilePath, nowIso, cachedPayload: { ...history, version: REGISTER_HISTORY_VERSION + 1 } })).toBe(false);
      for (const success of [false, true]) {
        recordRegisterHistoryAttempt(attemptFilePath, { success, timestamp: "2026-11-03T04:30:00Z" });
        expect(shouldRefreshRegisterHistory({ cacheFilePath, attemptFilePath, nowIso, cachedPayload: old })).toBe(false);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("строка текущего месяца в истории считается по последнему файлу, с партнёрскими отдельно", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-month-row-"));
    try {
      const history = await fixture();
      const before = history.months.find((m) => m.month === "2026-11")!;
      expect(before.sale).toBe(11000000);
      const cachePath = path.join(dir, "history.json");
      saveEncryptedRegisterHistory(cachePath, history, "test-key");
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Лист1");
      ws.getRow(1).values = [null, "Дата договора", "Тип продажи", "Контрагент", "Кол-во", "Товар", "Сумма без НДС", "Сумма продажи без НДС", "Менеджер"];
      ws.getRow(2).values = [null, "2026-11-03", "ом", "Новый заказчик", 1, "панель", 100, 222, "Новый менеджер"];
      ws.getRow(3).values = [null, "2026-11-03", "ок", "Тестовый колледж", 1, "мульт сист", 400, 500, "Новый менеджер"];
      const registerFilePath = path.join(dir, "ОП 03.11.26.xlsx");
      await wb.xlsx.writeFile(registerFilePath);
      const reader = { call: async () => [], listAllBatched: async () => [] } as unknown as ReadOnlyBitrixClient;
      const view = await loadRegisterView({ reader, registerFilePath, todayAlmaty: "2026-11-03", historyCachePath: cachePath, secretKey: "test-key", fetchPortal: false });
      const row = view.history!.months.find((m) => m.month === "2026-11")!;
      expect(row).toMatchObject({ sale: 222, contracts: 1, fileName: "ОП 03.11.26.xlsx", partnerSale: 500, partnerContracts: 1 });
      expect(row.byManager.map((m) => [m.name, m.sale])).toEqual([["Новый менеджер", 222]]);
      expect(row.reconciliationPerformed).toBe(before.reconciliationPerformed);
      expect(row.label).toBe(before.label);
      expect(view.history!.months.find((m) => m.month === "2026-10")!.sale).toBe(10000000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("заменяет устаревший срез текущего месяца последним загруженным файлом", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-month-load-"));
    try {
      const history = await fixture();
      const cachePath = path.join(dir, "history.json");
      saveEncryptedRegisterHistory(cachePath, history, "test-key");
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Лист1");
      ws.getRow(1).values = [null, "Дата договора", "Тип продажи", "Контрагент", "Кол-во", "Товар", "Сумма без НДС", "Сумма продажи без НДС", "Менеджер"];
      ws.getRow(2).values = [null, "2026-11-03", "ом", "Новый заказчик", 1, "панель", 100, 222, "Новый менеджер"];
      const registerFilePath = path.join(dir, "ОП 03.11.26.xlsx");
      await wb.xlsx.writeFile(registerFilePath);
      const reader = { call: async () => [], listAllBatched: async () => [] } as unknown as ReadOnlyBitrixClient;
      const view = await loadRegisterView({ reader, registerFilePath, todayAlmaty: "2026-11-03", historyCachePath: cachePath, secretKey: "test-key", fetchPortal: false });
      expect(view.error).toBeUndefined();
      expect(view.history?.monthViews?.["2026-11"].total.sale).toBe(222);
      expect(view.history?.monthViews?.["2026-11"].file).toBe("ОП 03.11.26.xlsx");
      expect(view.history?.monthViews?.["2026-11"].total.hasVal).toBe(false);
      expect(view.history?.monthViews?.["2026-11"]).not.toHaveProperty("history");
      expect(view.history?.monthViews?.["2026-09"].total.sale).toBe(9000000);
      expect(() => JSON.stringify(view)).not.toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
