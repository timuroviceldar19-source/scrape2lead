import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { financeSnapshot, parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import type { FinanceView } from "../../src/bitrix/salesPult/finance/types.js";
import { renderFinanceHtml, renderPultHtml, type FinancePagePayload, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { financeWorkbook, type FinanceDebtorFixture } from "../fixtures/sales-pult/financeWorkbook.js";

// Все данные выдуманные.

function buildView(debtors?: FinanceDebtorFixture[], history = 2): FinanceView {
  const report = parseFinanceWorkbook(financeWorkbook({ debtors }));
  const snap = financeSnapshot(report);
  const snapshots = Array.from({ length: history }, (_, i) => ({
    ...snap,
    dataDate: new Date(Date.parse(snap.dataDate) - (history - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    cash: snap.cash + i * 100_000
  }));
  return { report, file: { id: "10", name: "Ежедневный отчет.xlsx", uploadedAt: "2026-11-17T06:58:16Z" }, snapshots };
}

const makePayload = (finance: FinanceView, asOfDate = "2026-11-17"): FinancePagePayload => ({
  asOfDate,
  generatedAt: `${asOfDate} 12:15 (UTC+5)`,
  finance
});

// Набор дебиторов с граничными возрастами относительно asOfDate = 2026-11-17:
// - 2026-11-05 -> 12 дней (<= 30)
// - 2026-10-18 -> 30 дней (ровно 30, НЕ > 30)
// - 2026-10-17 -> 31 день (> 30)
// - 2026-09-18 -> 60 дней (ровно 60, > 30, НЕ > 60)
// - 2026-09-17 -> 61 день (> 60)
// - 2026-06-01 -> 169 дней (> 60)
const AGE_TEST_DEBTORS: FinanceDebtorFixture[] = [
  { name: "Свежий 12д (Альфа)", company: 0, amount: 5_000_000, date: "2026-11-05" },
  { name: "Граничный 30д (Альфа)", company: 0, amount: 4_000_000, date: "2026-10-18" },
  { name: "Средний 31д (Альфа)", company: 0, amount: 3_000_000, date: "2026-10-17" },
  { name: "Граничный 60д (Бета)", company: 1, amount: 2_500_000, date: "2026-09-18" },
  { name: "Старый 61д (Альфа)", company: 0, amount: 1_500_000, date: "2026-09-17" },
  { name: "Давний 169д (Бета)", company: 1, amount: 2_000_000, date: "2026-06-01", note: "претензия 01.09.2026" }
];

describe("Финансы (волна 1): дефицит и фильтры возраста дебиторов", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  async function open(html: string, width: number): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(html);
    return { page, errors };
  }

  for (const width of [1440, 375]) {
    it(`контраст предупреждения о дефиците >= 4.5:1 и читаемость без переполнения на ${width} px`, async () => {
      const v = buildView(AGE_TEST_DEBTORS, 3);
      v.report!.dataDate = "2026-11-10"; // дополнительно проверяем .note-warn о старом отчёте
      const { page, errors } = await open(renderFinanceHtml(makePayload(v)), width);
      try {
        await page.locator("#debtMainBox summary").click();

        const metrics = await page.evaluate(() => {
          const parseRgba = (s: string): [number, number, number, number] => {
            const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (!m) throw new Error(`Unexpected color: ${s}`);
            return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
          };
          const srgb = (c: number) => {
            const x = c / 255;
            return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          };
          const lum = ([r, g, b]: [number, number, number]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
          const contrast = (fg: [number, number, number], bg: [number, number, number]) => {
            const l1 = lum(fg), l2 = lum(bg);
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          };
          const effectiveBg = (el: Element | null): [number, number, number] => {
            let cur: Element | null = el;
            while (cur) {
              const [r, g, b, a] = parseRgba(getComputedStyle(cur).backgroundColor);
              if (a > 0.99) return [r, g, b];
              cur = cur.parentElement;
            }
            return [255, 255, 255];
          };
          const measure = (selector: string) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const cs = getComputedStyle(el);
            const [r, g, b] = parseRgba(cs.color);
            const bg = effectiveBg(el);
            const parentBg = effectiveBg(el.parentElement);
            const rect = el.getBoundingClientRect();
            return {
              text: el.textContent?.replace(/\s+/g, " ").trim() ?? "",
              fontSize: parseFloat(cs.fontSize),
              ratioOwnBg: +contrast([r, g, b], bg).toFixed(2),
              ratioParentBg: +contrast([r, g, b], parentBg).toFixed(2),
              fitsWidth: el.scrollWidth <= el.clientWidth + 1,
              rectLeft: rect.left,
              rectRight: rect.right,
              viewportWidth: innerWidth
            };
          };

          return {
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
            tileOverflow: [...document.querySelectorAll(".fin-tile")].some((t) => t.scrollWidth > t.clientWidth + 1),
            deficitTileWarn: measure(".fin-tile .sub .warn"),
            debtNumWarn: measure("#f-debtors .fin-debt .r.body .num.warn"),
            debtNumBad: measure("#f-debtors .fin-debt .r.body .num.bad"),
            paymentsBad: measure("#f-payments .lead .bad"),
            noteWarn: measure("#tab-fin > .note-warn")
          };
        });

        expect(metrics.pageOverflow).toBe(false);
        expect(metrics.tileOverflow).toBe(false);

        expect(metrics.deficitTileWarn).not.toBeNull();
        expect(metrics.deficitTileWarn!.text).toMatch(/на счетах 70% · не хватает 650 тыс ₸/);
        expect(metrics.deficitTileWarn!.fontSize).toBeGreaterThanOrEqual(12);
        expect(metrics.deficitTileWarn!.ratioOwnBg).toBeGreaterThanOrEqual(4.5);
        expect(metrics.deficitTileWarn!.ratioParentBg).toBeGreaterThanOrEqual(4.5);
        expect(metrics.deficitTileWarn!.fitsWidth).toBe(true);
        expect(metrics.deficitTileWarn!.rectLeft).toBeGreaterThanOrEqual(0);
        expect(metrics.deficitTileWarn!.rectRight).toBeLessThanOrEqual(width);

        expect(metrics.debtNumWarn).not.toBeNull();
        expect(metrics.debtNumWarn!.ratioOwnBg).toBeGreaterThanOrEqual(4.5);

        expect(metrics.debtNumBad).not.toBeNull();
        expect(metrics.debtNumBad!.ratioOwnBg).toBeGreaterThanOrEqual(4.5);

        expect(metrics.paymentsBad).not.toBeNull();
        expect(metrics.paymentsBad!.ratioOwnBg).toBeGreaterThanOrEqual(4.5);

        expect(metrics.noteWarn).not.toBeNull();
        expect(metrics.noteWarn!.ratioOwnBg).toBeGreaterThanOrEqual(4.5);
        expect(metrics.noteWarn!.fitsWidth).toBe(true);
        expect(metrics.noteWarn!.rectRight).toBeLessThanOrEqual(width);

        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 20000);

    it(`фильтры возраста задолженности, дата отсчёта и отсутствие «просрочено» на ${width} px`, async () => {
      const v = buildView(AGE_TEST_DEBTORS);
      // Долг без даты реализации — в «Все» есть, в >30 и >60 не попадает.
      v.report!.debtors.rows.push({ name: "Без даты (Альфа)", company: "Альфа", amount: 9_000_000 });
      v.report!.debtors.totals[0] += 9_000_000;
      v.report!.debtors.total += 9_000_000;

      const { page, errors } = await open(renderFinanceHtml(makePayload(v)), width);
      try {
        const overviewDebtBefore = (await page.locator("#f-overview .fin-tile").nth(2).locator(".v").innerText()).replace(/\s+/g, " ").trim();
        const summaryBefore = (await page.locator("#debtMainBox summary").innerText()).replace(/\s+/g, " ").trim();
        expect(summaryBefore).toMatch(/^Список дебиторов 7 долгов · 27,0 млн ₸$/);

        // Дата отсчёта видна явно, термина «просрочено» нет нигде на странице.
        const leadText = (await page.locator("#f-debtors .lead").innerText()).replace(/\s+/g, " ");
        expect(leadText).toContain("17.11.2026");

        await page.locator("#debtMainBox summary").click();
        const metaText = () => page.locator("#debtMain .fin-debt-meta").innerText();
        expect(await metaText()).toContain("17.11.2026");

        const names = () => page.locator("#debtMain .fin-debt .r.body .nm").evaluateAll((es) => es.map((e) => e.getAttribute("title")));
        const agePressed = () => page.locator("#debtAgeChips button").evaluateAll((es) => es.map((e) => `${e.textContent!.trim()}=${e.getAttribute("aria-pressed")}`));

        expect(await agePressed()).toEqual(["Все=true", "Старше 30 дней=false", "Старше 60 дней=false"]);
        expect(await names()).toEqual([
          "Без даты (Альфа)",
          "Свежий 12д (Альфа)",
          "Граничный 30д (Альфа)",
          "Средний 31д (Альфа)",
          "Граничный 60д (Бета)",
          "Давний 169д (Бета)",
          "Старый 61д (Альфа)"
        ]);

        // Сортируем по дням (по убыванию) и переключаем фильтр возраста -> сортировка сохраняется!
        await page.locator('#debtMain .fin-sort[data-sort="days"]').click();
        expect(await page.locator('#debtMain [role="columnheader"]').nth(1).getAttribute("aria-sort")).toBe("descending");

        await page.locator('#debtAgeChips button[data-age="30"]').click();
        expect(await agePressed()).toEqual(["Все=false", "Старше 30 дней=true", "Старше 60 дней=false"]);
        expect(await page.locator('#debtMain [role="columnheader"]').nth(1).getAttribute("aria-sort")).toBe("descending");
        // Ровно 30 дней и без даты отфильтрованы; порядок по убыванию дней: 169д, 61д, 60д, 31д.
        expect(await names()).toEqual([
          "Давний 169д (Бета)",
          "Старый 61д (Альфа)",
          "Граничный 60д (Бета)",
          "Средний 31д (Альфа)"
        ]);
        expect((await metaText()).replace(/\s+/g, " ")).toContain("4 долга на 9,0 млн ₸");

        // Переключаем фильтр компании на «Альфа» -> фильтр возраста (>30) и сортировка сохраняются!
        await page.locator('#debtChips button[data-c="Альфа"]').click();
        expect(await page.locator('#debtChips button[data-c="Альфа"]').getAttribute("aria-pressed")).toBe("true");
        expect(await agePressed()).toEqual(["Все=false", "Старше 30 дней=true", "Старше 60 дней=false"]);
        expect(await names()).toEqual(["Старый 61д (Альфа)", "Средний 31д (Альфа)"]);
        expect((await metaText()).replace(/\s+/g, " ")).toContain("2 долга на 4,5 млн ₸");

        // Переключаем возраст на «Старше 60 дней» -> фильтр компании «Альфа» и сортировка сохраняются!
        await page.locator('#debtAgeChips button[data-age="60"]').click();
        expect(await agePressed()).toEqual(["Все=false", "Старше 30 дней=false", "Старше 60 дней=true"]);
        expect(await page.locator('#debtChips button[data-c="Альфа"]').getAttribute("aria-pressed")).toBe("true");
        expect(await names()).toEqual(["Старый 61д (Альфа)"]);
        expect((await metaText()).replace(/\s+/g, " ")).toContain("1 долг на 1,5 млн ₸");

        // Возвращаем компанию «Все» -> возраст >60 остаётся активным, сортировка по дням убыв. сохранена!
        await page.locator('#debtChips button[data-c=""]').click();
        expect(await agePressed()).toEqual(["Все=false", "Старше 30 дней=false", "Старше 60 дней=true"]);
        expect(await names()).toEqual(["Давний 169д (Бета)", "Старый 61д (Альфа)"]);

        // Итоги блока, плитка «Дебиторка» и проблемные долги не меняются при фильтрации.
        expect((await page.locator("#f-overview .fin-tile").nth(2).locator(".v").innerText()).replace(/\s+/g, " ").trim()).toBe(overviewDebtBefore);
        expect((await page.locator("#debtMainBox summary").innerText()).replace(/\s+/g, " ").trim()).toBe(summaryBefore);
        await page.locator("#debtProblemBox summary").click();
        expect(await page.locator("#debtProblem .fin-debt .r.body").count()).toBe(2);

        // Нигде на странице нет слова «просрочено» / «просрочка» без договорной даты платежа.
        const fullText = await page.locator("#tab-fin").innerText();
        expect(fullText).not.toMatch(/просроч/i);

        // Верстка на 375 / 1440 px без горизонтальной прокрутки и вылезающих кнопок.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const chipsOk = await page.locator("#debtMain .chips button").evaluateAll(
          (es, w) => es.every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= w + 0.5; }),
          width
        );
        expect(chipsOk).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 20000);
  }

  it("«Показать все» и клавиатурная доступность (Enter/Space, aria-pressed, сохранение фокуса)", async () => {
    const manyOld: FinanceDebtorFixture[] = Array.from({ length: 15 }, (_, i) => ({
      name: `Старый долг ${i + 1}`,
      company: (i % 2) as 0 | 1,
      amount: 100_000 + i * 1_000,
      date: i < 13 ? "2026-10-01" : "2026-09-01" // 15 штук >30д, из них 2 >60д
    }));
    const fresh: FinanceDebtorFixture[] = Array.from({ length: 5 }, (_, i) => ({
      name: `Свежий долг ${i + 1}`,
      company: 0,
      amount: 50_000 + i,
      date: "2026-11-10"
    }));
    const v = buildView([...manyOld, ...fresh]);
    const { page, errors } = await open(renderFinanceHtml(makePayload(v)), 1440);
    try {
      await page.locator("#debtMainBox summary").click();
      const rowCount = () => page.locator("#debtMain .fin-debt .r.body").count();
      expect(await rowCount()).toBe(12);

      // Клавиатурой (Enter) выбираем «Старше 30 дней» -> фокус остаётся на кнопке, aria-pressed=true
      await page.locator('#debtAgeChips button[data-age="30"]').focus();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.age)).toBe("30");
      expect(await page.locator('#debtAgeChips button[data-age="30"]').getAttribute("aria-pressed")).toBe("true");
      expect(await rowCount()).toBe(12);
      expect((await page.locator("#debtAll").innerText()).replace(/\s+/g, " ")).toMatch(/^Показать все 15 на /);

      // Клавиатурой (Space) раскрываем «Показать все»
      await page.locator("#debtAll").focus();
      await page.keyboard.press("Space");
      expect(await rowCount()).toBe(15);
      expect(await page.locator("#debtAll").innerText()).toBe("Свернуть");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("debtAll");

      // Переключаем компанию с клавиатуры (Enter) при активном «Старше 30 дней» -> фильтр >30 сохранён!
      await page.locator('#debtChips button[data-c="Альфа"]').focus();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.c)).toBe("Альфа");
      expect(await page.locator('#debtAgeChips button[data-age="30"]').getAttribute("aria-pressed")).toBe("true");
      // Из 15 старых: чётные индексы 0,2,4,6,8,10,12,14 -> 8 строк Альфы
      expect(await rowCount()).toBe(8);

      // Возвращаем компанию «Все» -> режим «Показать все» всё ещё сохраняется (15 строк)
      await page.locator('#debtChips button[data-c=""]').click();
      expect(await rowCount()).toBe(15);

      // Переключаем на «Старше 60 дней» -> 2 строки (индексы 13 и 14)
      await page.locator('#debtAgeChips button[data-age="60"]').click();
      expect(await rowCount()).toBe(2);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);

  it("права ролей: менеджер и ТВ не видят ссылку на Финансы и не получают fin.html", async () => {
    const f = fixture();
    const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, portal: "https://example.invalid", register: f.register };
    const built = buildManagerVariant({ pult: f.payload, reg, planDeals: [], managerId: "s", aliases: f.aliases })!;
    expect("fin" in (built as unknown as Record<string, unknown>)).toBe(false);
    const pages = renderManagerVariant(built);
    expect("fin" in (pages as unknown as Record<string, unknown>)).toBe(false);

    for (const width of [1440, 375]) {
      for (const [html, expectedLinks] of [[renderPultHtml(f.payload), 1], [pages.index, 0], [pages.reg, 0]] as const) {
        const { page, errors } = await open(html, width);
        try {
          expect(await page.locator('a[href="./fin.html"]').count()).toBe(expectedLinks);
          expect(errors).toEqual([]);
        } finally { await page.close(); }
      }
    }
  }, 20000);
});
