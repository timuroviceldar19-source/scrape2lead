import { chromium, type Browser, type Page } from "playwright";
import { isValidBin, sleep } from "./csv.js";
import { KzStorage } from "./kzStorage.js";
import { fetchRegistryForBin, type RegistryFetchResult } from "./goszakupRegistryFetcher.js";

export interface RegistryCollectOptions {
  databasePath?: string;
  delayMs?: number;
  headless?: boolean;
  debugDir?: string;
  forceRefresh?: boolean;
  requireContacts?: boolean;
  requireName?: boolean;
  profileUrlsByBin?: ReadonlyMap<string, string>;
  cacheTtlDays?: number;
  /** Extra attempts per BIN after a transient failure. Defaults to REGISTRY_FETCH_RETRIES. */
  fetchRetries?: number;
  onProgress?: (index: number, total: number, bin: string) => void;
}

export interface RegistryCollectStats {
  processed: number;
  success: number;
  not_found: number;
  failed: number;
  cached: number;
  skipped: number;
}

const DEFAULT_DB_PATH = "data/scrape2lead.db";
const DEFAULT_DEBUG_DIR = "data/debug";
const REGISTRY_FETCH_RETRIES = 2;

export interface RegistryFetchRetryOptions {
  retries?: number;
  delayMs?: number;
  profileUrl?: string;
  fetchImpl?: typeof fetchRegistryForBin;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Retries a registry lookup that failed for transient reasons — a DNS blip or a
 * timeout takes down a whole plan export otherwise, because assertRegistryCoverage
 * treats one uncovered BIN as fatal.
 *
 * A "not_found" verdict is the registry answering, not failing, so it returns
 * immediately. A parsed page without a record is retried (a partial load looks the
 * same) but is returned rather than thrown once the budget runs out — the caller
 * already distinguishes that case.
 */
export async function fetchRegistryForBinWithRetry(
  page: Page,
  bin: string,
  debugDir: string,
  options: RegistryFetchRetryOptions = {}
): Promise<RegistryFetchResult> {
  const retries = Math.max(0, options.retries ?? REGISTRY_FETCH_RETRIES);
  const delayMs = options.delayMs ?? 0;
  const fetchImpl = options.fetchImpl ?? fetchRegistryForBin;
  const doSleep = options.sleepImpl ?? sleep;

  let lastResult: RegistryFetchResult | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fetchImpl(page, bin, debugDir, options.profileUrl);
      if (result === "not_found" || result.record) return result;
      lastResult = result;
      if (attempt >= retries) return result;
      console.warn(`registry: ${bin} unparseable, retry ${attempt + 1}/${retries}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= retries) {
        console.error(`registry: ${bin} failed after ${attempt + 1} attempts: ${message}`);
        throw error;
      }
      console.warn(`registry: ${bin} retry ${attempt + 1}/${retries}: ${message}`);
    }

    if (delayMs > 0) await doSleep(delayMs);
  }

  // Unreachable: the loop always returns or throws on its final attempt.
  return lastResult ?? "not_found";
}

export async function collectGoszakupRegistryForBins(
  bins: string[],
  options: RegistryCollectOptions = {}
): Promise<RegistryCollectStats> {
  const delayMs = options.delayMs ?? Number(process.env.KZ_ENRICH_DELAY_MS ?? 2000);
  const ttlDays = options.cacheTtlDays ?? Number(process.env.GOSZAKUP_REGISTRY_CACHE_TTL_DAYS ?? 7);
  const storage = new KzStorage({ databasePath: options.databasePath ?? DEFAULT_DB_PATH });
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;

  const stats: RegistryCollectStats = { processed: 0, success: 0, not_found: 0, failed: 0, cached: 0, skipped: 0 };
  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    let index = 0;
    for (const bin of bins) {
      index++;
      options.onProgress?.(index, bins.length, bin);
      if (!isValidBin(bin)) {
        console.warn(`registry: skip invalid BIN ${bin}`);
        stats.skipped++;
        continue;
      }

      if (
        !options.forceRefresh
        && storage.isGoszakupRegistryFresh(bin, ttlDays, new Date(), {
          requireAnyContact: options.requireContacts ?? false,
          requireName: options.requireName ?? false
        })
      ) {
        stats.cached++;
        continue;
      }

      if (!browser) {
        browser = await chromium.launch({
          headless: options.headless ?? true,
          slowMo: options.headless ? 0 : 50
        });
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        page = await context.newPage();
      }

      stats.processed++;
      try {
        const result = await fetchRegistryForBinWithRetry(page!, bin, debugDir, {
          retries: options.fetchRetries,
          delayMs,
          profileUrl: options.profileUrlsByBin?.get(bin)
        });
        if (result === "not_found") {
          stats.not_found++;
        } else if (result.record) {
          storage.upsertGoszakupRegistry({
            ...result.record,
            updated_at: new Date().toISOString(),
            raw_snapshot_path: result.rawSnapshotPath
          });
          stats.success++;
        } else {
          stats.failed++;
          storage.recordEnrichError(bin, "goszakup_registry", "failed to parse registry profile");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.failed++;
        storage.recordEnrichError(bin, "goszakup_registry", message);
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  } finally {
    await browser?.close();
    storage.close();
  }

  return stats;
}
