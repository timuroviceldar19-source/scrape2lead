import { readBinsFromCsv } from "./csv.js";
import { collectGoszakupRegistryForBins, type RegistryCollectStats } from "./goszakupRegistryCollector.js";
import { KzStorage } from "./kzStorage.js";
import { collectStatGovForBins, type StatGovCollectStats } from "./statGovCollector.js";
import { collectTendersForBins, type TenderCollectStats } from "./tendersPipeline.js";

export interface KzEnrichOptions {
  csvFile: string;
  databasePath?: string;
  skipStat?: boolean;
  skipTenders?: boolean;
  skipZakup?: boolean;
  skipGoszakupRegistry?: boolean;
  registryOnly?: boolean;
  registryForceRefresh?: boolean;
  delayMs?: number;
  forceRefresh?: boolean;
  goszakupActiveOnly?: boolean;
  goszakupMaxPages?: number;
  zakupMaxRetries?: number;
}

export interface KzEnrichResult {
  bins: number;
  stat: StatGovCollectStats | null;
  registry: RegistryCollectStats | null;
  tenders: TenderCollectStats | null;
  errorsCount: number;
}

export async function runKzEnrich(options: KzEnrichOptions): Promise<KzEnrichResult> {
  const bins = readBinsFromCsv(options.csvFile);
  let stat: StatGovCollectStats | null = null;
  let registry: RegistryCollectStats | null = null;
  let tenders: TenderCollectStats | null = null;

  const skipStat = options.skipStat || options.registryOnly;
  const skipTenders = options.skipTenders || options.registryOnly;
  const skipRegistry = options.skipGoszakupRegistry || false;

  if (!skipStat) {
    stat = await collectStatGovForBins(bins, {
      databasePath: options.databasePath,
      delayMs: options.delayMs,
      forceRefresh: options.forceRefresh
    });
  }

  if (!skipRegistry) {
    registry = await collectGoszakupRegistryForBins(bins, {
      databasePath: options.databasePath,
      delayMs: options.delayMs,
      forceRefresh: options.registryForceRefresh ?? options.forceRefresh
    });
  }

  if (!skipTenders) {
    tenders = await collectTendersForBins(bins, {
      databasePath: options.databasePath,
      delayMs: options.delayMs,
      skipZakup: options.skipZakup,
      goszakupActiveOnly: options.goszakupActiveOnly,
      goszakupMaxPages: options.goszakupMaxPages,
      zakupMaxRetries: options.zakupMaxRetries
    });
  }

  const storage = new KzStorage({ databasePath: options.databasePath });
  try {
    return {
      bins: bins.length,
      stat,
      registry,
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
  const registry = result.registry
    ? `processed=${result.registry.processed} success=${result.registry.success} not_found=${result.registry.not_found} cached=${result.registry.cached} failed=${result.registry.failed}`
    : "skipped";
  const tenders = result.tenders
    ? `processed=${result.tenders.processed} zakup=${result.tenders.zakupCount} goszakup=${result.tenders.goszakupCount} total=${result.tenders.totalTenders} skipped=${result.tenders.skipped}`
    : "skipped";

  return [
    "KZ enrich summary",
    `bins=${result.bins}`,
    `stat: ${stat}`,
    `registry: ${registry}`,
    `tenders: ${tenders}`,
    `errors_total=${result.errorsCount}`,
    "Run npm run kz:export to generate report."
  ].join("\n");
}
