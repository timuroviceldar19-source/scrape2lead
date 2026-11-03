import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { normalizePlanDeal, collectPlansMonitor, parsePlanMonth, PLAN_DEAL_SELECT_FIELDS } from "../../src/bitrix/salesPult/plans/collect.js";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

const options = { asOfDate: "2026-11-03", portal: "https://crm.example", managerNames: new Map([["7", "Анна"]]) };
function raw(id: number, extra: Record<string, unknown> = {}) {
  return { ID: String(id), TITLE: `[GZ ${id}] Панель — Школа`, CATEGORY_ID: "41", ORIGINATOR_ID: "scrape2lead-gz-plans", ASSIGNED_BY_ID: "7", DATE_CREATE: "2026-11-01T10:00:00+05:00", STAGE_ID: "C41:NEW", CLOSED: "N", OPPORTUNITY: String(id * 1e6), UF_CRM_MONTH: "Ноябрь", UF_CRM_COUNT: "2", UF_CRM_PRICE_PER_UNIT: "500 000,50", UF_CRM_ENSTRU_NAME: "Панель", UF_CRM_6627AEBD7C2D2: "123", UF_CRM_6627AEBD4503E: "Конкурс", ...extra };
}
function fixture() {
  return [raw(1), raw(2, { UF_CRM_MONTH: "2026-10", STAGE_ID: "C41:WORK", DATE_CREATE: "2026-10-01" }),
    raw(3, { UF_CRM_MONTH: "2026-12", UF_CRM_S2L_GZ_OUTCOME: "published:3" }),
    raw(4, { STAGE_SEMANTIC_ID: "S", CLOSED: "Y", UF_CRM_S2L_GZ_OUTCOME: "partner:4" }),
    raw(5, { STAGE_SEMANTIC_ID: "F", CLOSED: "Y", UF_CRM_S2L_GZ_OUTCOME: "lost:5" }),
    raw(6, { STAGE_SEMANTIC_ID: "F", CLOSED: "Y", UF_CRM_PLAN_STATUS: "Отменён" }),
    raw(7, { CATEGORY_ID: "9", UF_CRM_ENSTRU_NAME: "Ноутбук" })].map(d => normalizePlanDeal(d, options)!);
}

