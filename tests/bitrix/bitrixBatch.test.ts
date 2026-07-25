import { describe, expect, it, vi } from "vitest";
import {
  BITRIX_BATCH_LIMIT,
  callBitrixBatch,
  chunkBatchCommands,
  serializeBatchCommand,
  serializeBatchParams,
  type BitrixBatchCommand
} from "../../src/bitrix/batch.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("serializeBatchParams", () => {
  it("serializes nested filter and select with PHP-style keys", () => {
    const query = serializeBatchParams({
      filter: { ORIGINATOR_ID: "scrape2lead-gz-plans", ORIGIN_ID: "gz:1" },
      select: ["ID", "TITLE"]
    });
    expect(query).toBe(
      "filter%5BORIGINATOR_ID%5D=scrape2lead-gz-plans"
      + "&filter%5BORIGIN_ID%5D=gz%3A1"
      + "&select%5B0%5D=ID&select%5B1%5D=TITLE"
    );
  });

  it("skips null and undefined values", () => {
    expect(serializeBatchParams({ filter: { A: null, B: undefined, C: "x" } }))
      .toBe("filter%5BC%5D=x");
  });

  it("builds a method?query command string", () => {
    const command: BitrixBatchCommand = {
      key: "find_0",
      method: "crm.deal.list",
      params: { filter: { ID: 5 } }
    };
    expect(serializeBatchCommand(command)).toBe("crm.deal.list?filter%5BID%5D=5");
  });
});

describe("chunkBatchCommands", () => {
  it("splits into chunks of at most the batch limit", () => {
    const commands = Array.from({ length: 101 }, (_v, i) => i);
    const chunks = chunkBatchCommands(commands);
    expect(chunks.map((chunk) => chunk.length)).toEqual([BITRIX_BATCH_LIMIT, BITRIX_BATCH_LIMIT, 1]);
  });

  it("rejects a chunk size below 1", () => {
    expect(() => chunkBatchCommands([1, 2], 0)).toThrow();
  });
});

describe("callBitrixBatch", () => {
  const commands: BitrixBatchCommand[] = [
    { key: "a", method: "crm.deal.list", params: { filter: { ID: 1 } } },
    { key: "b", method: "crm.deal.list", params: { filter: { ID: 2 } } }
  ];

  it("maps results back by command key", async () => {
    let calledUrl: string | undefined;
    let calledBody: unknown;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledBody = JSON.parse((init?.body as string) ?? "{}");
      return jsonResponse({ result: { result: { a: [{ ID: "10" }], b: [] }, result_error: [] } });
    }) as unknown as typeof fetch;

    const results = await callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", commands, { fetchImpl });

    expect(results.get("a")?.result).toEqual([{ ID: "10" }]);
    expect(results.get("b")?.result).toEqual([]);
    expect(calledUrl).toBe("https://ft.bitrix24.kz/rest/1/tok/batch.json");
    expect(calledBody).toMatchObject({ halt: 0 });
  });

  it("flags a key missing from both result and result_error as a synthetic error, not an empty list", async () => {
    // Truncated/partial batch response: command "b" produced neither a result
    // nor an error. It must not be read as an empty deal list (which would let
    // a duplicate slip through as a create), but surfaced for sequential retry.
    const fetchImpl = vi.fn(async () => jsonResponse({
      result: { result: { a: [{ ID: "10" }] }, result_error: [] }
    }));

    const results = await callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", commands, { fetchImpl });

    expect(results.get("a")?.result).toEqual([{ ID: "10" }]);
    expect(results.get("b")?.result).toBeUndefined();
    expect(results.get("b")?.error?.error).toBe("MISSING_BATCH_RESULT");
  });

  it("distinguishes a present empty result from a missing key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      result: { result: { a: [], b: [{ ID: "20" }] }, result_error: [] }
    }));

    const results = await callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", commands, { fetchImpl });

    // Present empty array is a legitimate "no deals" answer, not an error.
    expect(results.get("a")?.error).toBeUndefined();
    expect(results.get("a")?.result).toEqual([]);
    expect(results.get("b")?.result).toEqual([{ ID: "20" }]);
  });

  it("surfaces per-command errors instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      result: { result: { a: [{ ID: "10" }] }, result_error: { b: { error: "BAD_REQUEST", error_description: "nope" } } }
    }));

    const results = await callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", commands, { fetchImpl });

    expect(results.get("a")?.result).toEqual([{ ID: "10" }]);
    expect(results.get("b")?.error?.error).toBe("BAD_REQUEST");
  });

  it("retries retriable per-command errors then resolves", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        result: { result: { a: [{ ID: "10" }] }, result_error: { b: { error: "QUERY_LIMIT_EXCEEDED" } } }
      }))
      .mockResolvedValueOnce(jsonResponse({
        result: { result: { b: [{ ID: "20" }] }, result_error: [] }
      }));
    const sleepImpl = vi.fn(async () => {});

    const results = await callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", commands, {
      fetchImpl, sleepImpl, backoffMs: 1
    });

    expect(results.get("a")?.result).toEqual([{ ID: "10" }]);
    expect(results.get("b")?.result).toEqual([{ ID: "20" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalled();
  });

  it("retries a top-level HTTP failure with backoff", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ result: { result: { a: [], b: [] }, result_error: [] } }));
    const sleepImpl = vi.fn(async () => {});

    const results = await callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", commands, {
      fetchImpl, sleepImpl, backoffMs: 1
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(results.size).toBe(2);
  });

  it("throws on a top-level error payload after exhausting retries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "INTERNAL_SERVER_ERROR", error_description: "down" }));
    const sleepImpl = vi.fn(async () => {});

    await expect(callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", commands, {
      fetchImpl, sleepImpl, retries: 1, backoffMs: 1
    })).rejects.toThrow(/INTERNAL_SERVER_ERROR/);
  });

  it("rejects duplicate command keys", async () => {
    const dupes: BitrixBatchCommand[] = [
      { key: "a", method: "crm.deal.list" },
      { key: "a", method: "crm.deal.list" }
    ];
    await expect(callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", dupes)).rejects.toThrow(/unique/);
  });

  it("rejects more than the batch limit of commands", async () => {
    const many = Array.from({ length: BITRIX_BATCH_LIMIT + 1 }, (_v, i): BitrixBatchCommand => ({
      key: `k${i}`, method: "crm.deal.list"
    }));
    await expect(callBitrixBatch("https://ft.bitrix24.kz/rest/1/tok/", many)).rejects.toThrow(/at most/);
  });
});
