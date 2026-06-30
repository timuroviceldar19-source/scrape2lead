import { beforeEach, describe, expect, it, vi } from "vitest";
import { runKzEnrichWithFallbackRetry } from "../../src/kz/autopilotEnrichRetry.js";
import { runKzEnrich, type KzEnrichResult } from "../../src/kz/enrichPipeline.js";

vi.mock("../../src/kz/enrichPipeline.js", () => ({
  runKzEnrich: vi.fn(),
  formatKzEnrichResult: vi.fn()
}));

const mockRunKzEnrich = vi.mocked(runKzEnrich);

beforeEach(() => {
  mockRunKzEnrich.mockReset();
});

function makeResult(partial: Partial<KzEnrichResult> = {}): KzEnrichResult {
  return {
    bins: 1,
    stat: {
      processed: 1,
      success: 1,
      failed: 0,
      skipped: 0,
      cached: 0
    },
    registry: {
      processed: 1,
      success: 1,
      not_found: 0,
      failed: 0,
      cached: 0,
      skipped: 0
    },
    tenders: {
      processed: 1,
      skipped: 0,
      zakupCount: 1,
      goszakupCount: 0,
      goszakupRaw: 0,
      goszakupFiltered: 0,
      goszakupPages: 0,
      goszakupHtmlCount: 0,
      goszakupHtmlLots: 0,
      goszakupHtmlContracts: 0,
      totalTenders: 1
    },
    errorsCount: 0,
    ...partial
  };
}

