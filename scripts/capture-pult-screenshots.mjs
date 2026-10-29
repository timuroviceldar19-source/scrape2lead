import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { renderPultHtml } from "../src/bitrix/salesPult/site.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../exports/sales-pult/screenshots");
const exportsDir = path.resolve(__dirname, "../exports/sales-pult");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Clean old screenshots
for (const file of fs.readdirSync(outDir)) {
  if (file.endsWith(".png")) {
    fs.unlinkSync(path.join(outDir, file));
  }
}

// 1. Prepare midday fixture HTML
const middayFixturePath = path.resolve(__dirname, "../tests/fixtures/sales-pult/midday.json");
const middayPayload = JSON.parse(fs.readFileSync(middayFixturePath, "utf8"));
const middayHtml = renderPultHtml(middayPayload);
const middayHtmlPath = path.join(exportsDir, "midday.html");
fs.writeFileSync(middayHtmlPath, middayHtml, "utf8");

// 2. Prepare real payload HTML if present
const scratchReal = "F:/Temp/claude/F--scrape2lead-main/6bd2bae4-f008-438a-8dfb-0d86fc4fab0e/scratchpad/payload-real.json";
const localReal = path.join(exportsDir, "payload-real.json");
const realPayloadSource = fs.existsSync(scratchReal) ? scratchReal : fs.existsSync(localReal) ? localReal : null;

let realHtmlPath = null;
if (realPayloadSource) {
  const cfgPath = path.resolve(__dirname, "../config/sales-pult.json");
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
  const realPayload = JSON.parse(fs.readFileSync(realPayloadSource, "utf8"));
  if (cfg.holidays) realPayload.holidays = cfg.holidays;
  const realHtml = renderPultHtml(realPayload);
  realHtmlPath = path.join(exportsDir, "real.html");
  fs.writeFileSync(realHtmlPath, realHtml, "utf8");
}

const browser = await chromium.launch();

async function capture(name, htmlFile, w, h, query = "", scrollSelector = null, scale = 1) {
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    deviceScaleFactor: scale
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  const url = "file:///" + htmlFile.replace(/\\/g, "/") + query;
  await page.goto(url);
  await page.waitForTimeout(600);

  if (!query.includes("tv=1")) {
    for (let y = 0; y < 8000; y += 500) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(40);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(1200);

  if (scrollSelector) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
      }
    }, scrollSelector);
    await page.waitForTimeout(600);
  }

  const outPath = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: outPath });
  console.log(`Saved screenshot: ${name}.png (errors: ${errs.length ? errs.join("; ") : "none"})`);
  await page.close();
}

if (realHtmlPath) {
  // Real payload screenshots: 1440x900 (top, sales), 390x844, 1920x1080 tv=1
  await capture("1-реальные-1440-верх", realHtmlPath, 1440, 900);
  await capture("2-реальные-1440-sales", realHtmlPath, 1440, 900, "", "#sales");
  await capture("3-реальные-390-телефон", realHtmlPath, 390, 844, "", null, 2);
  await capture("4-реальные-1920-ТВ", realHtmlPath, 1920, 1080, "?tv=1");
}

// Midday fixture screenshot: 1440x900
await capture("5-midday-1440", middayHtmlPath, 1440, 900);

await browser.close();
console.log("Screenshots captured successfully in:", outDir);
