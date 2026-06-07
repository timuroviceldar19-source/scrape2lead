import { isValidBin, sleep } from "./csv.js";
import { fetchGoszakupTenders, isGoszakupAvailable } from "./goszakupCollector.js";
import { KzStorage } from "./kzStorage.js";
import { collectZakupTendersForBatch } from "./zakupCollector.js";

export interface TendersPipelineOptions {
  databasePath?: string;
  delayMs?: number;
  headless?: boolean;
  skipZakup?: boolean;
  skipGoszakup?: boolean;
}

export interface TenderCollectStats {
  processed: number;
  skipped: number;
  zakupCount: number;
  goszakupCount: number;
  totalTenders: number;
}

const DEFAULT_DB_PATH = "data/scrape2lead.db";

export async function collectTendersForBins(
  bins: string[],
  options: TendersPipelineOptions = {}
): Promise<TenderCollectStats> {
  const storage = new KzStorage({ databasePath: options.databasePath ?? DEFAULT_DB_PATH });
  const validBins = Array.from(new Set(bins.filter(isValidBin)));
  const stats: TenderCollectStats = {
    processed: validBins.length,
    skipped: bins.length - validBins.length,
    zakupCount: 0,
    goszakupCount: 0,
    totalTenders: 0
  };

  try {
    if (!options.skipZakup) {
      const companies = validBins.map((bin) => ({
        bin,
        companyName: storage.getStatGovByBin(bin)?.name ?? null
      }));
      for (const company of companies) {
        if (!company.companyName) {
          storage.recordEnrichError(company.bin, "zakup", "company name missing in stat_gov_data");
        }
      }
      const zakupResult = await collectZakupTendersForBatch(companies, {
        delayMs: options.delayMs ?? 2000,
        headless: options.headless
      });
      storage.upsertTenders(zakupResult.tenders);
      for (const error of zakupResult.errors) {
        storage.recordEnrichError(error.bin, "zakup", error.message);
      }
      if (zakupResult.filtered > 0 && zakupResult.accepted === 0) {
        storage.recordEnrichError("batch", "zakup", `all ${zakupResult.filtered} lots rejected by relevance filter`);
      }
      stats.zakupCount = zakupResult.tenders.length;
      stats.totalTenders += zakupResult.tenders.length;
      stats.skipped += zakupResult.skipped;
    }

    if (!options.skipGoszakup) {
      if (!isGoszakupAvailable()) {
        console.warn("goszakup.gov.kz: source skipped for batch, GOSZAKUP_TOKEN is not set");
      } else {
        for (const bin of validBins) {
          try {
            const tenders = await fetchGoszakupTenders(bin);
            storage.upsertTenders(tenders);
            stats.goszakupCount += tenders.length;
            stats.totalTenders += tenders.length;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            storage.recordEnrichError(bin, "goszakup", message);
          }
          if (options.delayMs && options.delayMs > 0) await sleep(options.delayMs);
        }
      }
    }
  } finally {
    storage.close();
  }

  return stats;
}
