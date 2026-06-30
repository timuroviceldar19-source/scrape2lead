import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { loadBuyStatusRef, getActiveStatusIds, isActiveBuyStatus, resolveBuyStatusName, resetStatusRefCache } from "../../src/kz/goszakupStatus.js";
import refs from "../fixtures/goszakup-v3-refs.json" with { type: "json" };

function makeFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("goszakupStatus", () => {
  beforeEach(() => {
    resetStatusRefCache();
    delete process.env.GOSZAKUP_ACTIVE_STATUS_IDS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GOSZAKUP_ACTIVE_STATUS_IDS;
  });

  it("loads status ref from API", async () => {
    const fetchFn = makeFetch(refs);
    const map = await loadBuyStatusRef({ token: "test", fetchFn });
    expect(map.size).toBe(7);
    expect(map.get(210)).toBe("Опубликована");
    expect(map.get(230)).toBe("Завершена");
  });

  it("caches status ref after first load", async () => {
    const fetchFn = makeFetch(refs);
    const map1 = await loadBuyStatusRef({ token: "test", fetchFn });
    const map2 = await loadBuyStatusRef({ token: "test", fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(map1).toBe(map2);
  });

  it("returns empty map on API failure", async () => {
    const fetchFn = vi.fn(async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    const map = await loadBuyStatusRef({ token: "test", fetchFn, maxRetries: 0 });
    expect(map.size).toBe(0);
  });

  it("getActiveStatusIds defaults to [210, 220]", () => {
    const ids = getActiveStatusIds();
    expect(ids.has(210)).toBe(true);
    expect(ids.has(220)).toBe(true);
    expect(ids.has(230)).toBe(false);
  });

  it("getActiveStatusIds reads from env override", () => {
    process.env.GOSZAKUP_ACTIVE_STATUS_IDS = "210,220,250";
    const ids = getActiveStatusIds();
    expect(ids.has(250)).toBe(true);
    expect(ids.size).toBe(3);
  });

  it("isActiveBuyStatus returns true for active IDs", () => {
    expect(isActiveBuyStatus(210)).toBe(true);
    expect(isActiveBuyStatus(220)).toBe(true);
    expect(isActiveBuyStatus(230)).toBe(false);
    expect(isActiveBuyStatus(null)).toBe(false);
  });

  it("isActiveBuyStatus respects custom set", () => {
    const custom = new Set([230, 240]);
    expect(isActiveBuyStatus(230, custom)).toBe(true);
    expect(isActiveBuyStatus(210, custom)).toBe(false);
  });

  it("resolveBuyStatusName returns name from map", async () => {
    const fetchFn = makeFetch(refs);
    const map = await loadBuyStatusRef({ token: "test", fetchFn });
    expect(resolveBuyStatusName(210, map)).toBe("Опубликована");
    expect(resolveBuyStatusName(999, map)).toBe("999");
  });

  it("resetStatusRefCache clears cached data", async () => {
    const fetchFn = makeFetch(refs);
    await loadBuyStatusRef({ token: "test", fetchFn });
    resetStatusRefCache();
    await loadBuyStatusRef({ token: "test", fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
