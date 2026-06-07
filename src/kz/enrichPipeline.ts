import { readBinsFromCsv } from "./csv.js";
import { KzStorage } from "./kzStorage.js";
import { collectStatGovForBins, type StatGovCollectStats } from "./statGovCollector.js";
import { collectTendersForBins, type TenderCollectStats } from "./tendersPipeline.js";

export interface KzEnrichOptions {
  csvFile: string;
  databasePath?: string;
  skipStat?: boolean;
  skipTenders?: boolean;
  delayMs?: number;
  forceRefresh?: boolean;
}

export interface KzEnrichResult {
  bins: number;
  stat: StatGovCollectStats | null;
  tenders: TenderCollectStats | null;
  errorsCount: number;
}

export async function runKzEnrich(options: KzEnrichOptions): Promise<KzEnrichResult> {
  const bins = readBinsFromCsv(options.csvFile);
  let stat: StatGovCollectStats | null = null;
  let tenders: TenderCollectStats | null = null;

  if (!options.skipStat) {
    stat = await collectStatGovForBins(bins, {
      databasePath: options.databasePath,
      delayMs: options.delayMs,
      forceRefresh: options.forceRefresh
    });
  }

  if (!options.skipTenders) {
    tenders = await collectTendersForBins(bins, {
      databasePath: options.databasePath,
      delayMs: options.delayMs
    });
  }

  const storage = new KzStorage({ databasePath: options.databasePath });
  try {
    return {
      bins: bins.length,
      stat,
      tenders,
      errorsCount: storage.getEnrichErrors().length
    };
  } finally {
    storage.close();
  }
}

export function formatKzEnrichResult(result: KzEnrichResult): string {
  const stat = result.stat
    ? `processed=${result.stat.processed} success=${result.stat.success} failed=${result.stat.failed} skipped=${result.stat.skipped} cached=${result.stat.cached}`
    : "skipped";
  const tenders = result.tenders
    ? `processed=${result.tenders.processed} zakup=${result.tenders.zakupCount} goszakup=${result.tenders.goszakupCount} total=${result.tenders.totalTenders} skipped=${result.tenders.skipped}`
    : "skipped";

  return [
    "KZ enrich summary",
    `bins=${result.bins}`,
    `stat: ${stat}`,
    `tenders: ${tenders}`,
    `errors_total=${result.errorsCount}`,
    "Run npm run kz:export to generate report."
  ].join("\n");
}
