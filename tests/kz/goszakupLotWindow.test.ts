import { describe, expect, it } from "vitest";
import { fetchLotBidWindow, fetchLotBidWindows } from "../../src/kz/goszakupLotWindow.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Отвечает по номеру лота из запроса: объект — данные лота, Error — сбой сети, null — лота нет. */
function fakeRegistry(lots: Record<string, { startDate: string | null; endDate: string | null } | Error | null>): typeof fetch & { calls: Array<{ variables: { lot: string } }> } {
  const calls: Array<{ variables: { lot: string } }> = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { variables: { lot: string } };
    calls.push(body);
    const lot = lots[body.variables.lot];
    if (lot instanceof Error) throw lot;
    if (!lot) return jsonResponse({ data: { Lots: null } });
    return jsonResponse({ data: { Lots: [{ lotNumber: body.variables.lot, TrdBuy: lot }] } });
  }) as typeof fetch & { calls: Array<{ variables: { lot: string } }> };
  fn.calls = calls;
  return fn;
}

const OPTIONS = { token: "t", retryDelayMs: 0, maxRetries: 0 };
const WINDOW = { startDate: "2026-10-13 10:00:00", endDate: "2026-10-15 15:35:00" };

describe("fetchLotBidWindow", () => {
  it("asks the registry for the lot by its number and returns the bid period", async () => {
    const fetchFn = fakeRegistry({ "83132229-ЗЦП1": WINDOW });
    await expect(fetchLotBidWindow("83132229-ЗЦП1", { ...OPTIONS, fetchFn })).resolves.toEqual(WINDOW);
    expect(fetchFn.calls[0].variables).toEqual({ lot: "83132229-ЗЦП1" });
  });

  it("returns null for an unknown lot and for a lot without dates", async () => {
    const fetchFn = fakeRegistry({ "1-ЗЦП1": null, "2-ЗЦП1": { startDate: null, endDate: null } });
    await expect(fetchLotBidWindow("1-ЗЦП1", { ...OPTIONS, fetchFn })).resolves.toBeNull();
    await expect(fetchLotBidWindow("2-ЗЦП1", { ...OPTIONS, fetchFn })).resolves.toBeNull();
  });
});

describe("fetchLotBidWindows", () => {
  it("keeps going when one lot cannot be read and reports it", async () => {
    const fetchFn = fakeRegistry({ "1-ЗЦП1": WINDOW, "2-ЗЦП1": new Error("ECONNRESET"), "3-ЗЦП1": null });
    const result = await fetchLotBidWindows(["1-ЗЦП1", "2-ЗЦП1", "3-ЗЦП1"], { ...OPTIONS, fetchFn });
    expect([...result.windows.entries()]).toEqual([["1-ЗЦП1", WINDOW]]);
    expect(result.failed).toEqual(["2-ЗЦП1"]);
  });
});
