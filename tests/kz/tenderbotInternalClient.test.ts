import { describe, expect, it, vi } from "vitest";
import {
  TENDERBOT_MAX_PER_PAGE,
  TenderbotInternalClient,
  buildTenderbotSearchBody,
  type TenderbotSearchFilters
} from "../../src/kz/tenderbotInternalClient.js";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const page = (data: Array<{ id: number; source_id?: string }>, meta: Record<string, unknown> = {}) =>
  json({
    success: true,
    aData: {
      lots: {
        current_page: 1,
        per_page: data.length,
        last_page: 1,
        total: data.length,
        data,
        ...meta
      }
    }
  });

function makeClient(fetcher: typeof fetch): TenderbotInternalClient {
  return new TenderbotInternalClient({ login: "sales1@example.kz", password: "secret", fetchFn: fetcher, delayMs: 0, maxRetries: 2 });
}

describe("buildTenderbotSearchBody", () => {
  it("maps filters to the site payload", () => {
    const filters: TenderbotSearchFilters = {
      searchstr: "ноутбук,монитор",
      excluded: ["ремонт"],
      regionIds: [7522887],
      subject: ["1"],
      amountFrom: 500_000,
      amountTo: 2_000_000,
      closeDateFrom: "2026-11-25",
      closeDateTo: "2026-12-10",
      markInvalid: true
    };
    const body = buildTenderbotSearchBody(filters, 2, TENDERBOT_MAX_PER_PAGE);
    expect(body).toMatchObject({
      searchstr: "ноутбук,монитор",
      excluded: ["ремонт"],
      kato_id: [7522887],
      subject: ["1"],
      summ: ["500000", "2000000"],
      close_date: ["2026-11-25", "2026-12-10"],
      markInvalid: 1,
      page: 2,
      per_page: 400
    });
    expect(body.open_date).toEqual([]);
  });

  it("caps per_page because the site silently falls back to 26 above 400", () => {
    expect(buildTenderbotSearchBody({}, 1, 5000).per_page).toBe(400);
  });
});

describe("TenderbotInternalClient", () => {
  it("logs in and sends the bearer token with the search request", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/login")) return json({ success: true, accessToken: "jwt-token" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt-token");
      return page([{ id: 1, source_id: "88811722-ЗЦП2" }]);
    }) as unknown as typeof fetch;

    const result = await makeClient(fetcher).searchPage({ searchstr: "ноутбук" }, 1, 400);
    expect(result.lots[0]?.sourceId).toBe("88811722-ЗЦП2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("walks all pages and de-duplicates ids", async () => {
    const requestedPages: number[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/login")) return json({ success: true, accessToken: "jwt-token" });
      const body = JSON.parse(String(init?.body)) as { page: number };
      requestedPages.push(body.page);
      if (body.page === 1) {
        return json({ success: true, aData: { lots: { current_page: 1, per_page: 2, last_page: 2, total: 3, data: [{ id: 1 }, { id: 2 }] } } });
      }
      return json({ success: true, aData: { lots: { current_page: 2, per_page: 2, last_page: 2, total: 3, data: [{ id: 2 }, { id: 3 }] } } });
    }) as unknown as typeof fetch;

    const result = await makeClient(fetcher).searchAll({ searchstr: "ноутбук" }, { perPage: 2 });
    expect(result.lots.map((lot) => lot.id)).toEqual([1, 2, 3]);
    expect(result.pages).toBe(2);
    expect(result.total).toBe(3);
    expect(requestedPages).toEqual([1, 2]);
  });

  it("retries a short 403 ban", async () => {
    let searchCalls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/login")) return json({ success: true, accessToken: "jwt-token" });
      searchCalls++;
      if (searchCalls === 1) return json({ message: "You got banned permanently from this server." }, 403);
      return page([{ id: 7 }]);
    }) as unknown as typeof fetch;

    const result = await makeClient(fetcher).searchPage({}, 1, 400);
    expect(result.lots[0]?.id).toBe(7);
    expect(searchCalls).toBe(2);
  });

  it("перелогинивается, если токен отдаёт скрытые поля", async () => {
    let logins = 0;
    const auth = new Map<number, string>();
    let searches = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/login")) {
        logins++;
        return json({ success: true, accessToken: `jwt-${logins}` });
      }
      searches++;
      auth.set(searches, new Headers(init?.headers).get("authorization") ?? "");
      if (searches === 1) {
        return json({ success: true, aData: { lots: { total: 1, per_page: 400, current_page: 1, last_page: 1, data: [{ id: 1, name_ru: "", source_id: "hidden", tender: { gzid: "hidden" } }] } } });
      }
      return json({ success: true, aData: { lots: { total: 1, per_page: 400, current_page: 1, last_page: 1, data: [{ id: 1, name_ru: "Ноутбук", source_id: "88811722-ЗЦП2", tender: { gzid: "G18020190-1" } }] } } });
    }) as unknown as typeof fetch;

    const result = await makeClient(fetcher).searchPage({ searchstr: "ноутбук" }, 1, 400);
    expect(result.lots[0]).toMatchObject({ name: "Ноутбук", sourceId: "88811722-ЗЦП2", gzid: "G18020190-1" });
    expect(logins).toBe(2);
    expect(auth.get(2)).toBe("Bearer jwt-2");
  });

  it("fails with a clear error on bad credentials", async () => {
    const fetcher = vi.fn(async () => json({ success: false, error: "Неверный пароль" }, 200)) as unknown as typeof fetch;
    await expect(makeClient(fetcher).login()).rejects.toThrow(/TENDERBOT_LOGIN/);
  });
});