describe("монитор планов: модель", () => {
  it("отделяет планы от лотов и чужих сделок, переиспользует маршрутизацию", () => {
    expect(normalizePlanDeal(raw(1), options)?.group).toBe("ИП");
    expect(normalizePlanDeal(raw(1, { CATEGORY_ID: 9 }), options)?.group).toBe("КТ");
    expect(normalizePlanDeal(raw(1, { CATEGORY_ID: 29, UF_CRM_ENSTRU_NAME: "Монитор" }), options)?.group).toBe("КТ");
    expect(normalizePlanDeal(raw(1, { CATEGORY_ID: 29 }), options)?.group).toBe("ИП");
    expect(normalizePlanDeal(raw(1, { CATEGORY_ID: 29, UF_CRM_ENSTRU_NAME: "Техника", UF_CRM_1782386244985_IU_XLS: "ноутбук" }), options)?.group).toBe("КТ");
    for (const extra of [{ ORIGINATOR_ID: "scrape2lead-gz-lots" }, { ORIGIN_ID: "gz-lot:1" }, { ORIGINATOR_ID: "other", TITLE: "Чужая" }, { CATEGORY_ID: 1 }]) {
      expect(normalizePlanDeal(raw(1, extra), options)).toBeNull();
    }
    for (const extra of [{ UF_CRM_PLAN_ID: "42" }, { UF_CRM_1782386293000_IU_XLS: "42" }, { ORIGIN_ID: "gz-plan:42" }, { TITLE: "[GZ 42]" }]) {
      expect(normalizePlanDeal(raw(1, { ORIGINATOR_ID: "", TITLE: "", ...extra }), options)).not.toBeNull();
    }
  });
  it.each([["Ноябрь", "2026-11"], ["январь 2025", "2025-01"], ["11.2026", "2026-11"], ["2026-12", "2026-12"], ["11", "2026-11"], ["13", "2026-10"], ["", "2026-10"]])("месяц %s → %s", (input, expected) => {
    expect(parsePlanMonth(input, "2026-10-01", options.asOfDate)).toBe(expected);
  });
  it("нормализует числа, ссылки, исходы и виды товаров", () => {
    const d = normalizePlanDeal(raw(1, { OPPORTUNITY: "", UF_CRM_1715597423325: "1 234,50", UF_CRM_PLAN_LINK: "javascript:alert(1)" }), options)!;
    expect(d).toMatchObject({ sum: 1234.5, qty: 2, price: 500000.5, managerName: "Анна", customerName: "Школа", planNumber: "1", planUrl: "", isOpen: true, isNewStage: true });
    for (const [key, category] of [["won:1", "won"], ["partner:1", "won"], ["lost:1", "lost"], ["failed:1", "cancelled"], ["repurposed:1", "cancelled"], ["contract-draft:1", "published"], ["", "open"]]) {
      expect(normalizePlanDeal(raw(1, { UF_CRM_S2L_GZ_OUTCOME: key }), options)?.outcomeCategory).toBe(category);
    }
  });
  it("считает полные независимые срезы, менеджеров, способы, товары и заказчиков", () => {
    const v = buildPlansMonitorView(fixture(), options);
    expect(v.ip!.total).toMatchObject({ sum: 21e6, count: 6, qty: 12, customers: 1, openSum: 6e6, openCount: 3, newCount: 2, newSum: 4e6, publishedSum: 3e6, publishedCount: 1, wonSum: 4e6, lostSum: 5e6, cancelledSum: 6e6, createdLast7dCount: 5, createdLast7dSum: 19e6 });
    expect(v.kt!.total.sum).toBe(7e6);
    expect(v.ip!.months.map(m => m.m)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(v.ip!.months[1]).toMatchObject({ sum: 16e6, count: 4, activeSum: 5e6, wonSum: 4e6, newCount: 1 });
    expect(Object.keys(v.ip!.monthViews)).toEqual(["all", "2026-10", "2026-11", "2026-12"]);
    for (const [month, count] of [["all", 6], ["2026-10", 1], ["2026-11", 4], ["2026-12", 1]] as const) {
      const s = v.ip!.monthViews[month];
      expect(s.total.count).toBe(count);
      expect(s.managers[0].count).toBe(count);
      expect(s.methods[0].count).toBe(count);
      expect(s.kinds[0].qty).toBe(count * 2);
      expect(s.customers[0].count).toBe(count);
      expect(s).not.toHaveProperty("monthViews");
    }
    expect(v.ip!.topOpenPlans.map(d => d.id)).toEqual(["3", "2", "1"]);
    expect(v.ip!.managers[0].planList.map(d => d.id)).toEqual(["3", "2", "1"]);
    expect(v.ip!.kinds[0].avgPrice).toBe(21e6 / 12);
    expect(buildPlansMonitorView([], options).ip!.total.count).toBe(0);
  });
  it("читает все категории и закрытые планы, догружает менеджера, изолирует ошибку", async () => {
    const calls: string[] = [];
    const reader = new ReadOnlyBitrixClient({ async call(method, body) {
      calls.push(method);
      if (method === "user.get") return [{ ID: "8", NAME: "Иван", LAST_NAME: "Иванов" }];
      expect(JSON.stringify(body)).toContain("CATEGORY_ID");
      expect(JSON.stringify(body)).not.toContain("filter%5BCLOSED%5D");
      return { result: { p0: [raw(1, { ASSIGNED_BY_ID: "8" })] } };
    } });
    const v = await collectPlansMonitor({ reader, ...options });
    expect(v.ip!.managers[0].name).toBe("Иван Иванов");
    expect(calls).toContain("user.get");
    const broken = new ReadOnlyBitrixClient({ async call() { throw new Error("failed"); } });
    expect(await collectPlansMonitor({ reader: broken, ...options })).toEqual({ asOf: "2026-11-03", error: expect.any(String) });
  });
  it("ограничивает запрос на стороне CRM планами и явно используемыми полями", async () => {
    const reader = new ReadOnlyBitrixClient({ async call() { throw new Error("unexpected transport call"); } });
    const list = vi.spyOn(reader, "listAllBatched").mockResolvedValue([]);
    const users = vi.spyOn(reader, "call");
    await collectPlansMonitor({ reader, ...options });
    expect(list).toHaveBeenCalledExactlyOnceWith("crm.deal.list", {
      filter: { CATEGORY_ID: [9, 41, 29], ORIGINATOR_ID: "scrape2lead-gz-plans" },
      select: PLAN_DEAL_SELECT_FIELDS,
      order: { ID: "ASC" }
    });
    expect(PLAN_DEAL_SELECT_FIELDS).not.toContain("*");
    expect(PLAN_DEAL_SELECT_FIELDS).not.toContain("UF_*");
    expect(new Set(PLAN_DEAL_SELECT_FIELDS).size).toBe(PLAN_DEAL_SELECT_FIELDS.length);
    // Каждый основной и резервный ключ нормализатора должен остаться доступен при узкой проекции.
    const source = fs.readFileSync("src/bitrix/salesPult/plans/collect.ts", "utf8").split("export function normalizePlanDeal")[1].split("export interface CollectPlansOptions")[0];
    const used = [...source.matchAll(/\bd\.([A-Z][A-Z_]+)\b|"(UF_CRM_[A-Z0-9_]+)"/g)].map(m => m[1] || m[2]);
    expect([...new Set(PLAN_DEAL_SELECT_FIELDS)].sort()).toEqual([...new Set(used)].sort());
    expect(users).not.toHaveBeenCalled();
  });
  it("одним запросом загружает всех неизвестных менеджеров и сопоставляет по ID", async () => {
    const reader = new ReadOnlyBitrixClient({ async call() { return [
      { ID: "9", NAME: "Мария", LAST_NAME: "Петрова" }, { ID: "8", NAME: "Иван", LAST_NAME: "Иванов" }
    ]; } });
    vi.spyOn(reader, "listAllBatched").mockResolvedValue([
      raw(1, { ASSIGNED_BY_ID: "8" }), raw(2, { ASSIGNED_BY_ID: "9", CATEGORY_ID: 9 }),
      raw(3, { ASSIGNED_BY_ID: "8" }), raw(4), raw(5, { ASSIGNED_BY_ID: "" })
    ]);
    const users = vi.spyOn(reader, "call");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const view = await collectPlansMonitor({ reader, ...options, userProfiles: new Map([["7", { name: "Анна" }]]) });
      expect(users).toHaveBeenCalledExactlyOnceWith("user.get", { ID: ["8", "9"] });
      expect(view.ip!.managers.find(m => m.id === "8")?.name).toBe("Иван Иванов");
      expect(view.kt!.managers[0].name).toBe("Мария Петрова");
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[Планы\] сделок: 5, ИП: 4, КТ: 1 \(\d+ мс\)$/));
    } finally { log.mockRestore(); }
  });
  it.each([false, true])("при неполном ответе или ошибке user.get сохраняет профиль, конфиг и ID (ошибка=%s)", async fail => {
    const reader = new ReadOnlyBitrixClient({ async call() {
      if (fail) throw new Error("user lookup failed");
      return { result: [{ ID: "8", NAME: "Иван" }] };
    } });
    vi.spyOn(reader, "listAllBatched").mockResolvedValue([raw(1), raw(2, { ASSIGNED_BY_ID: "8" }), raw(3, { ASSIGNED_BY_ID: "9" })]);
    const users = vi.spyOn(reader, "call");
    const view = await collectPlansMonitor({ reader, ...options, userProfiles: new Map([["7", { name: "Профиль" }]]), groups: [{ managers: [{ id: "8", name: "Конфиг" }] }] });
    expect(users).toHaveBeenCalledExactlyOnceWith("user.get", { ID: ["8", "9"] });
    expect(view.ip!.managers.find(m => m.id === "7")?.name).toBe("Профиль");
    expect(view.ip!.managers.find(m => m.id === "8")?.name).toBe(fail ? "Конфиг" : "Иван");
    expect(view.ip!.managers.find(m => m.id === "9")?.name).toBe("ID 9");
  });
  it("ограничивает списки, сортирует и не меняет входные данные", () => {
    const deals = Array.from({ length: 40 }, (_, i) => normalizePlanDeal(raw(i + 1, { UF_CRM_6627AEBD7C2D2: i < 25 ? "shared" : `bin-${i}`, DATE_CREATE: i === 0 ? "2026-11-04" : "2026-10-28" }), options)!);
    const snapshot = JSON.stringify(deals);
    const v = buildPlansMonitorView(deals, options).ip!;
    expect(v.topOpenPlans).toHaveLength(20);
    expect(v.managers[0].planList).toHaveLength(20);
    expect(v.customers).toHaveLength(15);
    expect(v.customers[0].planList).toHaveLength(20);
    expect(v.topOpenPlans[0].id).toBe("40");
    expect(v.total.createdLast7dCount).toBe(39);
    expect(JSON.stringify(deals)).toBe(snapshot);
  });
  it.each([
    [41, "262030.100.000021", "", "Интерактивные панели"], [41, "279020.000.000000", "", "Интерактивные панели"],
    [41, "262030.100.000043", "", "Интерактивные и спец. доски"], [41, "262030.100.000011", "", "Мультимедийные системы"],
    [41, "", "Другое", "Прочее ИП"], [9, "", "Компьютер", "Компьютеры и системные блоки"],
    [9, "", "Ноутбук", "Ноутбуки"], [9, "", "Моноблок", "Моноблоки"], [9, "", "Монитор", "Мониторы"],
    [9, "", "МФУ", "МФУ и принтеры"], [9, "", "Другое", "Прочее КТ"]
  ])("вид товара %s %s %s", (category, code, name, expected) => {
    expect(normalizePlanDeal(raw(1, { CATEGORY_ID: category, UF_CRM_REF_ENSTRU_CODE: code, UF_CRM_ENSTRU_NAME: name, TITLE: "[GZ 1]" }), options)?.kind).toBe(expected);
  });
  it("поддерживает резервные поля, неизвестных менеджеров и изоляцию их ошибок", async () => {
    const row = raw(1, { ASSIGNED_BY_ID: "99", UF_CRM_MONTH: "", UF_CRM_1782386433277_IU_XLS: "декабрь 2027", UF_CRM_COUNT: "", UF_CRM_1713874871715: "3", UF_CRM_ENSTRU_NAME: "", UF_CRM_1713874845756: "Доска", UF_CRM_PLAN_LINK: "https://zakup.gov.kz/plan/1", UF_CRM_6627AEBD4503E: "", UF_CRM_PLAN_STATUS: "Проект договора" });
    const reader = new ReadOnlyBitrixClient({ async call(method) {
      if (method === "user.get") throw new Error("unavailable");
      return { result: { p0: [row] } };
    } });
    const v = await collectPlansMonitor({ ...options, reader });
    expect(v.ip!.topOpenPlans[0]).toMatchObject({ month: "2027-12", qty: 3, itemName: "Доска", method: "Не указан", outcomeCategory: "published", managerName: "ID 99", planUrl: "https://zakup.gov.kz/plan/1" });
    expect(parsePlanMonth("02", "", "2025-11-03")).toBe("2025-02");
    expect(normalizePlanDeal(raw(1, { UF_CRM_COUNT: "0", UF_CRM_PRICE_PER_UNIT: "n/a" }), options)?.qty).toBe(0);
  });
});

