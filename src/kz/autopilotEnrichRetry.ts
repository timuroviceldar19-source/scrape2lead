import { withRetry } from "../core/retry.js";
import { runKzEnrich, type KzEnrichResult } from "./enrichPipeline.js";

export interface AutopilotEnrichRetryOptions {
  bins: string[];
  databasePath?: string;
  goszakupMaxPages?: number;
  onProgress?: (stage: string, index: number, total: number, bin: string) => void;
  /** Max retries per BIN in per-bin fallback mode. 0 disables fallback entirely. */
  retries: number;
  /** Exponential backoff base delay in ms. */
  baseDelayMs: number;
  /** Optional overall deadline in ms from the start of fallback. Disabled if undefined. */
  deadlineMs?: number;
}

export interface AutopilotEnrichRetryResult extends KzEnrichResult {
  enrichMode: "batch" | "per-bin";
  /** Error message that caused the batch attempt to fail and triggered fallback. */
  enrichBatchError?: string;
  /** Total retry attempts consumed across all per-bin runs. */
  enrichRetryAttempts: number;
  /** BINs that failed even after retries (or were skipped because the deadline expired). */
  enrichFailedBins: string[];
}

const TRANSIENT_PATTERNS = [
  "timeout",
  "waiting for",
  "navigation",
  "net::",
  "etimedout",
  "econnreset",
  "epipe",
  "socket hang up",
  "temporary",
  "unreachable",
  "target closed",
  "connection",
  "page crashed",
  "browser has been closed",
  "networkidle",
  "load",
  "domcontentloaded"
];

const NON_RETRYABLE_PATTERNS = [
  "session not found",
  "invalid token",
  "invalid or expired token",
  "auth",
  "requires csvfile or bins",
  "invalid options",
  "missing stat-gov-session"
];

function isRetriableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (NON_RETRYABLE_PATTERNS.some((pattern) => lower.includes(pattern))) return false;
  return TRANSIENT_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isRetriableBatchError(error: unknown): boolean {
  // Batch-level non-retryable errors must surface immediately without per-bin fallback.
  return isRetriableError(error);
}

function isRetriableBinError(error: unknown): boolean {
  return isRetriableError(error);
}

function mergeStats(
  successful: KzEnrichResult[],
  totalBins: number
): Pick<KzEnrichResult, "bins" | "stat" | "registry" | "tenders" | "errorsCount"> {
  const statResults = successful.map((r) => r.stat).filter((s): s is NonNullable<typeof s> => s !== null);
  const registryResults = successful
    .map((r) => r.registry)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const tenderResults = successful.map((r) => r.tenders).filter((t): t is NonNullable<typeof t> => t !== null);

  const stat = statResults.length > 0
    ? statResults.reduce((acc, s) => ({
        processed: acc.processed + s.processed,
        success: acc.success + s.success,
        failed: acc.failed + s.failed,
        skipped: acc.skipped + s.skipped,
        cached: acc.cached + s.cached
      }))
    : null;

  const registry = registryResults.length > 0
    ? registryResults.reduce((acc, r) => ({
        processed: acc.processed + r.processed,
        success: acc.success + r.success,
        not_found: acc.not_found + r.not_found,
        failed: acc.failed + r.failed,
        cached: acc.cached + r.cached,
        skipped: acc.skipped + r.skipped
      }))
    : null;

  const tenders = tenderResults.length > 0
    ? tenderResults.reduce((acc, t) => ({
        processed: acc.processed + t.processed,
        skipped: acc.skipped + t.skipped,
        zakupCount: acc.zakupCount + t.zakupCount,
        goszakupCount: acc.goszakupCount + t.goszakupCount,
        goszakupRaw: acc.goszakupRaw + t.goszakupRaw,
        goszakupFiltered: acc.goszakupFiltered + t.goszakupFiltered,
        goszakupPages: acc.goszakupPages + t.goszakupPages,
        goszakupHtmlCount: acc.goszakupHtmlCount + t.goszakupHtmlCount,
        goszakupHtmlLots: acc.goszakupHtmlLots + t.goszakupHtmlLots,
        goszakupHtmlContracts: acc.goszakupHtmlContracts + t.goszakupHtmlContracts,
        totalTenders: acc.totalTenders + t.totalTenders
      }))
    : null;

  const errorsCount = successful.reduce((sum, r) => sum + r.errorsCount, 0);

  return { bins: totalBins, stat, registry, tenders, errorsCount };
}

export async function runKzEnrichWithFallbackRetry(
  options: AutopilotEnrichRetryOptions
): Promise<AutopilotEnrichRetryResult> {
  const { bins, databasePath, goszakupMaxPages, onProgress, retries, baseDelayMs, deadlineMs } = options;

  const commonOptions = {
    databasePath,
    skipZakup: true,
    goszakupMaxPages
  };

  try {
    const result = await runKzEnrich({
      bins,
      ...commonOptions,
      onProgress
    });
    return {
      ...result,
      enrichMode: "batch",
      enrichRetryAttempts: 0,
      enrichFailedBins: []
    };
  } catch (batchError) {
    const batchErrorMessage = batchError instanceof Error ? batchError.message : String(batchError);
    if (retries <= 0 || !isRetriableBatchError(batchError)) {
      throw batchError;
    }

    const deadlineAt = deadlineMs ? Date.now() + deadlineMs : undefined;
    const failedBins: string[] = [];
    const successfulResults: KzEnrichResult[] = [];
    let enrichRetryAttempts = 0;

    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];

      if (deadlineAt && Date.now() >= deadlineAt) {
        failedBins.push(...bins.slice(i));
        break;
      }

      onProgress?.("enrich-per-bin", i + 1, bins.length, bin);

      let binRetryAttempts = 0;
      try {
        const binResult = await withRetry(
          () =>
            runKzEnrich({
              bins: [bin],
              ...commonOptions
            }),
          {
            maxRetries: retries,
            baseDelayMs,
            shouldRetry: (error) => {
              if (!isRetriableBinError(error)) return false;
              binRetryAttempts += 1;
              return true;
            }
          }
        );
        successfulResults.push(binResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedBins.push(bin);
        console.warn(`autopilot: enrich failed for BIN ${bin} after ${retries} retries: ${message}`);
      }

      enrichRetryAttempts += binRetryAttempts;
    }

    const aggregated = mergeStats(successfulResults, bins.length);

    return {
      ...aggregated,
      enrichMode: "per-bin",
      enrichBatchError: batchErrorMessage,
      enrichRetryAttempts,
      enrichFailedBins: failedBins
    };
  }
}
