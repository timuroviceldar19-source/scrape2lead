import { describe, expect, it, vi } from "vitest";
import {
  PLAN_STATUS_BATCH_SIZE,
  buildPlanStatusQuery,
  chunkPlanNumbers,
  fetchPlanStatusBatch,
  parsePlanStatusResponse
} from "../../src/kz/goszakupPlanStatusApi.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("parsePlanStatusResponse", () => {
  it("maps rootrecordId to status name", () => {
    const parsed = parsePlanStatusResponse({
      data: { Plans: [{ id: 10, rootrecordId: 111, RefPlnPointStatus: { nameRu: "Опубликован" } }] }
    });
    expect(parsed.statuses.get("111")).toBe("Опубликован");
  });

  it("takes the newest version (highest id) after a plan edit", () => {
    const parsed = parsePlanStatusResponse({
      data: {
        Plans: [
          { id: 20, rootrecordId: 111, RefPlnPointStatus: { nameRu: "Проект договора" } },
          { id: 10, rootrecordId: 111, RefPlnPointStatus: { nameRu: "Утвержден" } }
        ]
      }
    });
    expect(parsed.statuses.get("111")).toBe("Проект договора");
  });

  it("omits rows without a status and leaves absent plans out of the map", () => {
    const parsed = parsePlanStatusResponse({
      data: { Plans: [{ id: 1, rootrecordId: 5, RefPlnPointStatus: null }] }
    });
    expect(parsed.statuses.has("5")).toBe(false);
    expect(parsed.rowCount).toBe(1);
  });

  it("returns empty map when Plans is null (no plan points matched in api)", () => {
    const parsed = parsePlanStatusResponse({
      data: { Plans: null },
      extensions: { pageInfo: { totalCount: 0 } }
    });
    expect(parsed.statuses.size).toBe(0);
    expect(parsed.rowCount).toBe(0);
  });

  it("throws on graphql errors", () => {
    expect(() => parsePlanStatusResponse({ errors: [{ message: "boom" }] })).toThrow("boom");
  });

  it("throws when response has no data or data is null", () => {
    expect(() => parsePlanStatusResponse({})).toThrow("no data");
    expect(() => parsePlanStatusResponse({ data: null })).toThrow("no data");
    expect(() => parsePlanStatusResponse(null)).toThrow("no data");
  });

  it("throws when data.Plans is not an array", () => {
    expect(() => parsePlanStatusResponse({ data: { Plans: "invalid" } })).toThrow("no data.Plans array");
  });
});

describe("batching", () => {
  it("splits plan numbers into batches of 50", () => {
    const numbers = Array.from({ length: 120 }, (_, index) => String(index + 1));
    const chunks = chunkPlanNumbers(numbers);
    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 20]);
    expect(PLAN_STATUS_BATCH_SIZE).toBe(50);
  });

  it("builds the query with rootrecordId filter and limit 200", () => {
    expect(buildPlanStatusQuery(["1", "2"])).toBe(
      "{ Plans(filter:{rootrecordId:[1,2]}, limit:200){ id rootrecordId RefPlnPointStatus{ nameRu } } }"
    );
  });

  it("rejects non-numeric plan numbers (no query injection)", () => {
    expect(() => buildPlanStatusQuery(["1]}) { x"])).toThrow("digits only");
  });

  it("rejects more than 50 numbers in one request", async () => {
    const numbers = Array.from({ length: 51 }, (_, index) => String(index + 1));
    await expect(fetchPlanStatusBatch(numbers, { token: "t", fetchFn: vi.fn() })).rejects.toThrow("at most 50");
  });
});

describe("fetchPlanStatusBatch", () => {
  it("сохраняет успешные статусы пачки при недоступности одного пункта", async () => {
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get("q") === "101") return new Response("bad", { status: 404 });
      return jsonResponse(u.pathname.endsWith("/plan-items/") ? { count: 1, results: [{ id: 500, external_id: 200 }] }
        : { id: 500, external_id: 200, organization: { iin_bin: "990000000001" }, year: { year: 2026 }, status: { name: "Утвержден", egz_code: "2" } });
    }) as typeof fetch;
    const result = await fetchPlanStatusBatch(["100", "101"], { fetchFn, pauseMs: 0, maxRetries: 0, contexts: new Map([[100, { bin: "990000000001", year: 2026 }], [101, { bin: "990000000001", year: 2026 }]]) });
    expect(result.get("100")).toBe("Утвержден");
    expect(result.failed?.get("101")).toContain("404");
  });
  it("читает zakup без токена, проверяя БИН и год сделки", async () => {
    const fetchFn = (async (url: string) => {
      expect(new URL(url).hostname).toBe("zakup.gov.kz");
      return jsonResponse(new URL(url).pathname.endsWith("/plan-items/")
        ? { count: 1, results: [{ id: 500, external_id: 200 }] }
        : { id: 500, external_id: 200, organization: { iin_bin: "990000000001" }, year: { year: 2026 }, status: { name: "Проект договора", egz_code: "310" } });
    }) as typeof fetch;
    const result = await fetchPlanStatusBatch(["100"], { fetchFn, pauseMs: 0, contexts: new Map([[100, { bin: "990000000001", year: 2026 }]]) });
    expect(result.get("100")).toBe("Проект договора");
  });
  it("posts to v3 graphql with the bearer token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ data: { Plans: [{ id: 1, rootrecordId: 7, RefPlnPointStatus: { nameRu: "Заявка" } }] } })
    );
    const result = await fetchPlanStatusBatch(["7", "8"], { token: "secret", fetchFn });

    expect(result.get("7")).toBe("Заявка");
    expect(result.has("8")).toBe(false);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://ows.goszakup.gov.kz/v3/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("returns empty map when goszakup responds with Plans: null", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { Plans: null },
        extensions: { pageInfo: { totalCount: 0 } }
      })
    );
    const result = await fetchPlanStatusBatch(["99999999"], { token: "secret", fetchFn });
    expect(result.size).toBe(0);
  });

  it("retries on 503 and then succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: { Plans: [] } }));
    const result = await fetchPlanStatusBatch(["7"], { token: "t", fetchFn, sleepFn: async () => undefined });
    expect(result.size).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("splits the batch when the 200-row limit is saturated", async () => {
    const saturated = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1, rootrecordId: 1, RefPlnPointStatus: { nameRu: "Утвержден" }
    }));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { Plans: saturated } }))
      .mockResolvedValueOnce(jsonResponse({ data: { Plans: [{ id: 5, rootrecordId: 1, RefPlnPointStatus: { nameRu: "Опубликован" } }] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { Plans: [{ id: 6, rootrecordId: 2, RefPlnPointStatus: { nameRu: "Заявка" } }] } }));
    const result = await fetchPlanStatusBatch(["1", "2"], { token: "t", fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result.get("1")).toBe("Опубликован");
    expect(result.get("2")).toBe("Заявка");
  });
});
