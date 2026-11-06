import { describe, expect, it, vi } from "vitest";
import { buildZakupUrl, mapWithConcurrency, zakupGet, zakupListAll } from "../../src/kz/zakupPublicApi.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fast = { retryDelayMs: 0, pauseMs: 0 };

describe("zakupPublicApi", () => {
  it("builds urls under the public API and drops empty params", () => {
    expect(buildZakupUrl("/public/contracts/", { limit: 100, offset: 0, system_id: 1, enstru_code__startswith: "262030.100.", empty: "", none: undefined }))
      .toBe("https://zakup.gov.kz/api/core/api/public/contracts/?limit=100&offset=0&system_id=1&enstru_code__startswith=262030.100.");
  });

  it("retries network errors and 5xx, then returns the JSON", async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }))
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json({ ok: true }));
    await expect(zakupGet("/public/stats/counts/", {}, { ...fast, fetchFn })).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 400: a wrong parameter will not fix itself", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ detail: "Unrecognized query parameters: page_size" }, 400));
    await expect(zakupGet("/public/contracts/", { page_size: 2 }, { ...fast, fetchFn })).rejects.toThrow(/HTTP 400 .*page_size/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("names the network cause after the last retry", async () => {
    const fetchFn = vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    await expect(zakupGet("/public/lots/", {}, { ...fast, maxRetries: 2, fetchFn })).rejects.toThrow("zakup /public/lots/: ECONNRESET");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("walks limit/offset pages of 100 until count is reached", async () => {
    const offsets: number[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      const size = offset === 0 ? 100 : 30;
      return json({ count: 130, next: offset === 0 ? "next" : null, results: Array.from({ length: size }, (_, i) => ({ id: offset + i })) });
    });
    const items = await zakupListAll<{ id: number }>("/public/contracts/", { sign_date__gte: "2026-10-01" }, { ...fast, fetchFn: fetchFn as unknown as typeof fetch });
    expect(items).toHaveLength(130);
    expect(offsets).toEqual([0, 100]);
  });

  it("splits large signed-date ranges before the API's 10000-record offset ceiling", async () => {
    const calls: string[][] = [];
    const fetchFn = vi.fn(async (url: string) => {
      const p = new URL(url).searchParams;
      const from = p.get("sign_date__gte")!, to = p.get("sign_date__lte")!;
      calls.push([from, to, p.get("offset")!]);
      if (from !== to) return json({ count: 10001, results: [{ id: -1 }] });
      return json({ count: 1, results: [{ id: from === "2026-01-01" ? 1 : 2 }] });
    });
    const result = await zakupListAll("/public/contracts/", { sign_date__gte: "2026-01-01", sign_date__lte: "2026-01-02", enstru_code__isnull: true }, { ...fast, fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls).toEqual([["2026-01-01", "2026-01-02", "0"], ["2026-01-01", "2026-01-01", "0"], ["2026-01-02", "2026-01-02", "0"]]);
  });

  it("keeps input order and the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });

  it("retries a short page without accepting or duplicating its partial rows", async () => {
    const offsets: number[] = [];
    const fetchFn = vi.fn(async (raw: string) => {
      const offset = Number(new URL(raw).searchParams.get("offset")); offsets.push(offset);
      const size = offsets.length === 1 ? 1 : offset === 0 ? 100 : 30;
      return json({ count: 130, results: Array.from({ length: size }, (_, i) => ({ id: offset + i })) });
    });
    const rows = await zakupListAll("/public/contracts/", {}, { ...fast, fetchFn: fetchFn as unknown as typeof fetch });
    expect(rows).toHaveLength(130);
    expect(offsets).toEqual([0, 0, 100]);
  });

  it("rejects a list that remains incomplete after retrying the same page", async () => {
    const fetchFn = vi.fn().mockImplementation(async () => json({ count: 2, results: [{ id: 1 }] }));
    await expect(zakupListAll("/public/contracts/", {}, { ...fast, fetchFn })).rejects.toThrow(/неполн/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
