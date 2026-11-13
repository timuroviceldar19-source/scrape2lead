import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { attachRegisterContracts } from "../../src/bitrix/salesPult/contracts.js";
import { buildPultView, renderRegisterHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { buildRegisterView } from "../../src/bitrix/salesPult/register/buildView.js";
import { buildRegisterMonthSummary } from "../../src/bitrix/salesPult/register/history.js";
import type { RegisterRow, RegisterSuccessView } from "../../src/bitrix/salesPult/register/types.js";
import type { NormalizedPlanDeal } from "../../src/bitrix/salesPult/plans/types.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";

// Все данные этого файла выдуманные. Алия Тестовая (ID s) — продажи, Борис Тестовый (ID t) — тендеры.
const task = (id: string, title: string) => ({
  id, dealId: id, title, deadline: "2026-10-28", amount: 1000, isOverdue: true, overdueDays: 2, rank: 1, kind: "overdue" as const, group: 1 as const
});

function planDeal(id: string, managerId: string, managerName: string, extra: Partial<NormalizedPlanDeal> = {}): NormalizedPlanDeal {
  return {
    id, dealUrl: `https://example.invalid/crm/deal/details/${id}/`, planNumber: `P-${id}`, planUrl: "https://example.invalid/plan",
    month: "2026-10", customerName: `Заказчик ${managerName}`, customerBin: `00000000000${id}`.slice(-12), itemName: "Панель интерактивная",
    truCode: "262030.100.000021", kind: "Интерактивные панели", qty: 1, price: 1000, sum: 1000, method: "Запрос ценовых предложений",
    portalStatus: "Опубликован", managerName, isNewStage: false, outcomeCategory: "lost", group: "ИП", managerId,
    dateCreate: "2026-10-01T10:00:00+05:00", outcomeKey: "lost:other", isOpen: false, isWonCrm: false, isLostCrm: true,
    lostTo: { name: `Конкурент ${managerName}`, bin: "999999999999", contractSum: 900 }, ...extra
  };
}

function regRow(manager: string, customer: string, sale: number, extra: Partial<RegisterRow> = {}): RegisterRow {
  return {
    date: "2026-09-10", manager, customer, sale, type: "зцп", product: "панель", qty: 1, cost: sale / 2, extras: 0, portal: sale,
    val: sale / 2, bonusMop: sale / 20, bonusRop: sale / 100, note: null, group: "ИП", kind: "Интерактивные панели",
    channel: "Запрос ценовых предложений", ...extra
  };
}

function sample() {
  const f = fixture();
  attachRegisterContracts(f.payload, f.register, f.deals, f.aliases);
  f.payload.groups[0].managers[0].topTasks = [task("901", "Задача Алии")];
  f.payload.groups[1].managers[0].topTasks = [task("902", "Задача Бориса")];
  f.payload.outcomeMismatches = [
    { id: "d3", title: "Гамма", amount: 900, managerId: "s", managerName: "Алия Тестовая", outcome: "lost:other" },
    { id: "d9", title: "Сигма", amount: 500, managerId: "t", managerName: "Борис Тестовый", outcome: "lost:other" }
  ];
  f.payload.radar = { asOf: "2026-10-28" } as SalesPultPayload["radar"];
  const closed: SalesPultPayload = JSON.parse(JSON.stringify({ ...f.payload, closedMonth: true, closedMonths: undefined, asOfDate: "2026-09-30" }));
  f.payload.closedMonths = { "2026-09": closed };

  const septRows = [regRow("Алия", "Альфа-сентябрь", 300), regRow("Борис", "Дельта-сентябрь", 700), regRow("Неизвестный", "Эпсилон-сентябрь", 50)];
  const septView = buildRegisterView({
    fileName: "ОП 30.09.26.xlsx", asOf: "2026-09-30", month: "2026-09", rows: septRows,
    plans: { Алия: 1000, Борис: 1000, B2B: 500 }, missing: [], extraDealsCount: 0
  }) as RegisterSuccessView;
  const { history: _h, historyError: _e, ...septSnapshot } = septView;
  const register = f.register as RegisterSuccessView;
  register.missing = [
    { date: "2026-10-23", manager: "Алия", customer: "Альфа-нет-в-CRM", sale: 11, products: ["панель"], type: "зцп" },
    { date: "2026-10-23", manager: "Борис", customer: "Дельта-нет-в-CRM", sale: 22, products: ["панель"], type: "зцп" }
  ];
  register.history = {
    asOf: "2026-10-28",
    months: [buildRegisterMonthSummary({ month: "2026-09", fileName: "ОП 30.09.26.xlsx", rows: septRows, plans: { Алия: 1000, Борис: 1000, B2B: 500 } })],
    monthViews: { "2026-09": septSnapshot },
    discipline: {
      missingWorkingDays: ["2026-10-20"], laggedRowsCount: 2,
      laggedByManager: [{ manager: "Алия", count: 1 }, { manager: "Борис", count: 1 }],
      retroChanges: [
        { date: "2026-10-01", manager: "Алия", customer: "Альфа-правка", product: "панель", sale: 1, type: "modified" },
        { date: "2026-10-01", manager: "Борис", customer: "Дельта-правка", product: "панель", sale: 1, type: "deleted" }
      ],
      salesBelowCost: [{ date: "2026-10-02", manager: "Борис", customer: "Дельта-в-минус", product: "панель", sale: 1, cost: 2 }]
    },
    portalMissing: {
      currentMonth: "2026-10", previousMonth: "2026-09", monthlyCounts: { "2026-10": { f3: 3, partner: 1, total: 4 } },
      missingContracts: [{ id: 1, contractNumber: "1", signDate: "2026-10-05", customer: "Портальный заказчик", amountWithVat: 5, method: "ЗЦП", supplier: "F3" }]
    }
  };
  const reg: RegisterPagePayload = {
    asOfDate: "2026-10-28", generatedAt: "2026-10-28 12:00 (UTC+5)", portal: "https://example.invalid",
    register, reconciliation: f.payload.contractSource!.reconciliation
  };
  reg.reconciliation!.closedNotInRegister.push(
    { dealId: "c1", title: "Каппа-закрыта", manager: "Алия Тестовая", amount: 1, date: "2026-10-20" },
    { dealId: "c2", title: "Лямбда-закрыта", manager: "Борис Тестовый", amount: 1, date: "2026-10-20" }
  );
  const planDeals = [planDeal("1", "s", "Алия Тестовая"), planDeal("2", "t", "Борис Тестовый", { group: "КТ" })];
  return { ...f, reg, planDeals };
}

const OTHERS = ["Борис", "Дельта", "Неизвестный", "Эпсилон", "Задача Бориса", "Сигма", "Лямбда", "Портальный заказчик", "Конкурент Борис"];

describe("вид менеджера: данные", () => {
  it("оставляет итоги отдела и только свои строки, чужих имён нет нигде", () => {
    const s = sample();
    const full = buildPultView(s.payload);
    const v = buildManagerVariant({ pult: s.payload, reg: s.reg, planDeals: s.planDeals, managerId: "s", aliases: s.aliases })!;
    const json = JSON.stringify(v);
    for (const other of OTHERS) expect(json, other).not.toContain(other);
    expect(json).toContain("Альфа");
    expect(json).toContain("Задача Алии");

    expect(v.pult.viewer).toEqual({ kind: "manager", managerId: "s", name: "Алия Тестовая" });
    // Итог отдела — как в полном пульте.
    expect(v.view.month.fact).toBe(full.month.fact);
    expect(v.view.month.amount).toBe(full.month.amount);
    expect(v.view.periods.month.sales.totals).toEqual(full.periods.month.sales.totals);
    expect(v.view.periods.month.tenders!.totals).toEqual(full.periods.month.tenders!.totals);
    // Строки — только свои.
    expect(v.view.periods.month.sales.managers.map((m) => m.id)).toEqual(["s"]);
    expect(v.view.periods.day.tenders!.managers).toEqual([]);
    expect(v.view.periods.week.calls.anatomy.map((m) => m.id)).toEqual(["s"]);
    expect(v.pult.groups.flatMap((g) => g.managers.map((m) => m.id))).toEqual(["s"]);
    expect(v.pult.outcomeMismatches!.map((m) => m.managerId)).toEqual(["s"]);
    expect(v.pult.contractSource!.byManager.map((m) => m.id)).toEqual(["s"]);
    expect(v.view.signals.length).toBeGreaterThan(0);
    expect(v.view.signals.every((sig) => sig.text.startsWith("<b>Алия Тестовая</b>"))).toBe(true);
    expect(v.view.signalsUrgent).toBe(v.view.signals.length + 1);
    // «Радар» скрыт, «Планы» собраны только из своих сделок.
    expect(v.pult.radar).toBeNull();
    expect(v.pult.plans!.ip!.total.count).toBe(1);
    expect(v.pult.plans!.kt!.total.count).toBe(0);
    expect(v.pult.plans!.ip!.managers.map((m) => m.id)).toEqual(["s"]);
  });

  it("закрытые месяцы тоже только со своими строками", () => {
    const s = sample();
    const v = buildManagerVariant({ pult: s.payload, reg: s.reg, planDeals: s.planDeals, managerId: "s", aliases: s.aliases })!;
    const closed = v.pult.closedMonths!["2026-09"]!;
    expect(closed.groups.flatMap((g) => g.managers.map((m) => m.id))).toEqual(["s"]);
    expect(v.view.closedMonths["2026-09"]!.periods.month.sales.managers.map((m) => m.id)).toEqual(["s"]);
    expect(v.view.closedMonths["2026-09"]!.signals).toEqual([]);
  });

  it("«Выручка»: свои договоры и бонус, без бонуса РОП, чужих цифр и сверки с порталом", () => {
    const s = sample();
    const v = buildManagerVariant({ pult: s.payload, reg: s.reg, planDeals: s.planDeals, managerId: "s", aliases: s.aliases })!;
    const r = v.reg.register as RegisterSuccessView;
    expect(v.reg.viewer).toEqual({ kind: "manager", managerId: "s", name: "Алия Тестовая" });
    expect(r.rows.map((x) => x.manager)).toEqual(["Алия", "Алия"]);
    expect(r.total).toMatchObject({ sale: 100, plan: 1000, bonusRop: 0, b2bPlan: 0, b2bSale: 0, contracts: 1 });
    expect(r.managers.map((m) => m.name)).toEqual(["Алия"]);
    expect(r.managers[0]).toMatchObject({ missCount: 1, missSum: 11 });
    expect(r.rows.every((x) => x.bonusRop === 0)).toBe(true);
    expect(r.crmDeals).toBeUndefined();
    expect(r.crmExtra).toBe(0);
    expect(r.missing.map((m) => m.customer)).toEqual(["Альфа-нет-в-CRM"]);

    const h = r.history!;
    expect(h.months[0]).toMatchObject({ sale: 300, contracts: 1, plan: 1000 });
    expect(h.months[0].byManager.map((m) => m.name)).toEqual(["Алия"]);
    expect(h.months[0].dailyContracts).toEqual([]);
    expect(h.monthViews!["2026-09"].total.sale).toBe(300);
    expect(h.portalMissing).toBeUndefined();
    expect(h.discipline!.laggedByManager).toEqual([{ manager: "Алия", count: 1 }]);
    expect(h.discipline!.laggedRowsCount).toBe(1);
    expect(h.discipline!.retroChanges.map((c) => c.customer)).toEqual(["Альфа-правка"]);
    expect(h.discipline!.salesBelowCost).toEqual([]);
    expect(v.reg.reconciliation!.closedNotInRegister.map((c) => c.title)).toEqual(["Каппа-закрыта"]);
  });

  it("неизвестный менеджер — варианта нет; без списка сделок «Планы» не отдаются целиком", () => {
    const s = sample();
    expect(buildManagerVariant({ pult: s.payload, reg: s.reg, planDeals: s.planDeals, managerId: "404", aliases: s.aliases })).toBeNull();
    const v = buildManagerVariant({ pult: s.payload, reg: s.reg, planDeals: null, managerId: "s", aliases: s.aliases })!;
    expect(v.pult.plans).toMatchObject({ error: expect.any(String) });
    expect(v.pult.plans!.ip).toBeUndefined();
  });

  it("заметки по звонкам — без имён, только темп отдела", () => {
    const s = sample();
    const v = buildManagerVariant({ pult: s.payload, reg: s.reg, planDeals: s.planDeals, managerId: "t", aliases: s.aliases })!;
    for (const p of ["day", "week", "month"] as const) {
      for (const note of v.view.periods[p].calls.notes) expect(note).not.toMatch(/Алия|<b>/);
    }
    expect(JSON.stringify(v)).not.toContain("Алия");
  });
});

describe("вид менеджера: страницы", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  for (const width of [1440, 375]) {
    it(`пульт закреплён за менеджером, «Радара» нет, на ${width}`, async () => {
      const s = sample();
      const pages = renderManagerVariant(buildManagerVariant({ pult: s.payload, reg: s.reg, planDeals: s.planDeals, managerId: "s", aliases: s.aliases })!);
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.addInitScript(() => { try { localStorage.setItem("pult-me", "t"); } catch { /* нет хранилища */ } });
        await page.setContent(pages.index);
        const select = page.locator("#meSelect");
        expect(await select.inputValue()).toBe("s");
        expect(await select.isDisabled()).toBe(true);
        expect(await select.locator("option").allTextContents()).toEqual(["Алия Тестовая"]);
        expect(await page.locator('.sections a[data-t="radar"]').count()).toBe(0);
        expect(await page.locator("#sales .team-all").count()).toBe(0);
        expect(await page.locator("#tasks").innerText()).toContain("Задача Алии");
        expect(await page.locator("body").innerText()).not.toContain("Борис");
        await page.evaluate(() => { location.hash = "#radar-ip"; });
        await page.waitForTimeout(200);
        expect(await page.locator("#tab-pult").getAttribute("class")).toContain("on");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 20000);

    it(`«Выручка» менеджера без «Радара» и бонуса РОП, на ${width}`, async () => {
      const s = sample();
      const pages = renderManagerVariant(buildManagerVariant({ pult: s.payload, reg: s.reg, planDeals: s.planDeals, managerId: "s", aliases: s.aliases })!);
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.setContent(pages.reg);
        expect(await page.locator('a[href="./#radar-ip"]').count()).toBe(0);
        const text = await page.locator("body").innerText();
        expect(text).not.toContain("Бонус РОП");
        expect(text).not.toContain("Борис");
        expect(text).toContain("Альфа");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 20000);
  }
});

describe("«Выручка» на телефоне", () => {
  it("история по месяцам и дисциплина не растягивают полную страницу на 375", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.setContent(renderRegisterHtml(sample().reg));
      expect(await page.locator("#r-history").count()).toBe(1);
      expect(await page.locator("#r-discipline").count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await browser.close(); }
  }, 20000);
});

describe("вид менеджера: сборка вариантов при выкладке", () => {
  function run(config: unknown) {
    const s = sample();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-variants-"));
    const src = path.join(dir, "src"); const out = path.join(dir, "out"); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "index.html"), "ПОЛНЫЙ ПУЛЬТ");
    fs.writeFileSync(path.join(src, "reg.html"), "ПОЛНАЯ ВЫРУЧКА");
    fs.writeFileSync(path.join(src, "payload.json"), JSON.stringify(s.payload));
    fs.writeFileSync(path.join(src, "payload-reg.json"), JSON.stringify(s.reg));
    fs.writeFileSync(path.join(src, "plan-deals.json"), JSON.stringify(s.planDeals));
    const configPath = path.join(dir, "config.json"); fs.writeFileSync(configPath, JSON.stringify(config));
    const res = spawnSync("npx", ["tsx", "scripts/pult-variants.mts", src, out, configPath], { encoding: "utf8" });
    return { res, out };
  }
  const ls = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).filter((p) => p.endsWith(".html")).sort();

  it("без ролей кладёт только полный вариант", () => {
    const { res, out } = run(null);
    expect(res.status, res.stderr).toBe(0);
    expect(ls(out)).toEqual(["_r/all/index.html", "_r/all/reg.html"]);
    expect(fs.readFileSync(path.join(out, "_r/all/index.html"), "utf8")).toBe("ПОЛНЫЙ ПУЛЬТ");
  }, 30000);

  it("собирает вариант каждого менеджера из ролей, неизвестного пропускает, почты не печатает", () => {
    const config = { team: "example-team", users: {
      "boss@example.test": { kind: "all" }, "seller@example.test": { kind: "manager", managerId: "s" },
      "ghost@example.test": { kind: "manager", managerId: "404" }, "tv@example.test": { kind: "tv" }
    } };
    const { res, out } = run(config);
    expect(res.status, res.stderr).toBe(0);
    expect(ls(out)).toEqual(["_r/all/index.html", "_r/all/reg.html", "_r/ms/index.html", "_r/ms/reg.html"]);
    const html = fs.readFileSync(path.join(out, "_r/ms/index.html"), "utf8");
    expect(html).toContain("Задача Алии");
    expect(html).not.toContain("Борис");
    expect(res.stdout + res.stderr).toMatch(/404/);
    expect(res.stdout + res.stderr).not.toMatch(/example\.test/);
  }, 60000);
});

