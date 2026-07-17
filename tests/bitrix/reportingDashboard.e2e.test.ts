import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

const dashboardPath = resolve("exports/bitrix-b2g-2026-07-17/dashboard.html");

describe.runIf(process.env.BITRIX_REPORT_E2E === "1" && existsSync(dashboardPath))("offline Bitrix dashboard", () => {
  it("recalculates filters and stays viewport-safe at 1280 and 1440 px", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const width of [1280, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const externalRequests: string[] = [];
        page.on("request", (request) => {
          if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
        });
        await page.goto(pathToFileURL(dashboardPath).href);
        await expect.poll(() => page.locator("#cards .card").count()).toBe(6);
        const before = await page.locator("#filtered-count").textContent();
        await page.selectOption("#pipeline", "29");
        const after = await page.locator("#filtered-count").textContent();
        expect(after).not.toBe(before);
        expect(await page.locator("#deal-rows tr").first().innerText()).toContain("B2G");
        expect(await page.locator("#deal-rows a").first().getAttribute("href")).toMatch(/crm\/deal\/details\/\d+\//);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(externalRequests).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
