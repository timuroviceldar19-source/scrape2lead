import { describe, expect, it, vi } from "vitest";
import { fetchMarketContracts } from "../../src/kz/market/fetchMarket.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";

function contract(id: number) {
  return {
    id,
    signDate: "2026-02-05T10:00:00",
    contractSum: 500000,
    faktTradeMethodsId: 60,
    refContractStatusId: 190,
    supplierBiin: "111111111111",
    customerBin: "222222222222",
    Supplier: { nameRu: "ТОО Поставщик" },
    Customer: { nameRu: "Школа 1" },
    ContractUnits: [{ refEnstruCode: "262030.100.000021", quantity: 1, itemPrice: 500000, totalSum: 500000 }]
  };
}

function page(ids: number[], hasNextPage: boolean, totalCount: number): Response {
  const body = {
    data: { Contract: ids.length ? ids.map(contract) : null },
    extensions: { pageInfo: { hasNextPage, lastId: ids.length ? Math.min(...ids) : null, totalCount } }
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

function fakeFetch(responses: Response[]): typeof fetch & { afters: unknown[] } {
  const afters: unknown[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    afters.push(JSON.parse(String(init?.body ?? "{}")).variables?.after);
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  }) as typeof fetch & { afters: unknown[] };
  fn.afters = afters;
  return fn;
}

const BASE = { token: "t", fromDate: "2026-02-01", toDate: "2026-02-28", cfg: loadMarketConfig(), retryDelayMs: 0 };

describe("fetchMarketContracts (ows)", () => {
  it("asks the same page again when ows ends the list before its own total", async () => {
    // 01.11.2026: February came back as 13-28 Feb only; a later pass over the same filter gave all 239 395 contracts.
    const fetchFn = fakeFetch([page([30, 20], true, 3), page([], false, 3), page([10], false, 3)]);

    const units = await fetchMarketContracts({ ...BASE, fetchFn });

    expect(units.map((u) => u.id).sort()).toEqual([10, 20, 30]);
    expect(fetchFn.afters).toEqual([undefined, 20, 20]);
  });

  it("does not count a cut page twice when it is asked again", async () => {
    const fetchFn = fakeFetch([page([40, 30], true, 4), page([20], false, 4), page([20, 10], false, 4)]);

    const units = await fetchMarketContracts({ ...BASE, fetchFn });

    expect(units.map((u) => u.id).sort()).toEqual([10, 20, 30, 40]);
  });

  it("fails instead of returning a short month when ows keeps ending early", async () => {
    const fetchFn = fakeFetch([page([30, 20], true, 3), page([], false, 3), page([], false, 3), page([], false, 3)]);

    await expect(fetchMarketContracts({ ...BASE, fetchFn, maxRetries: 2 })).rejects.toThrow(/2 из 3/);
  });

  it("fails when ows says there is a next page but gives no cursor", async () => {
    const noCursor = new Response(
      JSON.stringify({ data: { Contract: [contract(30)] }, extensions: { pageInfo: { hasNextPage: true, lastId: null, totalCount: 3 } } }),
      { status: 200 }
    );

    await expect(fetchMarketContracts({ ...BASE, fetchFn: fakeFetch([noCursor]) })).rejects.toThrow(/курсор/);
  });

  it("accepts a list that ends at the total without extra requests", async () => {
    const fetchFn = fakeFetch([page([30, 20], true, 3), page([10], false, 3)]);

    const units = await fetchMarketContracts({ ...BASE, fetchFn });

    expect(units).toHaveLength(3);
    expect(fetchFn.afters).toEqual([undefined, 20]);
  });

  it("skips LCD units without text and logs one warning line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const customContract = {
      id: 99,
      signDate: "2026-02-10T10:00:00",
      contractSum: 2_000_000,
      faktTradeMethodsId: 60,
      refContractStatusId: 190,
      supplierBiin: "111111111111",
      customerBin: "222222222222",
      Supplier: { nameRu: "ТОО Тест" },
      Customer: { nameRu: "Школа 1" },
      ContractUnits: [
        // LCD without text -> skipped
        { refEnstruCode: "279020.100.000001", quantity: 1, itemPrice: 700_000, totalSum: 700_000, Plans: null },
        // LCD with interactive text -> kept
        {
          refEnstruCode: "279020.100.000002",
          quantity: 1,
          itemPrice: 800_000,
          totalSum: 800_000,
          Plans: { nameRu: "Панель", extraDescRu: "Интерактивная панель 75" }
        }
      ]
    };
    const body = {
      data: { Contract: [customContract] },
      extensions: { pageInfo: { hasNextPage: false, lastId: 99, totalCount: 1 } }
    };
    const fetchFn = fakeFetch([new Response(JSON.stringify(body), { status: 200 })]);

    const units = await fetchMarketContracts({ ...BASE, fetchFn });
    expect(units).toHaveLength(1);
    expect(units[0].code).toBe("279020.100.000002");
    expect(units[0].kind).toBe("Интерактивные панели");
    expect(logSpy).toHaveBeenCalledWith("[Рынок] ows: 1 позиций ЖК без описания пропущено");
    logSpy.mockRestore();
  });
});
