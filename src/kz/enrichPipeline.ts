import { readBinsFromCsv } from "./csv.js";
import { collectGoszakupRegistryForBins, type RegistryCollectStats } from "./goszakupRegistryCollector.js";
import { KzStorage } from "./kzStorage.js";
import { collectStatGovForBins, type StatGovCollectStats } from "./statGovCollector.js";
import { collectTendersForBins, type TenderCollectStats } from "./tendersPipeline.js";

export interface KzEnrichOptions {
  csvFile?: string;
  bins?: string[];
  databasePath?: string;
  skipStat?: boolean;
  skipTenders?: boolean;
  skipZakup?: boolean;
  skipGoszakup?: boolean;
  skipGoszakupRegistry?: boolean;
  skipGoszakupHtml?: boolean;
  registryOnly?: boolean;
  registryForceRefresh?: boolean;
  delayMs?: number;
  forceRefresh?: boolean;
  goszakupActiveOnly?: boolean;
  goszakupMaxPages?: number;
  zakupMaxRetries?: number;
  onProgress?: (stage: string, index: number, total: number, bin: string) => void;
}

export interface KzEnrichResult {
  bins: number;
  stat: StatGovCollectStats | null;
  registry: RegistryCollectStats | null;
  tenders: TenderCollectStats | null;
  errorsCount: number;
}

export async function runKzEnrich(options: KzEnrichOptions): Promise<KzEnrichResult> {
  const bins = resolveEnrichBins(options);
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
      forceRefresh: options.forceRefresh,
      onProgress: (index, total, bin) => options.onProgress?.("stat.gov", index, total, bin)
    });
  }

  if (!skipRegistry) {
    registry = await collectGoszakupRegistryForBins(bins, {
      databasePath: options.databasePath,
      delayMs: options.delayMs,
      forceRefresh: options.registryForceRefresh ?? options.forceRefresh,
      onProgress: (index, total, bin) => options.onProgress?.("registry", index, total, bin)
    });
  }

  if (!skipTenders) {
    tenders = await collectTendersForBins(bins, {
      databasePath: options.databasePath,
      delayMs: options.delayMs,
      skipZakup: options.skipZakup,
      skipGoszakupHtml: options.skipGoszakupHtml,
      goszakupActiveOnly: options.goszakupActiveOnly,
      goszakupMaxPages: options.goszakupMaxPages,
      zakupMaxRetries: options.zakupMaxRetries,
      onProgress: (stage, index, total, bin) => options.onProgress?.(stage, index, total, bin)
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
    ? `processed=${result.tenders.processed} zakup=${result.tenders.zakupCount} goszakup=${result.tenders.goszakupCount} goszakup_html=${result.tenders.goszakupHtmlCount}+${result.tenders.goszakupHtmlLots}lots+${result.tenders.goszakupHtmlContracts}contracts total=${result.tenders.totalTenders} skipped=${result.tenders.skipped}`
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

function resolveEnrichBins(options: KzEnrichOptions): string[] {
  if (options.bins && options.bins.length > 0) {
    return options.bins;
  }
  if (options.csvFile) {
    return readBinsFromCsv(options.csvFile);
  }
  throw new Error("KzEnrichOptions requires csvFile or bins");
}
