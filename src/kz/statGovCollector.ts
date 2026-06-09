import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { isValidBin, sleep } from "./csv.js";
import { KzStorage } from "./kzStorage.js";
import { getStatGovFetchFailure, parseStatGovHtml } from "./statGovParser.js";
import type { StatGovRecord } from "./tenderTypes.js";

export interface StatGovCollectOptions {
  databasePath?: string;
  sessionPath?: string;
  debugDir?: string;
  delayMs?: number;
  headless?: boolean;
  cacheTtlDays?: number;
  forceRefresh?: boolean;
}

export interface StatGovCollectStats {
  processed: number;
  success: number;
  failed: number;
  skipped: number;
  cached: number;
}

const DEFAULT_DB_PATH = "data/scrape2lead.db";
const DEFAULT_SESSION_PATH = "data/stat-gov-session.json";
const DEFAULT_DEBUG_DIR = "data/debug";

export async function collectStatGovForBins(
  bins: string[],
  options: StatGovCollectOptions = {}
): Promise<StatGovCollectStats> {
  const sessionPath = options.sessionPath ?? process.env.STAT_GOV_SESSION_PATH ?? DEFAULT_SESSION_PATH;
  const delayMs = options.delayMs ?? Number(process.env.KZ_ENRICH_DELAY_MS ?? 2000);
  const ttlDays = options.cacheTtlDays ?? Number(process.env.STAT_GOV_CACHE_TTL_DAYS ?? 7);
  const storage = new KzStorage({ databasePath: options.databasePath ?? DEFAULT_DB_PATH });

  const stats: StatGovCollectStats = { processed: 0, success: 0, failed: 0, skipped: 0, cached: 0 };
  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    for (const bin of bins) {
      if (!isValidBin(bin)) {
        console.warn(`stat.gov: skip invalid BIN ${bin}`);
        stats.skipped++;
        continue;
      }

      if (!options.forceRefresh && storage.isStatGovFresh(bin, ttlDays)) {
        stats.cached++;
        continue;
      }

      if (!browser || !page) {
        const session = loadSession(sessionPath);
        browser = await chromium.launch({
          headless: options.headless ?? false,
          slowMo: options.headless ? 0 : 50
        });
        const context = await browser.newContext({
          storageState: session.storageState,
          viewport: { width: 1280, height: 800 }
        });
        page = await context.newPage();
      }

      stats.processed++;
      try {
        const result = await fetchStatGovByBinWithRetry(
          page,
          bin,
          options.debugDir ?? DEFAULT_DEBUG_DIR
        );
        if (result.record) {
          storage.upsertStatGov({
            ...result.record,
            updated_at: new Date().toISOString(),
            raw_snapshot_path: result.rawSnapshotPath
          });
          stats.success++;
        } else {
          stats.failed++;
          storage.recordEnrichError(bin, "stat_gov", getStatGovFetchFailure(result.html));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.failed++;
        storage.recordEnrichError(bin, "stat_gov", message);
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  } finally {
    await browser?.close();
    storage.close();
  }

  return stats;
}

const STAT_GOV_MAX_RETRIES = 3;

export async function fetchStatGovByBinWithRetry(
  page: Page,
  bin: string,
  debugDir = DEFAULT_DEBUG_DIR,
  maxRetries = STAT_GOV_MAX_RETRIES
): Promise<{ record: StatGovRecord | null; rawSnapshotPath: string | null; html: string }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchStatGovByBin(page, bin, debugDir);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetriableStatGovError(lastError) || attempt === maxRetries) break;
      const backoff = 1000 * attempt;
      console.warn(
        `stat.gov: bin=${bin} attempt ${attempt}/${maxRetries} failed: ${lastError.message}; retry in ${backoff}ms`
      );
      await sleep(backoff);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    }
  }

  throw lastError!;
}

export async function fetchStatGovByBin(
  page: Page,
  bin: string,
  debugDir = DEFAULT_DEBUG_DIR
): Promise<{ record: StatGovRecord | null; rawSnapshotPath: string | null; html: string }> {
  await page.goto("https://stat.gov.kz/ru/cabinet/juridical/by/bin/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });
  await page.waitForSelector('input[name="bin"]', { timeout: 30_000 });
  await page.fill('input[name="bin"]', bin);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  const html = await page.content();
  fs.mkdirSync(debugDir, { recursive: true });
  const rawSnapshotPath = path.join(debugDir, `stat-gov-${bin}.html`);
  fs.writeFileSync(rawSnapshotPath, html, "utf8");

  return {
    record: parseStatGovHtml(html),
    rawSnapshotPath,
    html
  };
}

function isRetriableStatGovError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return message.includes("timeout")
    || message.includes("waiting for")
    || message.includes("navigation")
    || message.includes("net::");
}

function loadSession(sessionPath: string): { storageState: BrowserContextOptions["storageState"]; savedAt?: string } {
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`stat.gov session not found at ${sessionPath}; run scripts/stat-gov-login.ts first`);
  }
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as { storageState?: unknown; savedAt?: string };
  if (!session.storageState) {
    throw new Error(`stat.gov session file has no storageState: ${sessionPath}`);
  }
  return session as { storageState: BrowserContextOptions["storageState"]; savedAt?: string };
}
