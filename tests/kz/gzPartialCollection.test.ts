import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ page: { goto: vi.fn(), content: vi.fn(), waitForTimeout: vi.fn() }, close: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch: async () => ({
  newContext: async () => ({ newPage: async () => browser.page, close: browser.close }), close: browser.close
}) } }));
import { collectGzPlans } from "../../src/kz/goszakupPlanCollector.js";
import { exportGoszakupLotsByNstru } from "../../src/kz/goszakupLotsNstruExporter.js";

const dirs: string[] = [];
function dir() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "gz-partial-")); dirs.push(value); return value; }
beforeEach(() => { vi.resetAllMocks(); browser.page.waitForTimeout.mockResolvedValue(undefined); });
afterEach(() => { for (const value of dirs.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });
const timeout = () => new Error("page.goto: Timeout 90000ms exceeded.");
const empty = '<table id="search-result"><tbody></tbody></table>';
function plansHtml() {
  return `<strong>Показано c 1 по 1 из 51 записей</strong><a href="?page=2">2</a>
    <table id="search-result"><tbody><tr><td><a href="/ru/registry/show_plan/101/1">101</a></td>
    <td>Заказчик</td><td>Компьютер</td><td>Конкурс</td><td>Штука</td><td>1</td>
    <td>500000</td><td>500000</td><td>Декабрь</td><td>Утвержден</td></tr></tbody></table>`;
}
function planOptions() { const root = dir(); return {
  keywords: ["Компьютер"], year: 2026, months: [11, 12], maxPages: 0, delayMs: 0, pageLoadRetries: 2,
  databasePath: path.join(root, "db.sqlite"), debugDir: root, partialCollection: true, token: null
}; }

describe("partial GZ plan collection", () => {
  it("keeps the first page when the second page times out in all attempts", async () => {
    const options = planOptions();
    browser.page.goto.mockImplementation(async (url: string) => { if (new URL(url).searchParams.get("page") === "2") throw timeout(); });
    browser.page.content.mockResolvedValue(plansHtml());
    const result = await collectGzPlans(options);
    expect(result.items.map(item => item.plan_point_id)).toEqual(["101"]);
    expect(result).toMatchObject({ successfulQueries: 1, skippedQueries: [{ stage: "plans", query: "Компьютер", year: 2026,
      months: [11, 12], failedPage: 2, totalPages: 2, keptRows: 1, attempts: 3 }] });
  });

  it("opens the breaker after three first-page failures and records unattempted queries", async () => {
    browser.page.goto.mockRejectedValue(timeout());
    const result = await collectGzPlans({ ...planOptions(), keywords: ["a", "b", "c", "d", "e"] });
    expect(browser.page.goto).toHaveBeenCalledTimes(9);
    expect(result).toMatchObject({ items: [], successfulQueries: 0, skippedQueries: [
      { query: "a", failedPage: 1, attempts: 3 }, { query: "b", attempts: 3 }, { query: "c", attempts: 3 },
      { query: "d", attempts: 0, reason: "circuit_breaker: portal unreachable" },
      { query: "e", attempts: 0, reason: "circuit_breaker: portal unreachable" }
    ] });
  });

  it("resets the failure streak on a valid empty response", async () => {
    browser.page.goto.mockImplementation(async (url: string) => { if (new URL(url).searchParams.get("filter[name]") !== "ok") throw timeout(); });
    browser.page.content.mockResolvedValue(empty);
    const result = await collectGzPlans({ ...planOptions(), keywords: ["a", "b", "ok", "c", "d", "e", "f"] });
    expect(browser.page.goto).toHaveBeenCalledTimes(16);
    expect(result).toMatchObject({ successfulQueries: 1 });
  });

  it("supports a configured breaker threshold", async () => {
    browser.page.goto.mockRejectedValue(timeout());
    const result = await collectGzPlans({ ...planOptions(), keywords: ["a", "b"], maxConsecutiveNetworkFailures: 1 });
    expect(browser.page.goto).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ skippedQueries: [{ attempts: 3 }, { attempts: 0 }] });
  });

  it("leaves a successful empty query distinguishable from an outage", async () => {
    browser.page.goto.mockResolvedValue(null); browser.page.content.mockResolvedValue(empty);
    expect(await collectGzPlans(planOptions())).toMatchObject({ items: [], successfulQueries: 1, skippedQueries: [] });
  });

  it("does not turn programming errors into skipped queries", async () => {
    browser.page.goto.mockRejectedValue(new TypeError("invalid query schema"));
    await expect(collectGzPlans(planOptions())).rejects.toThrow("invalid query schema");
  });

  it("preserves strict failure behavior outside automation", async () => {
    browser.page.goto.mockRejectedValue(timeout());
    await expect(collectGzPlans({ ...planOptions(), partialCollection: false })).rejects.toThrow("Timeout");
  });

  it("reports a maintenance page as unavailable rather than a valid empty result", async () => {
    browser.page.goto.mockResolvedValue(null); browser.page.content.mockResolvedValue("Технические работы");
    expect(await collectGzPlans(planOptions())).toMatchObject({ successfulQueries: 0, skippedQueries: [{ failedPage: 1 }] });
  });
});

