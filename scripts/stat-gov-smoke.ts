import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { fetchStatGovByBinWithRetry } from "../src/kz/statGovCollector.js";
import { getStatGovFetchFailure } from "../src/kz/statGovParser.js";

const SESSION_FILE = process.env.STAT_GOV_SESSION_PATH ?? "data/stat-gov-session.json";
const bin = process.argv[2] ?? "220640028224";

const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")) as {
  storageState?: unknown;
};

const browser = await chromium.launch({ headless: false, slowMo: 50 });
const context = await browser.newContext({
  storageState: session.storageState as never,
  viewport: { width: 1280, height: 800 }
});
const page = await context.newPage();

try {
  const result = await fetchStatGovByBinWithRetry(page, bin);
  console.log("success:", Boolean(result.record));
  console.log("record:", result.record);
  if (!result.record) {
    console.log("failure:", getStatGovFetchFailure(result.html));
  }
} catch (error) {
  const html = await page.content();
  fs.mkdirSync("data/debug", { recursive: true });
  fs.writeFileSync(path.join("data/debug", `stat-gov-smoke-fail-${bin}.html`), html, "utf8");
  console.error("failed:", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
