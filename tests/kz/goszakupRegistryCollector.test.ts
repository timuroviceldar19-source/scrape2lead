import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { fetchRegistryForBin } from "../../src/kz/goszakupRegistryFetcher.js";
import { fetchRegistryForBinWithRetry } from "../../src/kz/goszakupRegistryCollector.js";
import { parseRegistryProfileHtml } from "../../src/kz/goszakupRegistryParser.js";

const FIXTURES = path.resolve("tests/fixtures");
const PROFILE_URL = "https://goszakup.gov.kz/ru/registry/show_supplier/34591";
const PROFILE_HTML = fs.readFileSync(path.join(FIXTURES, "goszakup-registry-profile-980840002897.html"), "utf8");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fetchRegistryForBin direct profile hints", () => {
  it("opens the direct supplier profile without using the search form", async () => {
    const mock = createPageMock([PROFILE_HTML]);
    const result = await fetchRegistryForBin(mock.page, "980840002897", tempDir(), PROFILE_URL);

    expect(result).not.toBe("not_found");
    expect(result !== "not_found" && result.record?.participant_id).toBe("34591");
    expect(result !== "not_found" && result.record?.registry_url).toBe(PROFILE_URL);
    expect(mock.visited).toEqual([PROFILE_URL]);
    expect(mock.searchUses).toBe(0);
  });

  it("falls back to BIN search when the direct profile contains another BIN", async () => {
    const mismatched = PROFILE_HTML.replaceAll("980840002897", "123456789012");
    const searchHtml = `<table><tr><td>980840002897</td><td><a href="/ru/registry/show_supplier/34591">Profile</a></td></tr></table>`;
    const mock = createPageMock([mismatched, searchHtml, PROFILE_HTML]);
    const result = await fetchRegistryForBin(mock.page, "980840002897", tempDir(), PROFILE_URL);

    expect(result).not.toBe("not_found");
    expect(result !== "not_found" && result.record?.bin).toBe("980840002897");
    expect(mock.visited).toEqual([
      PROFILE_URL,
      "https://goszakup.gov.kz/ru/registry/supplierreg",
      PROFILE_URL
    ]);
    expect(mock.searchUses).toBe(3);
  });

  it("falls back to BIN search after a direct navigation error", async () => {
    const searchHtml = `<table><tr><td>980840002897</td><td><a href="/ru/registry/show_supplier/34591">Profile</a></td></tr></table>`;
    const mock = createPageMock([searchHtml, PROFILE_HTML], true);
    const result = await fetchRegistryForBin(mock.page, "980840002897", tempDir(), PROFILE_URL);

    expect(result).not.toBe("not_found");
    expect(result !== "not_found" && result.record?.name_ru).toContain("Жарминского района");
  });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-registry-"));
  tempDirs.push(dir);
  return dir;
}

function createPageMock(contents: string[], failFirstGoto = false): {
  page: Page;
  visited: string[];
  searchUses: number;
} {
  const state = { visited: [] as string[], searchUses: 0, gotoCalls: 0 };
  const control = {
    waitFor: async () => { state.searchUses++; },
    fill: async () => { state.searchUses++; },
    click: async () => { state.searchUses++; }
  };
  const page = {
    async goto(url: string) {
      state.visited.push(url);
      state.gotoCalls++;
      if (failFirstGoto && state.gotoCalls === 1) throw new Error("direct timeout");
      return null;
    },
    async content() {
      const content = contents.shift();
      if (content == null) throw new Error("missing mocked page content");
      return content;
    },
    locator() {
      return { first: () => control };
    },
    async waitForLoadState() {}
  } as unknown as Page;
  return {
    page,
    visited: state.visited,
    get searchUses() { return state.searchUses; }
  };
}

describe("fetchRegistryForBinWithRetry", () => {
  const BIN = "980840002897";
  const DEBUG_DIR = "/tmp/unused";

  it("retries a transient navigation error and returns the record from a later attempt", async () => {
    const attempts: number[] = [];
    const fetchImpl = async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) throw new Error("net::ERR_NAME_NOT_RESOLVED");
      return { record: recordFor(BIN), rawSnapshotPath: null };
    };

    const result = await fetchRegistryForBinWithRetry({} as Page, BIN, DEBUG_DIR, {
      retries: 2,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => {}
    });

    expect(attempts).toHaveLength(3);
    expect(result).not.toBe("not_found");
    expect(result !== "not_found" && result.record?.bin).toBe(BIN);
  });

  it("rethrows the last error once the retry budget is exhausted", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error(`attempt ${calls} failed`);
    };

    await expect(fetchRegistryForBinWithRetry({} as Page, BIN, DEBUG_DIR, {
      retries: 2,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => {}
    })).rejects.toThrow("attempt 3 failed");

    expect(calls).toBe(3);
  });

  it("does not retry a definitive not_found verdict", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return "not_found" as const;
    };

    const result = await fetchRegistryForBinWithRetry({} as Page, BIN, DEBUG_DIR, {
      retries: 2,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => {}
    });

    expect(result).toBe("not_found");
    expect(calls).toBe(1);
  });

  it("retries when a page loads but yields no parseable record", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return { record: null, rawSnapshotPath: null };
      return { record: recordFor(BIN), rawSnapshotPath: null };
    };

    const result = await fetchRegistryForBinWithRetry({} as Page, BIN, DEBUG_DIR, {
      retries: 2,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => {}
    });

    expect(calls).toBe(2);
    expect(result !== "not_found" && result.record?.bin).toBe(BIN);
  });

  it("returns the unparseable result instead of throwing when retries run out", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { record: null, rawSnapshotPath: null };
    };

    const result = await fetchRegistryForBinWithRetry({} as Page, BIN, DEBUG_DIR, {
      retries: 1,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => {}
    });

    expect(calls).toBe(2);
    expect(result !== "not_found" && result.record).toBeNull();
  });

  it("waits the configured delay between attempts but not after the last one", async () => {
    const waits: number[] = [];
    const fetchImpl = async () => {
      throw new Error("boom");
    };

    await expect(fetchRegistryForBinWithRetry({} as Page, BIN, DEBUG_DIR, {
      retries: 2,
      delayMs: 1500,
      fetchImpl,
      sleepImpl: async (ms: number) => { waits.push(ms); }
    })).rejects.toThrow("boom");

    expect(waits).toEqual([1500, 1500]);
  });

  it("makes exactly one attempt when the retry budget is zero or negative", async () => {
    for (const retries of [0, -1]) {
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        throw new Error("boom");
      };

      await expect(fetchRegistryForBinWithRetry({} as Page, BIN, DEBUG_DIR, {
        retries,
        delayMs: 0,
        fetchImpl,
        sleepImpl: async () => {}
      })).rejects.toThrow("boom");

      expect(calls).toBe(1);
    }
  });

  it("passes the direct profile hint through to every attempt", async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = async (_page: Page, _bin: string, _debugDir: string, profileUrl?: string) => {
      seen.push(profileUrl);
      if (seen.length < 2) throw new Error("transient");
      return { record: recordFor(BIN), rawSnapshotPath: null };
    };

    await fetchRegistryForBinWithRetry({} as Page, BIN, DEBUG_DIR, {
      retries: 2,
      delayMs: 0,
      profileUrl: PROFILE_URL,
      fetchImpl,
      sleepImpl: async () => {}
    });

    expect(seen).toEqual([PROFILE_URL, PROFILE_URL]);
  });
});

function recordFor(bin: string) {
  return parseRegistryProfileHtml(PROFILE_HTML.replaceAll("980840002897", bin), bin);
}
