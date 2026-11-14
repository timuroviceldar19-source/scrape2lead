import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import { collectPlansMonitor } from "../../src/bitrix/salesPult/plans/collect.js";
import type { NormalizedPlanDeal, PlanOutcome } from "../../src/bitrix/salesPult/plans/types.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

// Все имена, закупки и суммы выдуманы.
function deals(): NormalizedPlanDeal[] {
  const list: NormalizedPlanDeal[] = [];
  const add = (group: "ИП" | "КТ", month: string, managerId: string, outcomeCategory: PlanOutcome, count: number, sum: number) => {
    for (let i = 0; i < count; i++) list.push({
      id: String(list.length + 1), group, month, managerId, managerName: `Вымышленный ${managerId}`,
      sum, qty: 1, price: sum, customerName: "Выдуманная школа", customerBin: "000000000000",
      itemName: "Тестовый товар", truCode: "", kind: "Тестовый вид", method: "Тестовый способ",
      portalStatus: "Тестовый статус", dateCreate: "2026-11-01", isOpen: outcomeCategory === "open",
      isNewStage: false, outcomeCategory, outcomeKey: outcomeCategory,
      isWonCrm: false, isLostCrm: false, dealUrl: "https://example.com/deal", planUrl: "https://example.com/plan", planNumber: "123"
    });
  };
  for (const group of ["ИП", "КТ"] as const) {
    add(group, "2026-11", "Альфа", "won", 3, 100e6);
    add(group, "2026-11", "Альфа", "open", 1, 50e6);
    add(group, "2026-11", "Ушедший", "open", 2, 400e6);
    add(group, "2026-11", "Ушедший", "lost", 1, 300e6);
    add(group, "2026-10", "Бета", "won", 1, 10e6);
    add(group, "2026-10", "Неактивный", "lost", 2, 5e6);
  }
  return list;
}

describe("ушедшие сотрудники на «Планах»: модель", () => {
  it("убирает их строки из таблицы менеджеров, но не из итогов, по каждому срезу", () => {
    const view = buildPlansMonitorView(deals(), { asOfDate: "2026-11-14", formerManagerIds: ["Ушедший", "Неактивный"] });
    for (const group of [view.ip!, view.kt!]) {
      expect(group.managers.map(m => m.id)).toEqual(["Альфа", "Бета"]);
      expect(group.total).toMatchObject({ count: 10, wonCount: 4, lostCount: 3, openCount: 3 });
      expect(group.formerManagers).toEqual({ people: 2, count: 5, sum: 1110e6, openCount: 2, openSum: 800e6 });
      expect(group.monthViews["2026-11"].managers.map(m => m.id)).toEqual(["Альфа"]);
      expect(group.monthViews["2026-11"].formerManagers).toEqual({ people: 1, count: 3, sum: 1100e6, openCount: 2, openSum: 800e6 });
      expect(group.monthViews["2026-10"].formerManagers).toEqual({ people: 1, count: 2, sum: 10e6, openCount: 0, openSum: 0 });
      // Открытые закупки ушедших остаются в списке «Открытые планы»: их нужно передать действующим.
      expect(group.openPlans.filter(d => d.managerId === "Ушедший")).toHaveLength(2);
      expect(group.lostTo.lostCount).toBe(3);
    }
  });

  it("без списка ушедших таблица прежняя и признака formerManagers нет", () => {
    const view = buildPlansMonitorView(deals(), { asOfDate: "2026-11-14" });
    expect(view.ip!.managers.map(m => m.id)).toEqual(["Ушедший", "Альфа", "Бета", "Неактивный"]);
    expect("formerManagers" in view.ip!).toBe(false);
    expect("formerManagers" in view.ip!.monthViews["2026-10"]).toBe(false);
  });
});