describe("runKzEnrichWithFallbackRetry", () => {
  it("returns batch result without per-bin fallback when batch succeeds", async () => {
    const batchResult = makeResult({ bins: 3 });
    mockRunKzEnrich.mockResolvedValueOnce(batchResult);

    const result = await runKzEnrichWithFallbackRetry({
      bins: ["111", "222", "333"],
      retries: 1,
      baseDelayMs: 1
    });

    expect(result.enrichMode).toBe("batch");
    expect(result.enrichRetryAttempts).toBe(0);
    expect(result.enrichFailedBins).toEqual([]);
    expect(result.bins).toBe(3);
    expect(mockRunKzEnrich).toHaveBeenCalledTimes(1);
  });

  it("falls back to per-bin mode when batch fails with a retriable error", async () => {
    mockRunKzEnrich
      .mockRejectedValueOnce(new Error("batch navigation timeout"))
      .mockResolvedValueOnce(makeResult({ bins: 1, stat: { processed: 1, success: 1, failed: 0, skipped: 0, cached: 0 } }))
      .mockResolvedValueOnce(makeResult({ bins: 1, stat: { processed: 1, success: 1, failed: 0, skipped: 0, cached: 0 } }));

    const result = await runKzEnrichWithFallbackRetry({
      bins: ["111", "222"],
      retries: 1,
      baseDelayMs: 1
    });

    expect(result.enrichMode).toBe("per-bin");
    expect(result.enrichBatchError).toBe("batch navigation timeout");
    expect(result.enrichFailedBins).toEqual([]);
    expect(result.bins).toBe(2);
    expect(mockRunKzEnrich).toHaveBeenCalledTimes(3);
  });

  it("retries transient per-bin errors and succeeds", async () => {
    mockRunKzEnrich
      .mockRejectedValueOnce(new Error("batch connection reset"))
      .mockRejectedValueOnce(new Error("timeout waiting for selector"))
      .mockResolvedValueOnce(makeResult({ bins: 1 }));

    const result = await runKzEnrichWithFallbackRetry({
      bins: ["111"],
      retries: 2,
      baseDelayMs: 1
    });

    expect(result.enrichMode).toBe("per-bin");
    expect(result.enrichRetryAttempts).toBe(1);
    expect(result.enrichFailedBins).toEqual([]);
    expect(result.stat?.success).toBe(1);
  });

  it("aggregates stats, registry, tenders and errorsCount across successful per-bin runs", async () => {
    mockRunKzEnrich
      .mockRejectedValueOnce(new Error("batch page crashed"))
      .mockResolvedValueOnce(makeResult({
        bins: 1,
        stat: { processed: 1, success: 1, failed: 0, skipped: 0, cached: 0 },
        registry: { processed: 1, success: 0, not_found: 1, failed: 0, cached: 0, skipped: 0 },
        tenders: { processed: 1, skipped: 0, zakupCount: 2, goszakupCount: 0, goszakupRaw: 0, goszakupFiltered: 0, goszakupPages: 0, goszakupHtmlCount: 0, goszakupHtmlLots: 0, goszakupHtmlContracts: 0, totalTenders: 2 },
        errorsCount: 1
      }))
      .mockResolvedValueOnce(makeResult({
        bins: 1,
        stat: { processed: 1, success: 0, failed: 1, skipped: 0, cached: 0 },
        registry: { processed: 1, success: 1, not_found: 0, failed: 0, cached: 0, skipped: 0 },
        tenders: { processed: 1, skipped: 0, zakupCount: 0, goszakupCount: 3, goszakupRaw: 5, goszakupFiltered: 2, goszakupPages: 1, goszakupHtmlCount: 0, goszakupHtmlLots: 0, goszakupHtmlContracts: 0, totalTenders: 3 },
        errorsCount: 2
      }));

    const result = await runKzEnrichWithFallbackRetry({
      bins: ["111", "222"],
      retries: 1,
      baseDelayMs: 1
    });

    expect(result.enrichMode).toBe("per-bin");
    expect(result.bins).toBe(2);
    expect(result.stat).toEqual({ processed: 2, success: 1, failed: 1, skipped: 0, cached: 0 });
    expect(result.registry).toEqual({ processed: 2, success: 1, not_found: 1, failed: 0, cached: 0, skipped: 0 });
    expect(result.tenders).toMatchObject({ processed: 2, zakupCount: 2, goszakupCount: 3, totalTenders: 5 });
    expect(result.errorsCount).toBe(3);
  });

  it("rethrows non-retryable batch errors without per-bin fallback", async () => {
    mockRunKzEnrich.mockRejectedValueOnce(new Error("stat.gov session not found at data/stat-gov-session.json"));

    await expect(runKzEnrichWithFallbackRetry({
      bins: ["111", "222"],
      retries: 2,
      baseDelayMs: 1
    })).rejects.toThrow("session not found");

    expect(mockRunKzEnrich).toHaveBeenCalledTimes(1);
  });

  it("rethrows batch errors when retries are disabled", async () => {
    mockRunKzEnrich.mockRejectedValueOnce(new Error("batch navigation timeout"));

    await expect(runKzEnrichWithFallbackRetry({
      bins: ["111"],
      retries: 0,
      baseDelayMs: 1
    })).rejects.toThrow("navigation timeout");

    expect(mockRunKzEnrich).toHaveBeenCalledTimes(1);
  });

  it("records failed BINs when per-bin retries are exhausted", async () => {
    mockRunKzEnrich
      .mockRejectedValueOnce(new Error("batch connection reset"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"));

    const result = await runKzEnrichWithFallbackRetry({
      bins: ["111"],
      retries: 1,
      baseDelayMs: 1
    });

    expect(result.enrichMode).toBe("per-bin");
    expect(result.enrichFailedBins).toEqual(["111"]);
    expect(result.stat).toBeNull();
    expect(result.registry).toBeNull();
    expect(result.tenders).toBeNull();
  });

  it("stops processing remaining BINs when the deadline expires", async () => {
    mockRunKzEnrich
      .mockRejectedValueOnce(new Error("batch timeout"))
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return makeResult({ bins: 1 });
      });

    const result = await runKzEnrichWithFallbackRetry({
      bins: ["111", "222", "333"],
      retries: 1,
      baseDelayMs: 1,
      deadlineMs: 10
    });

    expect(result.enrichMode).toBe("per-bin");
    expect(result.enrichFailedBins).toEqual(["222", "333"]);
    expect(result.bins).toBe(3);
  });
});