describe("монитор планов: Chromium", () => {
  it("переключает оба раздела и полные месячные срезы кнопкой, графиком, клавиатурой и hash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plans-pult-"));
    const payload: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
    payload.plans = buildPlansMonitorView(fixture(), options);
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, renderPultHtml(payload));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("https://fonts.googleapis.com/**", r => r.abort());
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.goto(pathToFileURL(file).href + "#plans-ip");
      const check = async (tab: string, month: string, count: number) => {
        await page.waitForFunction(({ tab, month }) => document.querySelector(`#tab-${tab}`)?.classList.contains("on") && document.querySelector('#planMonths [aria-pressed="true"]')?.getAttribute("data-month") === month, { tab, month });
        expect(await page.locator(`#tab-${tab} section.block`).count()).toBe(5);
        expect(await page.locator(`#tab-${tab} [data-plan-count]`).getAttribute("data-plan-count")).toBe(String(count));
        expect(await page.locator("#periodsNav").isVisible()).toBe(false);
      };
      await check("plans-ip", "all", 6);
      // Семь ячеек открытого плана должны находиться на одной строке на широком экране.
      const positions = await page.locator("#tab-plans-ip .plans-table .r:not(.head)").first().locator(":scope > span").evaluateAll(cells => cells.map(c => c.getBoundingClientRect().top));
      expect(new Set(positions.map(Math.round)).size).toBe(1);
      expect(await page.locator('#planMonths button[data-month="all"]').textContent()).toBe("Все месяцы");
      await page.locator('#planMonths [data-month="2026-10"]').click();
      await check("plans-ip", "2026-10", 1);
      expect(await page.locator("#tab-plans-ip").textContent()).not.toContain("Ноябрь");
      for (const selector of [".share", ".plans-breakdown", ".plans-open", ".plans-customers"]) {
        expect(await page.locator(`#tab-plans-ip ${selector}`).textContent()).toContain("2 млн");
      }
      await page.locator('#tab-plans-ip .months .col[data-m="2026-11"]').click();
      await check("plans-ip", "2026-11", 4);
      await page.locator('#tab-plans-ip .mlabels > span[data-m="2026-12"]').focus();
      await page.keyboard.press("Enter");
      await check("plans-ip", "2026-12", 1);
      await page.locator('#tab-plans-ip .months .col[data-m="2026-12"]').focus();
      await page.keyboard.press("Space");
      await check("plans-ip", "all", 6);
      await page.locator('.sections [data-t="plans-kt"]').click();
      await check("plans-kt", "all", 1);
      await page.evaluate(() => { location.hash = "#plans-kt/2026-11"; });
      await check("plans-kt", "2026-11", 1);
      await page.evaluate(() => { location.hash = "#plans-ip/all"; });
      await check("plans-ip", "all", 6);
      await page.evaluate(() => { location.hash = "#plans-ip/constructor"; });
      await check("plans-ip", "all", 6);
      expect(await page.locator("#srcLabel").textContent()).toBe("CRM Битрикс24 · госзакупки");
      const safety = await page.evaluate(() => {
        const w = window as unknown as { __planMonths: (v: unknown) => string[]; __planViewForMonth: (v: unknown, key: string) => unknown };
        const view = { total: "fallback", monthViews: Object.create({ "2026-11": { total: "inherited" } }) };
        return [w.__planMonths(null), w.__planViewForMonth(null, "all"), w.__planViewForMonth(view, "constructor"), w.__planViewForMonth(view, "2026-11")];
      });
      expect(safety).toEqual([[], null, { total: "fallback", monthViews: {} }, { total: "fallback", monthViews: {} }]);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
