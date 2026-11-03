import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), launch: vi.fn(), close: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("../../src/kz/goszakupRegistryFetcher.js", () => ({ fetchRegistryForBin: mocks.fetch }));
import { collectGoszakupRegistryForBins } from "../../src/kz/goszakupRegistryCollector.js";
import { KzStorage } from "../../src/kz/kzStorage.js";
import { parseRegistryProfileHtml } from "../../src/kz/goszakupRegistryParser.js";

const dirs: string[] = [];
const bins = ["980840002897", "000240001420", "960440000716", "990340001429"];
function record(bin: string) {
  return parseRegistryProfileHtml(fs.readFileSync("tests/fixtures/goszakup-registry-profile-980840002897.html", "utf8").replaceAll(bins[0], bin), bin)!;
}
function options() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gz-partial-registry-")); dirs.push(dir);
  return { databasePath: path.join(dir, "db.sqlite"), strictErrors: true, delayMs: 0, fetchRetries: 0, requireName: true };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.launch.mockResolvedValue({ newContext: async () => ({ newPage: async () => ({}) }), close: mocks.close });
});
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("registry failures during partial exports", () => {
  it("reports failed BINs and opens the registry breaker without fetching remaining BINs", async () => {
    const failure = new Error("page.goto: Timeout"); mocks.fetch.mockRejectedValue(failure); const onFailure = vi.fn();
    const stats = await collectGoszakupRegistryForBins(bins, { ...options(), maxConsecutiveNetworkFailures: 2, onFailure });
    expect(mocks.fetch).toHaveBeenCalledTimes(2); expect(stats.failed).toBe(4);
    expect(onFailure.mock.calls).toEqual([
      [bins[0], failure, 1], [bins[1], failure, 1],
      [bins[2], expect.objectContaining({ message: expect.stringContaining("circuit_breaker") }), 0],
      [bins[3], expect.any(Error), 0]
    ]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("keeps an existing usable cached profile even if the breaker is open", async () => {
    const opts = options(); const storage = new KzStorage({ databasePath: opts.databasePath });
    storage.upsertGoszakupRegistry({ ...record(bins[1]), updated_at: new Date().toISOString(), raw_snapshot_path: null }); storage.close();
    mocks.fetch.mockRejectedValue(new Error("fetch failed"));
    const stats = await collectGoszakupRegistryForBins(bins.slice(0, 2), { ...opts, maxConsecutiveNetworkFailures: 1 });
    expect(stats.cached).toBe(1); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("resets the streak after a successful fetch and stores the profile", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ record: record(bins[1]), rawSnapshotPath: null }).mockResolvedValue("not_found");
    const stats = await collectGoszakupRegistryForBins(bins, { ...options(), maxConsecutiveNetworkFailures: 2 });
    expect(stats).toMatchObject({ failed: 1, success: 1, not_found: 2 }); expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });
  it("propagates programming errors in strict mode and closes the browser", async () => {
    mocks.fetch.mockRejectedValue(new TypeError("invalid registry schema"));
    await expect(collectGoszakupRegistryForBins(bins, options())).rejects.toThrow("invalid registry schema");
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("does not label an unparseable response as a network failure", async () => {
    mocks.fetch.mockResolvedValue({ record: null, rawSnapshotPath: null }); const onFailure = vi.fn();
    const stats = await collectGoszakupRegistryForBins([bins[0]], { ...options(), onFailure });
    expect(stats.failed).toBe(1); expect(onFailure).not.toHaveBeenCalled();
  });
  it("keeps the legacy best-effort behavior outside strict automation", async () => {
    mocks.fetch.mockRejectedValue(new Error("invalid registry schema"));
    const stats = await collectGoszakupRegistryForBins(["invalid", bins[0]], { ...options(), strictErrors: false });
    expect(stats).toMatchObject({ skipped: 1, failed: 1 });
  });
});
