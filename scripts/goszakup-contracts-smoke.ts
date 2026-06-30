import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BIN = process.argv[2] ?? "061040006408";
const DEBUG_DIR = "data/debug";

console.log(`goszakup contracts smoke: BIN=${BIN}`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  locale: "ru-RU",
  viewport: { width: 1400, height: 900 }
});
const page = await context.newPage();

try {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const contractsUrl = `https://goszakup.gov.kz/ru/registry/contract?filter[supplier]=${BIN}`;
  console.log(`Opening: ${contractsUrl}`);

  await page.goto(contractsUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  const html = await page.content();
  const htmlPath = path.join(DEBUG_DIR, `goszakup-contracts-${BIN}.html`);
  fs.writeFileSync(htmlPath, html, "utf8");
  console.log(`Saved HTML: ${htmlPath} (${html.length} bytes)`);

  await page.screenshot({ path: path.join(DEBUG_DIR, `goszakup-contracts-${BIN}.png`) });

  console.log("\n--- Analysis ---");
  console.log("Check data/debug/ for HTML and screenshot");
  console.log("Look for table#search-result or similar");

} finally {
  await browser.close();
}
