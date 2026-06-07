import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium, type BrowserContextOptions, type Page } from "playwright";
import { runMigrations } from "../storage/migrations.js";
import { isValidBin, sleep } from "./csv.js";
import { parseStatGovHtml } from "./statGovParser.js";
import type { StatGovRecord } from "./tenderTypes.js";

export interface StatGovCollectOptions {
  databasePath?: string;
  sessionPath?: string;
  debugDir?: string;
  delayMs?: number;
  headless?: boolean;
}

export interface StatGovCollectStats {
  processed: number;
  success: number;
  failed: number;
  skipped: number;
}

const DEFAULT_DB_PATH = "data/scrape2lead.db";
const DEFAULT_SESSION_PATH = "data/stat-gov-session.json";
const DEFAULT_DEBUG_DIR = "data/debug";

export async function collectStatGovForBins(
  bins: string[],
  options: StatGovCollectOptions = {}
): Promise<StatGovCollectStats> {
  const sessionPath = options.sessionPath ?? process.env.STAT_GOV_SESSION_PATH ?? DEFAULT_SESSION_PATH;
  const session = loadSession(sessionPath);
  const delayMs = options.delayMs ?? Number(process.env.KZ_ENRICH_DELAY_MS ?? 2000);
  const db = new Database(options.databasePath ?? DEFAULT_DB_PATH);
  runMigrations(db);
  const upsert = prepareStatGovUpsert(db);

  const stats: StatGovCollectStats = { processed: 0, success: 0, failed: 0, skipped: 0 };
  const browser = await chromium.launch({
    headless: options.headless ?? false,
    slowMo: options.headless ? 0 : 50
  });

  try {
    const context = await browser.newContext({
      storageState: session.storageState,
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    for (const bin of bins) {
      if (!isValidBin(bin)) {
        console.warn(`stat.gov: skip invalid BIN ${bin}`);
        stats.skipped++;
        continue;
      }

      stats.processed++;
      const result = await fetchStatGovByBin(page, bin, options.debugDir ?? DEFAULT_DEBUG_DIR);
      if (result.record) {
        upsert.run({
          ...result.record,
          updated_at: new Date().toISOString(),
          raw_snapshot_path: result.rawSnapshotPath
        });
        stats.success++;
      } else {
        stats.failed++;
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  } finally {
    await browser.close();
    db.close();
  }

  return stats;
}

export async function fetchStatGovByBin(
  page: Page,
  bin: string,
  debugDir = DEFAULT_DEBUG_DIR
): Promise<{ record: StatGovRecord | null; rawSnapshotPath: string | null }> {
  await page.goto("https://stat.gov.kz/ru/cabinet/juridical/by/bin/", {
    waitUntil: "networkidle",
    timeout: 30_000
  });
  await page.fill('input[name="bin"]', bin);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  const html = await page.content();
  fs.mkdirSync(debugDir, { recursive: true });
  const rawSnapshotPath = path.join(debugDir, `stat-gov-${bin}.html`);
  fs.writeFileSync(rawSnapshotPath, html, "utf8");

  return {
    record: parseStatGovHtml(html),
    rawSnapshotPath
  };
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

function prepareStatGovUpsert(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT INTO stat_gov_data (
      bin, name, registration_date, oked, oked_name, address, director,
      legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code,
      sector_name, updated_at, raw_snapshot_path
    ) VALUES (
      @bin, @name, @registration_date, @oked, @oked_name, @address, @director,
      @legal_status, @krp_code, @krp_name, @kfs_code, @kfs_name, @sector_code,
      @sector_name, @updated_at, @raw_snapshot_path
    )
    ON CONFLICT(bin) DO UPDATE SET
      name = excluded.name,
      registration_date = excluded.registration_date,
      oked = excluded.oked,
      oked_name = excluded.oked_name,
      address = excluded.address,
      director = excluded.director,
      legal_status = excluded.legal_status,
      krp_code = excluded.krp_code,
      krp_name = excluded.krp_name,
      kfs_code = excluded.kfs_code,
      kfs_name = excluded.kfs_name,
      sector_code = excluded.sector_code,
      sector_name = excluded.sector_name,
      updated_at = excluded.updated_at,
      raw_snapshot_path = excluded.raw_snapshot_path
  `);
}
