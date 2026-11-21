import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { buildRegisterRisks } from "../../src/bitrix/salesPult/register/risks.js";
import { buildRegisterView } from "../../src/bitrix/salesPult/register/buildView.js";
import { buildRegisterMonthSummary } from "../../src/bitrix/salesPult/register/history.js";
import type { RegisterContract, RegisterRow, RegisterSuccessView } from "../../src/bitrix/salesPult/register/types.js";
import { renderRegisterHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";

// Все строки, названия и идентификаторы выдуманы.
function row(customer: string, extra: Partial<RegisterRow> = {}): RegisterRow {
  return {
    customer, manager: "Алия", date: "2026-10-31", type: "зцп", qty: 1, product: "Панель",
    cost: 80_000, extras: 0, sale: 100_000, portal: 112_000, val: 20_000,
    bonusMop: 0, bonusRop: 0, note: null, group: "ИП", kind: "Панели", channel: "ЗЦП", ...extra
  };
}

function missing(r: RegisterRow): RegisterContract {
  return { ...r, lines: 1, products: [r.product] };
}

function sample(): RegisterPagePayload & { register: RegisterSuccessView } {
  const rows = [
    row("Заказчик убытка", { cost: 120_000, val: -25_000, portal: 142_000 }),
    row("Заказчик низкой маржи", { val: 5_000 }),
    row("Чужой заказчик", { manager: "Борис", val: -1_000 }),
    row("Партнёрский заказчик", { partner: true, val: 5_000 })
  ];
  const past = [row("Заказчик сентября", { date: "2026-09-30", val: 4_000 })];
  const currentMissing = [missing(row("Только в октябрьском ОП"))];
  const previous = buildRegisterView({
    month: "2026-09", asOf: "2026-09-30", fileName: "ОП-сентябрь.xlsx", rows: past,
    plans: {}, missing: past.map(missing), extraDealsCount: 0
  }) as RegisterSuccessView;
  const plans = { Алия: 200_000, Борис: 100_000 };
  const register = buildRegisterView({
    month: "2026-10", asOf: "2026-10-31", fileName: "ОП-октябрь.xlsx", rows,
    plans, missing: currentMissing, extraDealsCount: 1,
    history: {
      asOf: "2026-10-31",
      monthViews: { "2026-09": previous },
      months: [
        { ...buildRegisterMonthSummary({ month: "2026-09", fileName: previous.file, rows: past, plans: {} }),
          reconciliationPerformed: true, missingCrm: past.map(missing) },
        { ...buildRegisterMonthSummary({ month: "2026-10", fileName: "ОП-октябрь.xlsx", rows, plans }),
          reconciliationPerformed: true, missingCrm: currentMissing }
      ],
      portalMissing: {
        currentMonth: "2026-10", previousMonth: "2026-09", monthlyCounts: {},
        missingContracts: [
          { id: " test/123 ", contractNumber: "ДОГОВОР".repeat(16), signDate: "2026-10-02",
            customer: "Портальный заказчик", amountWithVat: 125_000, method: "ЗЦП", supplier: "Поставщик" },
          { id: "", contractNumber: "Без идентификатора", signDate: "2026-10-04",
            customer: "Другой заказчик", amountWithVat: 10_000, method: "ЗЦП", supplier: "Поставщик" }
        ]
      },
      discipline: {
        missingWorkingDays: ["2026-10-23"], laggedRowsCount: 0, laggedByManager: [],
        salesBelowCost: [rows[0]],
        retroChanges: [{ ...rows[0], type: "modified", note: "Изменено в Файл от 31.10.xlsx: Менеджер: Чужой менеджер → Алия",
          diff: { sale: { before: 90_000, after: 100_000 }, manager: { before: "Чужой менеджер", after: "Алия" } } }]
      }
    }
  }) as RegisterSuccessView;
  return {
    asOfDate: "2026-10-31", generatedAt: "Тест", portal: "https://example.invalid", register,
    reconciliation: {
      closedNotInRegister: [{ dealId: "demo-101", title: "Только в CRM", manager: "Алия", amount: 100_000, date: "2026-10-30" }],
      possibleDuplicates: []
    }
  };
}

describe("риски по строкам реестра", () => {
  it("считает и сортирует убыток и низкую маржу, учитывая наличие вала и партнёрство", () => {
    const rows = [
      row("Закуп выше продажи", { cost: 110_000, val: null }),
      row("Отрицательный вал", { val: -25_000 }),
      row("Оба признака", { cost: 115_000, val: -20_000, partner: true }),
      row("Нулевой вал", { val: 0 }),
      row("Меньше 10%", { sale: 200_000, val: 19_999 }),
      row("Ровно 10%", { val: 10_000 }),
      row("Партнёр", { val: 5_000, partner: true }),
      row("Вал неизвестен", { val: null })
    ];
    const risks = buildRegisterRisks(rows, true);
    expect(risks.belowCost).toMatchObject({ count: 3, loss: 55_000, rows: [
      { customer: "Отрицательный вал", loss: 25_000 }, { customer: "Оба признака", loss: 20_000 },
      { customer: "Закуп выше продажи", loss: 10_000 }
    ] });
    expect(risks.lowMargin).toMatchObject({ count: 2, sale: 300_000, rows: [
      { customer: "Меньше 10%" }, { customer: "Нулевой вал" }
    ] });
    expect(buildRegisterRisks(rows, false)).toMatchObject({ belowCost: { count: 2, loss: 25_000 }, lowMargin: { count: 0 } });
  });

  it("суммирует расхождения по модулю и исключает НДС, допуски и незаполненные суммы", () => {
    const risks = buildRegisterRisks([
      row("НДС 12%"),
      row("В допуске НДС", { portal: 113_400 }),
      row("Допуск 10 тысяч", { portal: 90_000 }),
      row("Допуск 1%", { sale: 2_000_000, portal: 2_020_000 }),
      row("Без портала", { portal: 0 }),
      row("Без продажи", { sale: 0 }),
      row("Занижено", { portal: 70_000 }),
      row("Завышено", { portal: 145_000 })
    ], true);
    expect(risks.portalMismatch).toMatchObject({ count: 2, difference: 75_000, rows: [
      { customer: "Завышено", difference: 45_000 }, { customer: "Занижено", difference: -30_000 }
    ] });
  });
});

describe("страница «Выручка»", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([375, 1440])("сигналы, действия и таблицы при ширине %i px", async (width) => {
    const payload = sample();
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    try {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("https://fonts.**", route => route.abort());
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: (text: string) => { document.documentElement.dataset.copied = text; return Promise.resolve(); }
      } }));
      await page.setContent(renderRegisterHtml(payload));
      const risks = page.locator("#r-month + #r-risks");
      expect(await risks.isVisible()).toBe(true);
      expect(await risks.locator(".gsum").count()).toBe(0);
      expect(await page.locator(".gsum").first().textContent()).toContain("ИП · интерактивные панели");
      expect(await risks.locator("summary").allTextContents()).toEqual(expect.arrayContaining([
        expect.stringContaining("Убыточные"), expect.stringContaining("Низкая маржа"), expect.stringContaining("Расхождение")
      ]));
      await risks.locator("summary").filter({ hasText: "Низкая маржа" }).click();
      expect(await risks.getByText("Заказчик низкой маржи", { exact: true }).isVisible()).toBe(true);
      expect(await risks.textContent()).not.toContain("Партнёрский заказчик");
      await risks.locator("summary").filter({ hasText: "Убыточные" }).click();
      for (const [section, expected] of [
        ["#r-risks", "Заказчик убытка"], ["#r-missing", "Только в октябрьском ОП"],
        ["#r-reconciliation", "https://example.invalid/crm/deal/details/demo-101/"],
        ["#r-portal", "https://procurement.gov.kz/ru/egzcontract/cpublic/show/test%2F123"]
      ]) {
        await page.locator(section).getByRole("button", { name: "Скопировать для чата" }).first().click();
        expect(await page.locator("html").getAttribute("data-copied")).toContain(expected);
      }
      for (const id of ["r-missing", "r-reconciliation", "r-portal"]) {
        await risks.locator(`a[href="#${id}"]`).press("Enter");
        const gap = await page.locator(`#${id}`).evaluate(node => {
          const bar = document.querySelector(".bar")!;
          const dateline = document.querySelector(".dateline")!;
          return node.getBoundingClientRect().top - bar.getBoundingClientRect().bottom
            - (getComputedStyle(dateline).position === "sticky" ? dateline.getBoundingClientRect().height : 0);
        });
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThanOrEqual(20);
      }
      const portal = page.locator("#r-portal");
      expect(await portal.locator("a").count()).toBe(1);
      expect(await portal.locator("a").getAttribute("href")).toBe("https://procurement.gov.kz/ru/egzcontract/cpublic/show/test%2F123");
      expect(await page.locator("#r-discipline").textContent()).toContain("Файл от 31.10");
      expect(await page.locator("#r-discipline").textContent()).toContain("→");
      const axis = () => page.locator("#regChart svg").getAttribute("viewBox");
      const initialAxis = await axis();
      const positions = await page.locator("#regChart svg text").evaluateAll(nodes =>
        nodes.filter(node => /млн|план /.test(node.textContent || "")).map(node => Number(node.getAttribute("y")))
      );
      expect(Math.abs(positions[0] - positions[1])).toBeGreaterThanOrEqual(22);

      const mgr = page.locator(".mgr .r.body").first();
      const hist = page.locator("#r-history .r.body").first();
      if (width === 375) {
        expect(await page.locator(".dateline").evaluate(node => getComputedStyle(node).position)).toBe("static");
        for (const expandable of [mgr, hist]) {
          expect(await expandable.locator(".chev").isVisible()).toBe(true);
          await expandable.press("Enter");
          expect(await expandable.getAttribute("aria-expanded")).toBe("true");
        }
        expect(await page.locator("#regAll .r:not(.head) [data-l='Маржа']").first().evaluate(node =>
          getComputedStyle(node, "::before").content)).toBe('"Маржа"');
        expect(await page.locator("#tab-reg .r:not(.head) > :not([data-l])").count()).toBe(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.setViewportSize({ width: width === 375 ? 1440 : 375, height: 900 });
      await expect.poll(axis).not.toBe(initialAxis);

      await page.locator('#registerMonths [data-month="2026-09"]').click();
      const history = page.locator("#r-crm-history");
      expect(await history.textContent()).toContain("Заказчик сентября");
      expect(await history.textContent()).not.toContain("Только в октябрьском ОП");
      expect(await risks.textContent()).toContain("Заказчик сентября");
      expect(await risks.textContent()).not.toContain("Заказчик убытка");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  it("показывает одну ошибку истории и считает риски из строк старого кэша", async () => {
    const payload = sample();
    const { history: _history, ...withoutHistory } = payload.register;
    Reflect.deleteProperty(withoutHistory, "risks");
    const page = await browser.newPage();
    try {
      await page.route("https://fonts.**", route => route.abort());
      await page.setContent(renderRegisterHtml({ ...payload, register: { ...withoutHistory, historyError: "Ошибка истории (тест)" } }));
      expect((await page.locator("#tab-reg").textContent())?.match(/Ошибка истории \(тест\)/g)).toHaveLength(1);
      const currentRisks = page.locator("#r-risks");
      expect(await currentRisks.textContent()).toContain("Заказчик убытка");
      expect(await currentRisks.textContent()).toContain("Низкая маржа");
      expect(await currentRisks.textContent()).toContain("Расхождение");
      expect(await currentRisks.textContent()).not.toContain("Партнёрский заказчик");

      const clean = buildRegisterView({
        month: "2026-10", asOf: payload.asOfDate, fileName: "ОП-тест.xlsx", rows: [row("Чистая строка")],
        plans: {}, missing: [], extraDealsCount: 0
      });
      await page.goto("about:blank");
      await page.setContent(renderRegisterHtml({ ...payload, reconciliation: undefined, register: clean }));
      expect(await currentRisks.count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 15_000);

  it.each([375, 1440])("личный вид при ширине %i px", async (width) => {
    const { payload, aliases } = fixture();
    const variant = buildManagerVariant({ pult: payload, reg: sample(), planDeals: null, managerId: "s", aliases })!;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.route("https://fonts.**", route => route.abort());
      await page.setContent(renderRegisterHtml(variant.reg));
      expect(await page.locator("#foot").textContent()).toContain("Личный вид менеджера · только ваши договоры");
      expect(await page.getByText("Только для руководства", { exact: false }).count()).toBe(0);
      const discipline = await page.locator("#r-discipline").textContent();
      expect(discipline).not.toMatch(/Пропущено рабочих дней|Даты пропущенных|Чужой менеджер/);
      expect(discipline).toContain("Файл от 31.10.xlsx");
      expect(await page.locator("#regChips").isVisible()).toBe(false);
      expect(await page.locator(".mgr .r.body").count()).toBe(1);
      expect(await page.locator("#r-portal").count()).toBe(0);
      expect(await page.locator("#r-risks").textContent()).toContain("Заказчик убытка");
      expect(await page.locator("#r-risks").textContent()).not.toContain("Чужой заказчик");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await page.close();
    }
  }, 15_000);
});
