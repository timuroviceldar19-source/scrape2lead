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

  it("throws on graphql errors and malformed payloads", () => {
    expect(() => parsePlanStatusResponse({ errors: [{ message: "boom" }] })).toThrow("boom");
    expect(() => parsePlanStatusResponse({ data: null })).toThrow("no data.Plans");
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
