import { describe, expect, it } from "vitest";
import { goszakupGraphqlAll, goszakupGraphqlPage } from "../../src/kz/goszakupGraphql.js";
import { GoszakupAuthError } from "../../src/kz/goszakupClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(responses: Array<Response | Error>): typeof fetch & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

const OPTIONS = { token: "t", retryDelayMs: 0 };

describe("goszakupGraphqlPage", () => {
  it("turns the API's null list into an empty page", async () => {
    const fetchFn = fakeFetch([jsonResponse({ data: { Plans: null }, extensions: { pageInfo: { hasNextPage: false, lastId: 0 } } })]);
    const page = await goszakupGraphqlPage("q", {}, "Plans", { ...OPTIONS, fetchFn });
    expect(page).toEqual({ items: [], hasNextPage: false, lastId: 0 });
  });

  it("retries a 502 and a dropped connection before succeeding", async () => {
    const fetchFn = fakeFetch([
      jsonResponse({}, 502),
      new Error("ECONNRESET"),
      jsonResponse({ data: { Plans: [{ id: 1 }] } })
    ]);
    const page = await goszakupGraphqlPage("q", {}, "Plans", { ...OPTIONS, fetchFn });
    expect(page.items).toEqual([{ id: 1 }]);
    expect(fetchFn.calls).toHaveLength(3);
  });

  it("stops at once on a rejected token", async () => {
    const fetchFn = fakeFetch([jsonResponse({}, 401)]);
    await expect(goszakupGraphqlPage("q", {}, "Plans", { ...OPTIONS, fetchFn })).rejects.toBeInstanceOf(GoszakupAuthError);
  });

  it("surfaces GraphQL errors instead of returning an empty page", async () => {
    const fetchFn = fakeFetch([jsonResponse({ errors: [{ message: "expecting type [Int]" }] })]);
    await expect(goszakupGraphqlPage("q", {}, "Plans", { ...OPTIONS, fetchFn })).rejects.toThrow(/expecting type/);
  });

  it("gives up after the retry budget", async () => {
    const fetchFn = fakeFetch([jsonResponse({}, 503), jsonResponse({}, 503)]);
    await expect(goszakupGraphqlPage("q", {}, "Plans", { ...OPTIONS, maxRetries: 1, fetchFn })).rejects.toThrow(/503/);
  });
});

describe("goszakupGraphqlAll", () => {
  it("refuses to return half a list when the cursor is missing", async () => {
    const fetchFn = fakeFetch([
      jsonResponse({ data: { Contract: [{ id: 1 }] }, extensions: { pageInfo: { hasNextPage: true, lastId: null } } })
    ]);
    await expect(goszakupGraphqlAll("q", {}, "Contract", { ...OPTIONS, fetchFn })).rejects.toThrow(/next page/);
  });

  it("follows pageInfo.lastId through every page", async () => {
    const fetchFn = fakeFetch([
      jsonResponse({ data: { Contract: [{ id: 1 }, { id: 2 }] }, extensions: { pageInfo: { hasNextPage: true, lastId: 2 } } }),
      jsonResponse({ data: { Contract: [{ id: 3 }] }, extensions: { pageInfo: { hasNextPage: false, lastId: 3 } } })
    ]);
    const items = await goszakupGraphqlAll("q", { bin: "1" }, "Contract", { ...OPTIONS, fetchFn });

    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchFn.calls).toEqual([
      { query: "q", variables: { bin: "1", after: 0 } },
      { query: "q", variables: { bin: "1", after: 2 } }
    ]);
  });
});
