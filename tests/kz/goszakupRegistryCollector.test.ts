import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { fetchRegistryForBin } from "../../src/kz/goszakupRegistryFetcher.js";

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
