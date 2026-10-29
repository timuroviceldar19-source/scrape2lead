import { describe, expect, it } from "vitest";
import { fetchLotBidWindow, fetchLotBidWindows } from "../../src/kz/goszakupLotWindow.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Отвечает по номеру лота из запроса: объект — данные лота, Error — сбой сети, null — лота нет. */
function fakeRegistry(lots: Record<string, { startDate: string | null; endDate: string | null } | Error | null>): typeof fetch & { calls: Array<{ variables: { lot: string } }> } {
  const calls: Array<{ variables: { lot: string } }> = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    if (new URL(_url).hostname === "zakup.gov.kz") throw new Error("zakup недоступен");
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

const OPTIONS = { token: "t", retryDelayMs: 0, maxRetries: 0, pauseMs: 0 };
const WINDOW = { startDate: "2026-10-13 10:00:00", endDate: "2026-10-15 15:35:00" };

describe("fetchLotBidWindow", () => {
  it("восстанавливает отсутствующий в поиске лот через объявление, проверяя оба внешних номера", async () => {
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/lots/") && u.pathname.includes("/announcements/")) return jsonResponse([{ lot_number: "100-ЗЦП1", system: { id: 1 } }]);
      if (u.pathname.endsWith("/announcements/")) return jsonResponse({ count: 2, results: [
        { id: 50, external_id: 1000, system_id: 4, offer_start_date: "2026-10-15T05:40:57Z", offer_end_date: "2026-10-19T05:40:57Z" },
        { id: 51, external_id: 999, offer_start_date: "2026-12-01T00:00:00Z" }
      ] });
      return jsonResponse({ count: 0, results: [] });
    }) as typeof fetch;
    await expect(fetchLotBidWindow("100-ЗЦП1", { fetchFn, pauseMs: 0, announcementId: 1000 })).resolves.toEqual({ startDate: "2026-10-15 10:40:57", endDate: "2026-10-19 10:40:57" });
  });
  it("резерв ows также не выбирает произвольное объявление при разных сроках", async () => {
    const fetchFn = (async (url: string) => new URL(url).hostname === "zakup.gov.kz" ? new Response("down", { status: 503 }) : jsonResponse({ data: { Lots: [
      { TrdBuy: { id: 1000, startDate: "2026-10-15 08:00:00", endDate: null } },
      { TrdBuy: { id: 2000, startDate: "2026-10-16 15:10:00", endDate: null } }
    ] } })) as typeof fetch;
    await expect(fetchLotBidWindow("100-ЗЦП1", { ...OPTIONS, fetchFn })).rejects.toThrow(/несколько объявлений/);
    await expect(fetchLotBidWindow("100-ЗЦП1", { ...OPTIONS, fetchFn, announcementId: 2000 })).resolves.toEqual({ startDate: "2026-10-16 15:10:00", endDate: null });
  });
  it("при повторе номера выбирает объявление сделки; без него неоднозначность — ошибка", async () => {
    const fetchFn = (async () => jsonResponse({ count: 2, results: [
      { id: 99, external_id: 200, announcement_external_id: 2000, lot_number: "100-ЗЦП1", offer_start_date: "2026-10-16T10:10:00Z" },
      { id: 90, external_id: 100, announcement_external_id: 1000, lot_number: "100-ЗЦП1", offer_start_date: "2026-10-15T03:00:00Z" }
    ] })) as typeof fetch;
    await expect(fetchLotBidWindow("100-ЗЦП1", { fetchFn, pauseMs: 0, announcementId: 1000 })).resolves.toEqual({ startDate: "2026-10-15 08:00:00", endDate: null });
    await expect(fetchLotBidWindow("100-ЗЦП1", { fetchFn, pauseMs: 0 })).rejects.toThrow(/несколько объявлений/);
  });
  it("читает zakup без токена и переводит UTC в Алматы, включая переход даты и года", async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      expect(u.hostname).toBe("zakup.gov.kz");
      expect(u.searchParams.get("lot_number")).toBe("100-ЗЦП1");
      expect(init?.headers).not.toHaveProperty("Authorization");
      return jsonResponse({ count: 1, results: [{ id: 1, lot_number: "100-ЗЦП1", offer_start_date: "2026-12-31T21:30:00+00:00", offer_end_date: "2027-01-05T03:00:00+00:00" }] });
    }) as typeof fetch;
    await expect(fetchLotBidWindow("100-ЗЦП1", { fetchFn, pauseMs: 0 })).resolves.toEqual({ startDate: "2027-01-01 02:30:00", endDate: "2027-01-05 08:00:00" });
  });

  it("не вызывает ows для пустого ответа и не принимает частичное совпадение номера", async () => {
    const fetchFn = (async (url: string) => {
      expect(new URL(url).hostname).toBe("zakup.gov.kz");
      return jsonResponse({ count: 1, results: [{ lot_number: "100-ЗЦП10", offer_start_date: "2026-10-30T03:00:00Z" }] });
    }) as typeof fetch;
    await expect(fetchLotBidWindow("100-ЗЦП1", { fetchFn, token: "t", pauseMs: 0 })).resolves.toBeNull();
  });

  it("отмечает ошибку даты без часового пояса, сохраняя обе ошибки источников", async () => {
    const fetchFn = (async (url: string) => new URL(url).hostname === "zakup.gov.kz"
      ? jsonResponse({ count: 1, results: [{ lot_number: "100-ЗЦП1", offer_start_date: "2026-10-30 03:00:00" }] })
      : new Response("Access denied", { status: 403 })) as typeof fetch;
    await expect(fetchLotBidWindow("100-ЗЦП1", { ...OPTIONS, fetchFn })).rejects.toThrow(/дата.*403/s);
  });
  it("asks the registry for the lot by its number and returns the bid period", async () => {
    const fetchFn = fakeRegistry({ "83132229-ЗЦП1": WINDOW });
    await expect(fetchLotBidWindow("83132229-ЗЦП1", { ...OPTIONS, fetchFn })).resolves.toEqual(WINDOW);
    expect(fetchFn.calls[0].variables).toEqual({ lot: "83132229-ЗЦП1", after: 0 });
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
