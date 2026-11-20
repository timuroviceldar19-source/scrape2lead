import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { filterContractUnits } from "../../src/kz/market/filterUnits.js";
import { buildMarketView } from "../../src/kz/market/aggregate.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

describe("понятные суммы рынка и учебные комплекты", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });
  it.each([1440, 390])("показывает состав суммы и долю каждой компании, ширина %s", async width => {
    const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
    const cfg = { ...loadMarketConfig(), ourBins: ["111111111111", "222222222222", "333333333333"], ourCompanyNames: { "111111111111": "Компания Альфа", "222222222222": "Компания Бета", "333333333333": "Компания Гамма" } };
    const units = filterContractUnits(["111111111111", "222222222222", "333333333333", "999999999999"].map((supplierBiin, i) => ({
      id: i + 1, signDate: "2026-10-15", refContractStatusId: 190, supplierBiin, customerBin: "111111111111",
      ContractUnits: [{ refEnstruCode: i % 2 ? "329959.900.000019" : "262030.100.000021", itemPrice: 1000000, quantity: 1, totalSum: 1000000 }]
    })), cfg);
    units.push({ ...units[0], id: 9, month: "2026-11", date: "2026-11-02" });
    p.market = buildMarketView(units, "2026-11-05", cfg, undefined, undefined, {
      "2026-10": { contracts: 2, sum: 1500000, ids: [71, 72] },
      "2026-08": { contracts: 1, sum: 250000, ids: [73] }
    });
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.setContent(renderPultHtml(p));
      await page.locator('.sections [data-t="market"]').click(); await page.locator('#productSwitch [data-product="ip"]').click();
      const text = await page.locator("#tab-ip").innerText();
      expect(text).toContain("учебного оборудования");
      expect(text).toContain("Учебные комплекты с подтверждённой панелью, сумма комплектов целиком: 2,0 млн ₸");
      expect(text).toContain("На проверке: 2 договора на 1,5 млн ₸, в суммы не входят");
      expect(text).toContain("комплекты считаются только при подтверждённой панели");
      const pending = page.locator('#tab-ip .education-pending');
      expect(await pending.locator('a').first().isVisible()).toBe(false);
      await pending.locator('summary').click();
      expect(await pending.locator('a').first().getAttribute('href')).toBe('https://procurement.gov.kz/ru/egzcontract/cpublic/show/71');
      expect(await pending.locator('a').count()).toBe(2);
      expect(text).toContain("F3 и партнёры");
      expect(text).toContain("Компания Гамма: договоры на 1,0 млн ₸ — 25,0% всего рынка");
      expect(text.toLowerCase()).toContain("с января по октябрь 2026 года");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.addStyleTag({ content: ".reveal { opacity: 1 !important; transform: none !important; transition: none !important; }" });
      await page.screenshot({ path: `/tmp/bitrix-one/market-${width}.png`, fullPage: true });
      await page.locator('#marketMonths [data-month="2026-08"]').click();
      expect(await page.locator('#tab-ip').innerText()).toContain('На проверке: 1 договор на 0,3 млн ₸, в суммы не входят');
      expect(await page.locator('#tab-ip .education-pending a').getAttribute('href')).toContain('/73');
      await page.locator('#marketMonths [data-month="2026-11"]').click();
      expect(await page.locator('#tab-ip .education-pending').count()).toBe(0);
      await page.locator('.sections [data-t="market"]').click(); await page.locator('#productSwitch [data-product="kt"]').click();
      expect(await page.locator('#tab-kt .education-pending').count()).toBe(0);
      expect(await page.locator('#tab-kt').innerText()).not.toContain('подтверждённой панелью');
    } finally { await page.close(); }
  }, 30000);
});
