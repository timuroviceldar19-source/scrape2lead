import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { renderPultHtml, type RegisterPagePayload, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { buildLossesSampleView } from "../fixtures/kz/competitorsLosses.js";

// Все названия, БИН, номера лотов и суммы в этом файле выдуманные.

function payloadWithLosses(): SalesPultPayload {
  const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
  p.competitors = buildLossesSampleView();
  return p;
}

const plain = (s: string) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ");

async function openPage(browser: Browser, width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  // Шрифты Google не нужны тесту: отвечаем пустым CSS, чтобы не ходить в сеть и не ловить ошибки загрузки.
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" })
  );
  return { page, errors };
}

describe("«Конкуренты»: блок «Потери по причинам»", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  for (const width of [1440, 375]) {
    it(`первый блок вкладки, месяц, раскрытие с клавиатуры, без переполнения и ошибок (${width}px)`, async () => {
      const { page, errors } = await openPage(browser, width);
      try {
        await page.setContent(renderPultHtml(payloadWithLosses()));
        await page.locator('.sections [data-t="competitors"]').click();
        const pane = page.locator("#tab-competitors-ip");
        expect(await pane.getAttribute("class")).toContain("on");

        // Первый блок вкладки — потери, нумерация сдвинута
        const idx = await pane.locator(".block-head .idx").allInnerTexts();
        expect(idx).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
        const block = pane.locator("section.comp-losses");
        expect(await block.count()).toBe(1);
        expect(await pane.locator("section.block").first().evaluate((el) => el.classList.contains("comp-losses"))).toBe(true);

        // aria: секция подписана заголовком, полосы скрыты от читалок (цифры есть текстом)
        const labelledBy = await block.getAttribute("aria-labelledby");
        expect(labelledBy).toBe("comp-losses-h-ip");
        expect(plain(await page.locator(`#${labelledBy}`).innerText())).toContain("Потери по причинам");
        const bars = block.locator(".loss-bar");
        expect(await bars.count()).toBe(4);
        expect(await bars.evaluateAll((els) => els.every((el) => el.getAttribute("aria-hidden") === "true"))).toBe(true);

        const text = plain(await block.innerText());
        expect(text).toContain("Отклонено 4 заявки на 7,4 млн ₸, из них 3 при цене ниже победителя — это 4,4 млн ₸");
        expect(text).toContain("1 отклонение при цене ниже победителя на 1,4 млн ₸: LS-2");
        expect(text).toContain("Главная причина — «Обеспечение заявки»: 1 лот на 3,0 млн ₸");
        expect(text).toContain("Проиграли по цене: 1 лот на 2,5 млн ₸, дороже победителей на 500 000 ₸ · по условной скидке: 1 лот на 1,8 млн ₸");
        const labels = await block.locator("details.loss-d > summary .loss-nm").allInnerTexts();
        expect(labels.map((l) => l.split("\n")[0])).toEqual(["Обеспечение заявки", "Документы на ПО", "Письмо производителя", "Несоответствие ТС"]);

        // <details> причины раскрывается и закрывается с клавиатуры
        const summary = block.locator("details.loss-d > summary").nth(1);
        await summary.focus();
        expect(await page.evaluate(() => document.activeElement?.matches("details.loss-d > summary"))).toBe(true);
        await page.keyboard.press("Enter");
        const opened = block.locator('details.loss-d[data-loss-reason="software_docs"]');
        expect(await opened.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
        const lotLinks = opened.locator(".loss-lot a");
        expect(await lotLinks.allInnerTexts()).toEqual(["LS-1"]);
        expect(await lotLinks.first().getAttribute("href")).toBe("https://procurement.gov.kz/ru/announce/index/7001");
        expect(plain(await opened.innerText())).toContain("ниже победителя на 8,7%");
        await page.keyboard.press(" ");
        expect(await opened.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);

        // «Наши отклонения» свёрнуты по умолчанию, открываются с клавиатуры
        const rejDetails = pane.locator("details.comp-rej-d");
        expect(await rejDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
        expect(await pane.locator(".comp-rej .comp-rej-row").first().isVisible()).toBe(false);
        await rejDetails.locator("summary").focus();
        await page.keyboard.press("Enter");
        expect(await rejDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
        expect(await pane.locator(".comp-rej .comp-rej-row").first().isVisible()).toBe(true);

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        // Выбранный месяц: октябрь — свои причины и проигрыши
        await page.locator('#competitorsMonths button[data-month="2026-10"]').click();
        const octText = plain(await pane.locator("section.comp-losses").innerText());
        expect(octText).toContain("Потери по причинам · октябрь 2026");
        expect(octText).toContain("Отклонено 2 заявки на 5,1 млн ₸");
        expect(octText).toContain("Проиграли по цене: 0 лотов · по условной скидке: 1 лот на 1,8 млн ₸");
        expect(await pane.locator("section.comp-losses details.loss-d").count()).toBe(2);

        // КТ: своя секция и свой id заголовка
        await page.locator('#productSwitch [data-product="kt"]').click();
        const paneKt = page.locator("#tab-competitors-kt");
        expect(await paneKt.locator("section.comp-losses").getAttribute("aria-labelledby")).toBe("comp-losses-h-kt");

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30000);
  }

  it("старая выгрузка без losses: блок пропускается, нумерация с 01", async () => {
    const p = payloadWithLosses();
    for (const g of [p.competitors!.ip!, p.competitors!.kt!]) {
      delete (g as Partial<typeof g>).losses;
      for (const mv of Object.values(g.monthViews)) delete (mv as Partial<typeof mv>).losses;
    }
    const { page, errors } = await openPage(browser, 1440);
    try {
      await page.setContent(renderPultHtml(p));
      await page.locator('.sections [data-t="competitors"]').click();
      const pane = page.locator("#tab-competitors-ip");
      expect(await pane.locator("section.comp-losses").count()).toBe(0);
      expect((await pane.locator(".block-head .idx").allInnerTexts())[0]).toBe("01");
      expect(plain(await pane.locator("section.block").first().innerText())).toContain("Итоги");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20000);

  it("вариант менеджера: нет данных конкурентов и блока потерь", async () => {
    const f = fixture();
    f.payload.competitors = buildLossesSampleView();
    expect(f.payload.competitors.ip?.losses.rejected.count).toBe(4);
    const reg: RegisterPagePayload = {
      asOfDate: f.payload.asOfDate,
      generatedAt: f.payload.generatedAt,
      portal: "https://example.invalid",
      register: f.register
    };
    const variant = buildManagerVariant({ pult: f.payload, reg, planDeals: [], managerId: "s", aliases: f.aliases })!;
    expect(variant.pult.competitors).toBeNull();
    const variantJson = JSON.stringify(variant);
    for (const needle of ['"losses"', '"byReason"', '"recentCheaper"', "LS-1", "LK-1", "Соперник Гамма", "Демо Ф3"]) {
      expect(variantJson).not.toContain(needle);
    }

    const rendered = renderManagerVariant(variant);
    // Данных нет и в самой странице (код вкладки общий, поэтому проверяем данные, а не подписи в JS)
    for (const needle of ['"losses"', '"byReason"', "LS-1", "Соперник Гамма"]) {
      expect(rendered.index).not.toContain(needle);
      expect(rendered.reg).not.toContain(needle);
    }

    const { page, errors } = await openPage(browser, 1440);
    try {
      await page.setContent(rendered.index);
      expect(await page.locator('.sections a[data-t="competitors"]').count()).toBe(0);
      await page.evaluate(() => { location.hash = "#competitors-ip"; });
      await page.waitForTimeout(150);
      expect(await page.locator("section.comp-losses").count()).toBe(0);
      expect(await page.locator("#tab-pult").getAttribute("class")).toContain("on");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20000);
});