describe("ушедшие сотрудники на «Планах»: сборщик", () => {
  const raw = (id: number, manager: string) => ({
    ID: String(id), TITLE: `[GZ ${id}] Панель — Школа`, CATEGORY_ID: "41", ORIGINATOR_ID: "scrape2lead-gz-plans",
    ASSIGNED_BY_ID: manager, DATE_CREATE: "2026-11-01T10:00:00+05:00", STAGE_ID: "C41:NEW", CLOSED: "N",
    OPPORTUNITY: String(id * 1e6), UF_CRM_MONTH: "Ноябрь", UF_CRM_COUNT: "1", UF_CRM_PRICE_PER_UNIT: "1",
    UF_CRM_ENSTRU_NAME: "Панель", UF_CRM_6627AEBD7C2D2: String(100 + id), UF_CRM_6627AEBD4503E: "Конкурс"
  });

  it("скрывает ушедших из конфига и неактивных в Битриксе, но не действующие группы пульта", async () => {
    const reader = new ReadOnlyBitrixClient({ async call(method, body) {
      expect(method).toBe("im.user.get");
      const id = (body as { ID: number }).ID;
      return { name: `Сотрудник ${id}`, active: id !== 9 && id !== 11 };
    } });
    vi.spyOn(reader, "listAllBatched").mockResolvedValue(
      [raw(1, "7"), raw(2, "8"), raw(3, "9"), raw(4, "10"), raw(5, "11"), raw(6, "12")]
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const view = await collectPlansMonitor({
        reader, asOfDate: "2026-11-14", portal: "https://crm.example",
        // 7 — действующий, 10 — неактивен по профилю пульта, 12 — в группе пульта, хотя Битрикс считает неактивным.
        userProfiles: new Map([["7", { name: "Профиль 7" }], ["10", { name: "Профиль 10", active: false }], ["12", { name: "Профиль 12", active: false }]]),
        groups: [{ managers: [{ id: "12", name: "Группа 12" }] }],
        formerManagerIds: ["8"]
      });
      expect(view.ip!.managers.map(m => m.id).sort()).toEqual(["12", "7"]);
      expect(view.ip!.formerManagers).toMatchObject({ people: 4, count: 4 });
      expect(view.ip!.total.count).toBe(6);
      expect(log).toHaveBeenCalledWith("[Планы] ушедшие сотрудники вне таблицы менеджеров: 4");
    } finally { log.mockRestore(); }
  });
});

describe("ушедшие сотрудники: config/sales-pult.json", () => {
  it("ушедший не может одновременно быть в группе пульта", () => {
    const config = JSON.parse(fs.readFileSync("config/sales-pult.json", "utf8")) as {
      groups: Array<{ managers: Array<{ id: string; name: string }> }>;
      formerManagers?: Array<{ id: string; name: string }>;
    };
    const inGroups = new Set(config.groups.flatMap(g => g.managers.map(m => m.id)));
    for (const m of config.formerManagers ?? []) {
      expect(m.id).toMatch(/^\d+$/);
      expect(m.name.trim()).not.toBe("");
      expect(inGroups.has(m.id)).toBe(false);
    }
  });
});

// Разделитель разрядов в ru-RU — неразрывный пробел; сравниваем текст с обычными пробелами.
const text = (value: string | null) => (value ?? "").replace(/\s+/g, " ");

async function withPage(width: number, payload: SalesPultPayload, run: (page: Page) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-former-"));
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

function payload(formerManagerIds?: string[]): SalesPultPayload {
  const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
  p.plans = buildPlansMonitorView(deals(), { asOfDate: "2026-11-14", formerManagerIds });
  return p;
}

describe("ушедшие сотрудники на «Планах»: Chromium", () => {
  it.each([1440, 375])("строка под таблицей, места без пропусков, смена месяца, %s px", async width => {
    await withPage(width, payload(["Ушедший", "Неактивный"]), async page => {
      for (const product of ["ip", "kt"]) {
        await page.locator('.sections [data-t="plans"]').click();
        await page.locator(`#productSwitch [data-product="${product}"]`).click();
        const share = page.locator(`#tab-plans-${product} .share`);
        expect(await share.locator(".nm").allTextContents()).toEqual(["Вымышленный Альфа", "Вымышленный Бета"]);
        expect(await share.locator(".r:not(.head) .rk").allTextContents()).toEqual(["1", "2"]);
        const note = share.locator(".plan-former");
        expect(text(await note.textContent())).toBe(
          "Ушедшие сотрудники в таблице не показаны (2 чел.): 5 закупок на 1 110 млн ₸, из них в работе 2 на 800 млн ₸. В итогах страницы они учтены."
        );
        expect(await note.locator("b.bad").textContent()).toBe("в работе 2");
        await page.locator('#planMonths [data-month="2026-10"]').click();
        expect(await share.locator(".nm").allTextContents()).toEqual(["Вымышленный Бета"]);
        expect(text(await share.locator(".plan-former").textContent())).toBe(
          "Ушедшие сотрудники в таблице не показаны (1 чел.): 2 закупки на 10 млн ₸, из них в работе нет. В итогах страницы они учтены."
        );
        await page.locator('#planMonths [data-month="all"]').click();
        if (width === 375) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    });
  });

  it("без ушедших строки нет", async () => {
    await withPage(1440, payload(), async page => {
      await page.locator('.sections [data-t="plans"]').click();
      expect(await page.locator("#tab-plans-ip .share .plan-former").count()).toBe(0);
      expect(await page.locator("#tab-plans-ip .share .nm").count()).toBe(4);
    });
  });
});
