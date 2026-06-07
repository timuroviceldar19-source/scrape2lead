import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchGoszakupTenders, isGoszakupAvailable, GoszakupAuthError } from "../../src/kz/goszakupCollector.js";
import { resetStatusRefCache } from "../../src/kz/goszakupStatus.js";
import binResponse from "../fixtures/goszakup-v3-bin-response.json" with { type: "json" };
import page1 from "../fixtures/goszakup-v3-page1.json" with { type: "json" };
import page2 from "../fixtures/goszakup-v3-page2.json" with { type: "json" };
import refs from "../fixtures/goszakup-v3-refs.json" with { type: "json" };

function makeFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const { status, body } = responses[Math.min(callIndex++, responses.length - 1)];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("goszakupCollector", () => {
  beforeEach(() => {
    resetStatusRefCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isGoszakupAvailable returns true when token provided", () => {
    expect(isGoszakupAvailable({ token: "abc" })).toBe(true);
    expect(isGoszakupAvailable({ token: "" })).toBe(false);
    expect(isGoszakupAvailable({})).toBe(false);
  });

  it("returns empty when no token", async () => {
    const result = await fetchGoszakupTenders("061040006408", { token: "" });
    expect(result.tenders).toHaveLength(0);
    expect(result.raw).toBe(0);
    expect(result.pages).toBe(0);
  });

  it("maps v3 response fields correctly", async () => {
    const fetchFn = makeFetch([{ status: 200, body: binResponse }]);
    const result = await fetchGoszakupTenders("061040006408", { token: "test", fetchFn });

    expect(result.raw).toBe(2);
    expect(result.pages).toBe(1);
    expect(result.tenders).toHaveLength(2);

    const first = result.tenders[0];
    expect(first.source).toBe("goszakup.gov.kz");
    expect(first.bin).toBe("061040006408");
    expect(first.tender_number).toBe("415500-1");
    expect(first.tender_name).toBe("Тестовая закупка");
    expect(first.customer_name).toBe('ТОО "ALAU"');
    expect(first.budget_amount).toBe("10000");
    expect(first.url).toContain("415500");
  });

  it("paginates across 2 pages", async () => {
    const fetchFn = makeFetch([
      { status: 200, body: page1 },
      { status: 200, body: page2 }
    ]);
    const result = await fetchGoszakupTenders("061040006408", { token: "test", fetchFn });

    expect(result.pages).toBe(2);
    expect(result.raw).toBe(3);
    expect(result.tenders).toHaveLength(3);
    expect(result.tenders.map((t) => t.tender_number)).toEqual([
      "415500-1",
      "415502-1",
      "415503-1"
    ]);
  });

  it("filters by activeOnly using status ref", async () => {
    const fetchFn = makeFetch([
      { status: 200, body: binResponse },
      { status: 200, body: refs }
    ]);
    const result = await fetchGoszakupTenders("061040006408", {
      token: "test",
      activeOnly: true,
      fetchFn
    });

    expect(result.raw).toBe(2);
    expect(result.filtered).toBe(1);
    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0].tender_number).toBe("415500-1");
    expect(result.tenders[0].status).toBe("Опубликована");
  });

  it("respects maxPages limit", async () => {
    const fetchFn = makeFetch([
      { status: 200, body: page1 },
      { status: 200, body: page2 }
    ]);
    const result = await fetchGoszakupTenders("061040006408", {
      token: "test",
      maxPages: 1,
      fetchFn
    });

    expect(result.pages).toBe(1);
    expect(result.raw).toBe(1);
  });

  it("skips invalid BIN", async () => {
    const result = await fetchGoszakupTenders("123", { token: "test" });
    expect(result.tenders).toHaveLength(0);
    expect(result.raw).toBe(0);
  });

  it("throws GoszakupAuthError on 401", async () => {
    const fetchFn = makeFetch([{ status: 401, body: { error: "unauthorized" } }]);
    await expect(
      fetchGoszakupTenders("061040006408", { token: "bad", fetchFn })
    ).rejects.toThrow(GoszakupAuthError);
  });

  it("retries on 5xx errors", async () => {
    const fetchFn = makeFetch([
      { status: 500, body: { error: "server error" } },
      { status: 200, body: binResponse }
    ]);
    const result = await fetchGoszakupTenders("061040006408", { token: "test", fetchFn, maxRetries: 1 });
    expect(result.tenders).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("skips items with org_bin mismatch", async () => {
    const mismatchResponse = {
      total: 1,
      limit: 50,
      next_page: "",
      items: [
        {
          id: 999999,
          number_anno: "999-1",
          name_ru: "Чужая закупка",
          org_bin: "999999999999",
          total_sum: 1000,
          ref_buy_status_id: 210,
          start_date: "2026-01-01 00:00:00",
          end_date: "2026-12-31 00:00:00"
        }
      ]
    };
    const fetchFn = makeFetch([{ status: 200, body: mismatchResponse }]);
    const result = await fetchGoszakupTenders("061040006408", { token: "test", fetchFn });
    expect(result.tenders).toHaveLength(0);
    expect(result.raw).toBe(1);
  });
});
