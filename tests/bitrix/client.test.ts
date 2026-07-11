import { describe, expect, it, vi } from "vitest";
import { BitrixApiError, BitrixClient } from "../../src/bitrix/client.js";

function jsonResponse(status: number, payload: unknown): Response {
  return {
    status,
    json: async () => payload
  } as unknown as Response;
}

function makeClient(fetchImpl: typeof fetch): BitrixClient {
  return new BitrixClient("https://example.bitrix24.kz/rest/1/token/", {
    fetchImpl,
    requestDelayMs: 0,
    retryBaseDelayMs: 0,
    maxRetries: 2
  });
}

describe("BitrixClient", () => {
  it("posts to <webhook>/<method>.json and returns result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: [{ ID: "1" }] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.call("crm.lead.list", { filter: { ID: 1 } });

    expect(result).toEqual([{ ID: "1" }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.bitrix24.kz/rest/1/token/crm.lead.list.json",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("retries on 429 rate limiting and then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "QUERY_LIMIT_EXCEEDED", error_description: "rate limit" }))
      .mockResolvedValueOnce(jsonResponse(200, { result: "77" }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.call("crm.deal.add", { fields: {} })).resolves.toBe("77");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws BitrixApiError immediately on non-retriable errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, {
      error: "ERROR_METHOD_NOT_FOUND",
      error_description: "Method not found!"
    }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const error = await client.call("crm.nope.add").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BitrixApiError);
    expect((error as BitrixApiError).code).toBe("ERROR_METHOD_NOT_FOUND");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and surfaces the last error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error_description: "server down" }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.call("crm.lead.list")).rejects.toThrow(/server down/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("finds entities by originator and origin id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: [{ ID: 5, ORIGIN_ID: "order:1" }] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const found = await client.findByOrigin("lead", "xlsx-import", "order:1");
    expect(found).toEqual({ ID: 5, ORIGIN_ID: "order:1" });

    const [, request] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(request.body)).toEqual({
      filter: { ORIGINATOR_ID: "xlsx-import", ORIGIN_ID: "order:1" },
      select: ["ID", "TITLE", "ORIGINATOR_ID", "ORIGIN_ID", "ASSIGNED_BY_ID"]
    });
  });

  it("pages through crm.*.list results 50 rows at a time", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => ({ ID: String(i + 1) }));
    const secondPage = [{ ID: "51" }, { ID: "52" }];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { result: firstPage }))
      .mockResolvedValueOnce(jsonResponse(200, { result: secondPage }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const rows = await client.listAll("deal", { CATEGORY_ID: 0 });

    expect(rows).toHaveLength(52);
    const starts = fetchImpl.mock.calls.map((call) => {
      const [, request] = call as unknown as [string, { body: string }];
      return (JSON.parse(request.body) as { start: number }).start;
    });
    expect(starts).toEqual([0, 50]);
  });

  it("aborts listAll when maxPages is exceeded instead of looping forever", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({ ID: String(i) }));
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: fullPage }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.listAll("deal", {}, ["ID"], 2)).rejects.toThrow(/exceeds 100 rows/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects webhook urls that are not http(s)", () => {
    expect(() => new BitrixClient("file:///etc/passwd")).toThrow(/http/);
  });

  it("honors a per-call maxRetries override instead of the client default", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error_description: "server down" }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.call("crm.timeline.comment.add", {}, { maxRetries: 0 })).rejects.toThrow(/server down/);
    // The client default is maxRetries: 2 (3 attempts); the override caps this call at 1.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
