import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BIN = process.argv[2] ?? "";
const DEBUG_DIR = "data/debug";

console.log(`goszakup lots smoke: BIN=${BIN || "(no filter)"}`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  locale: "ru-RU",
  viewport: { width: 1400, height: 900 }
});
const page = await context.newPage();

try {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const lotsUrl = BIN
    ? `https://goszakup.gov.kz/ru/search/lots?filter[customer]=${BIN}`
    : `https://goszakup.gov.kz/ru/search/lots`;
  console.log(`Opening: ${lotsUrl}`);

  await page.goto(lotsUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  const lotsHtml = await page.content();
  const lotsPath = path.join(DEBUG_DIR, `goszakup-lots-search-${BIN || "all"}.html`);
  fs.writeFileSync(lotsPath, lotsHtml, "utf8");
  console.log(`Saved HTML: ${lotsPath} (${lotsHtml.length} bytes)`);

  await page.screenshot({ path: path.join(DEBUG_DIR, `goszakup-lots-search-${BIN || "all"}.png`) });

  const announceUrl = BIN
    ? `https://goszakup.gov.kz/ru/search/announce?filter[customer]=${BIN}`
    : `https://goszakup.gov.kz/ru/search/announce`;
  console.log(`\nOpening: ${announceUrl}`);

  await page.goto(announceUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  const announceHtml = await page.content();
  const announcePath = path.join(DEBUG_DIR, `goszakup-announce-search-${BIN || "all"}.html`);
  fs.writeFileSync(announcePath, announceHtml, "utf8");
  console.log(`Saved HTML: ${announcePath} (${announceHtml.length} bytes)`);

  await page.screenshot({ path: path.join(DEBUG_DIR, `goszakup-announce-search-${BIN || "all"}.png`) });

  console.log("\n--- Analysis ---");
  console.log("Check data/debug/ for HTML files and screenshots");
  console.log("Look for table selectors: table#search-result tbody tr, .table-responsive tbody tr");

} finally {
  await browser.close();
}
