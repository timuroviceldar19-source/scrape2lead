import { chromium, type Browser, type Page } from "playwright";
import { isValidBin, sleep } from "./csv.js";
import { KzStorage } from "./kzStorage.js";
import { fetchRegistryForBin } from "./goszakupRegistryFetcher.js";

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
        const result = await fetchRegistryForBin(
          page!,
          bin,
          debugDir,
          options.profileUrlsByBin?.get(bin)
        );
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