describe("partial GZ lots collection", () => {
  it("reports an empty successful lot search without omissions", async () => {
    const root = dir(); browser.page.goto.mockResolvedValue(null); browser.page.content.mockResolvedValue(empty);
    expect(await exportGoszakupLotsByNstru({ keywords: ["Компьютер"], months: [11], outPath: path.join(root, "empty.xlsx"),
      debugDir: root, delayMs: 0, partialCollection: true })).toMatchObject({ rows: 0, successfulQueries: 1, skippedQueries: [] });
  });
  it("does not swallow programming errors or write a misleading empty workbook", async () => {
    const root = dir(); const outPath = path.join(root, "lots.xlsx"); browser.page.goto.mockRejectedValue(new TypeError("invalid schema"));
    await expect(exportGoszakupLotsByNstru({ keywords: ["Компьютер"], months: [11], outPath, debugDir: root,
      delayMs: 0, partialCollection: true })).rejects.toThrow("invalid schema");
    expect(browser.page.goto).toHaveBeenCalledTimes(1); expect(fs.existsSync(outPath)).toBe(false);
  });
  it("keeps collected lot pages and writes them to the workbook", async () => {
    const root = dir();
    browser.page.goto.mockImplementation(async (url: string) => { if (new URL(url).searchParams.get("page") === "2") throw timeout(); });
    browser.page.content.mockResolvedValue(`<strong>Показано c 1 по 50 из 51 записей</strong><a href="?page=2">2</a>
      <table id="search-result"><tbody><tr role="row"><td><strong>101-ЗЦП1</strong></td>
      <td><a href="/ru/announce/index/1">Закупка</a></td><td><strong>Компьютер</strong></td>
      <td>1</td><td><strong>1000000</strong></td><td>Конкурс</td><td>Опубликован</td></tr></tbody></table>`);
    const options = { nstruCodes: ["262011.100.000000"], year: 2026, months: [11], debugDir: root,
      outPath: path.join(root, "lots.xlsx"), delayMs: 0, pageLoadAttempts: 2, pageLoadRetryDelayMs: 0, partialCollection: true };
    const result = await exportGoszakupLotsByNstru(options);
    expect(result).toMatchObject({ rows: 1, successfulQueries: 1, skippedQueries: [{ stage: "lots", failedPage: 2, totalPages: 2, keptRows: 1, attempts: 2 }] });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(result.xlsxPath);
    expect(workbook.worksheets[0].getRow(2).getCell(3).value).toBe("101-ЗЦП1");
  });

  it("records every remaining code/month without navigation once the breaker opens", async () => {
    const root = dir(); browser.page.goto.mockRejectedValue(timeout());
    const result = await exportGoszakupLotsByNstru({ nstruCodes: ["a", "b"], months: [1, 2, 3], year: 2027,
      debugDir: root, outPath: path.join(root, "lots.xlsx"), delayMs: 0,
      pageLoadAttempts: 2, pageLoadRetryDelayMs: 0, partialCollection: true });
    expect(browser.page.goto).toHaveBeenCalledTimes(6);
    expect(result).toMatchObject({ rows: 0, successfulQueries: 0, skippedQueries: [
      { query: "a", months: [1] }, { query: "a", months: [2] }, { query: "a", months: [3] },
      { query: "b", months: [1], attempts: 0 }, { query: "b", months: [2], attempts: 0 }, { query: "b", months: [3], attempts: 0 }
    ] });
  });
});
