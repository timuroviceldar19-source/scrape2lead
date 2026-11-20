import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { attachRegisterContracts } from "../../src/bitrix/salesPult/contracts.js";
import { renderPultHtml } from "../../src/bitrix/salesPult/site.js";

// Все данные этого файла выдуманные.
const longUrl = "[URL=https://example.invalid/ru/registry/contract/" + "a1b2c3d4".repeat(12) + "]ссылка[/URL]";

describe("комментарий задачи на телефоне", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it("длинная ссылка без пробелов переносится и не растягивает страницу на 375", async () => {
    const f = fixture();
    attachRegisterContracts(f.payload, f.register, f.deals, f.aliases);
    f.payload.groups[0].managers[0].topTasks = [{
      id: "901", dealId: "901", title: "Задача с длинной ссылкой", deadline: "2026-10-28", amount: 1000,
      isOverdue: true, overdueDays: 2, rank: 1, kind: "overdue", group: 1, lastComment: longUrl
    }];
    const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.setContent(renderPultHtml(f.payload));
      expect(await page.locator("#tasks .task .cm").first().textContent()).toContain("a1b2c3d4");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  });
});
