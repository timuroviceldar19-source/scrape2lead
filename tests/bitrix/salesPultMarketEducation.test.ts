import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { filterContractUnits } from "../../src/kz/market/filterUnits.js";
import { buildMarketView } from "../../src/kz/market/aggregate.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

describe("понятные суммы рынка и учебные комплекты", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });
  it.each([1440, 390])("показывает состав суммы и долю каждой компании, ширина %s", async width => {
    const p: SalesPultPayload = JSON.parse(fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8"));
    const units = filterContractUnits(["061140003942", "130540000688", "170240035230", "999999999999"].map((supplierBiin, i) => ({
      id: i + 1, signDate: "2026-10-15", refContractStatusId: 190, supplierBiin, customerBin: "111111111111",
      ContractUnits: [{ refEnstruCode: i % 2 ? "329959.900.000019" : "262030.100.000021", itemPrice: 1000000, quantity: 1, totalSum: 1000000 }]
    })));
    p.market = buildMarketView(units, "2026-11-05");
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.setContent(renderPultHtml(p));
      await page.locator('[data-t="ip"]').click();
      const text = await page.locator("#tab-ip").innerText();
      expect(text).toContain("учебного оборудования");
      expect(text).toContain("Учебные комплекты целиком: 2,0 млн ₸");
      expect(text).toContain("F3 и партнёры");
      expect(text).toContain("Торговая сеть Казахстана: договоры на 1,0 млн ₸ — 25,0% всего рынка");
      expect(text.toLowerCase()).toContain("с января по октябрь 2026 года");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.addStyleTag({ content: ".reveal { opacity: 1 !important; transform: none !important; transition: none !important; }" });
      await page.screenshot({ path: `/tmp/bitrix-one/market-${width}.png`, fullPage: true });
    } finally { await page.close(); }
  });
});
