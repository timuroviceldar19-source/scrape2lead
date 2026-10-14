import { describe, expect, it } from "vitest";
import { GoszakupApi, summarizePrices } from "../../src/assistant/goszakupApi.js";

/** Ответ API подбирается по тексту запроса: у планового пункта и лотов разные данные. */
function api(routes: Record<string, { data: unknown | ((variables: Record<string, unknown>) => unknown); totalCount?: number }>) {
  const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const key = Object.keys(routes).find((name) => body.query.includes(`${name}(`));
    if (!key) throw new Error(`unexpected query: ${body.query.slice(0, 40)}`);
    const route = routes[key];
    return new Response(
      JSON.stringify({ data: { [key]: typeof route.data === "function" ? (route.data as (variables: Record<string, unknown>) => unknown)(body.variables) : route.data }, extensions: { pageInfo: { hasNextPage: false, lastId: 1, totalCount: route.totalCount } } }),
      { status: 200 }
    );
  }) as typeof fetch;
  return { goszakup: new GoszakupApi({ token: "t", fetchFn, retryDelayMs: 0 }), bodies };
}

describe("GoszakupApi.contractContacts", () => {
  it("collects the customer's representative and phones from the latest contracts", async () => {
    const { goszakup, bodies } = api({
      Contract: {
        totalCount: 664,
        data: [
          { customerFio: "Туғанбайұлы Нұрхан", customerPhone: "8(7172)735537 вн. 1312", signDate: "2026-10-08 14:58:42" },
          { customerFio: "ТУҒАНБАЙҰЛЫ НҰРХАН", customerPhone: "8 (7172) 735-537 вн. 1311", signDate: "2026-10-06 14:15:49" },
          { customerFio: "ТУҒАНБАЙҰЛЫ НҰРХАН", customerPhone: "8(7172)735537 вн. 1312", signDate: "2026-09-01 10:00:00" },
          { customerFio: "Иванов Иван", customerPhone: "", signDate: "2026-08-01 10:00:00" },
          { customerFio: "", customerPhone: "", signDate: "2026-07-01 10:00:00" }
        ]
      }
    });

    const result = await goszakup.contractContacts("071140005693", 50);

    expect(result.totalContracts).toBe(664);
    expect(result.contacts).toEqual([
      { fullName: "Туғанбайұлы Нұрхан", phones: ["8(7172)735537 вн. 1312", "8 (7172) 735-537 вн. 1311"], contracts: 3, lastSignDate: "2026-10-08" },
      { fullName: "Иванов Иван", phones: [], contracts: 1, lastSignDate: "2026-08-01" }
    ]);
    expect(bodies[0].variables).toMatchObject({ bin: "071140005693", limit: 50 });
  });

  it("returns an empty list when the customer has no contracts", async () => {
    const { goszakup } = api({ Contract: { data: null, totalCount: 0 } });

    expect(await goszakup.contractContacts("000000000000", 10)).toEqual({ totalContracts: 0, contacts: [] });
  });
});

describe("GoszakupApi.contractPrices", () => {
  const contract = (over: Record<string, unknown>) => ({
    id: 1,
    signDate: "2026-10-13 17:56:43",
    customerBin: "080940008218",
    Customer: { nameRu: "КГУ Школа" },
    supplierBiin: "061140003942",
    Supplier: { nameRu: 'ТОО "F3.kz"' },
    ContractUnits: [{ itemPrice: 427000, itemPriceWnds: 495320, quantity: 130, refEnstruCode: ["262011.100.000001"] }],
    ...over
  });

  it("keeps only the units of the requested ENSTRU code, with who bought and who won", async () => {
    const { goszakup, bodies } = api({
      Contract: {
        totalCount: 168,
        data: [
          contract({}),
          contract({
            id: 2,
            ContractUnits: [
              { itemPrice: 721000, itemPriceWnds: 721000, quantity: 1, refEnstruCode: ["262013.000.000012"] },
              { itemPrice: 1438000, itemPriceWnds: 1438000, quantity: 1, refEnstruCode: ["262011.100.000001"] }
            ]
          })
        ]
      }
    });

    const result = await goszakup.contractPrices({ enstruCode: "262011.100.000001", year: 2026, limit: 60 });

    expect(result.totalContracts).toBe(168);
    expect(result.prices).toEqual([
      { contractId: 1, signDate: "2026-10-13", customerBin: "080940008218", customerName: "КГУ Школа", supplierBin: "061140003942", supplierName: 'ТОО "F3.kz"', unitPrice: 495320, unitPriceNoVat: 427000, quantity: 130 },
      { contractId: 2, signDate: "2026-10-13", customerBin: "080940008218", customerName: "КГУ Школа", supplierBin: "061140003942", supplierName: 'ТОО "F3.kz"', unitPrice: 1438000, unitPriceNoVat: 1438000, quantity: 1 }
    ]);
    expect(bodies[0].variables).toMatchObject({ code: "262011.100.000001", year: 2026, limit: 60 });
  });

  it("takes the price without VAT when the contract has no price with VAT", async () => {
    const { goszakup } = api({ Contract: { data: [contract({ ContractUnits: [{ itemPrice: 335000, itemPriceWnds: null, quantity: 10, refEnstruCode: ["262011.100.000001"] }] })] } });

    expect((await goszakup.contractPrices({ enstruCode: "262011.100.000001", year: 2026, limit: 10 })).prices[0]).toMatchObject({ unitPrice: 335000, unitPriceNoVat: 335000 });
  });

  it("skips units without a usable price", async () => {
    const { goszakup } = api({ Contract: { data: [contract({ ContractUnits: [{ itemPrice: 0, itemPriceWnds: 0, quantity: 5, refEnstruCode: ["262011.100.000001"] }, { itemPrice: null, quantity: 1, refEnstruCode: ["262011.100.000001"] }] })] } });

    expect((await goszakup.contractPrices({ enstruCode: "262011.100.000001", year: 2026, limit: 10 })).prices).toEqual([]);
  });
});

describe("summarizePrices", () => {
  const price = (unitPrice: number) => ({ contractId: 1, signDate: "2026-10-01", customerBin: "1", customerName: "", supplierBin: "2", supplierName: "", unitPrice, unitPriceNoVat: unitPrice, quantity: 1 });

  it("gives count, min, median and max of the unit prices", () => {
    expect(summarizePrices([price(300), price(100), price(900), price(500)])).toEqual({ count: 4, min: 100, median: 400, max: 900 });
  });

  it("returns null for an empty sample", () => {
    expect(summarizePrices([])).toBeNull();
  });
});

describe("GoszakupApi.customerHistory", () => {
  it("lists the latest contracts and the suppliers who win most often", async () => {
    const { goszakup, bodies } = api({
      Contract: {
        totalCount: 486,
        data: [
          { id: 3, signDate: "2026-08-05 10:16:27", contractSum: 1292989.65, trdBuyNameRu: "Бензин", supplierBiin: "111", Supplier: { nameRu: "ТОО А" } },
          { id: 2, signDate: "2026-06-30 16:40:10", contractSum: 7293103.45, trdBuyNameRu: "Компьютеры", supplierBiin: "222", Supplier: { nameRu: "ТОО Б" } },
          { id: 1, signDate: "2026-06-22 08:12:19", contractSum: 17241.38, trdBuyNameRu: "Бланки", supplierBiin: "111", Supplier: { nameRu: "ТОО А" } }
        ]
      }
    });

    const history = await goszakup.customerHistory("950340001114", { limit: 30 });

    expect(history.totalContracts).toBe(486);
    expect(history.contracts[0]).toEqual({ id: 3, signDate: "2026-08-05", sum: 1292989.65, title: "Бензин", supplierBin: "111", supplierName: "ТОО А" });
    expect(history.topSuppliers).toEqual([
      { bin: "111", name: "ТОО А", contracts: 2 },
      { bin: "222", name: "ТОО Б", contracts: 1 }
    ]);
    expect(bodies[0].variables).toMatchObject({ bin: "950340001114", limit: 30 });
  });

  it("narrows the history to one ENSTRU code when asked", async () => {
    const { goszakup, bodies } = api({ Contract: { data: [] } });

    await goszakup.customerHistory("950340001114", { limit: 10, enstruCode: "262011.100.000001" });

    expect(bodies[0].query).toContain("contractUnitsFilter");
    expect(bodies[0].variables).toMatchObject({ code: "262011.100.000001" });
  });
});

describe("GoszakupApi.planStatus", () => {
  const PLAN = { id: 88029122, nameRu: "Бумага", plnPointYear: 2026, amount: 20000, count: 20, price: 1000, refEnstruCode: "172211.200.000000", RefMonths: { nameRu: "Сентябрь" }, RefPlnPointStatus: { nameRu: "Опубликован" }, RefTradeMethods: { nameRu: "Запрос ценовых предложений" } };
  const lot = (over: Record<string, unknown>) => ({
    lotNumber: "88029122-ОИ4",
    nameRu: "Бумага",
    amount: 20000,
    count: 20,
    trdBuyId: 17773013,
    trdBuyNumberAnno: "17773013-1",
    RefLotsStatus: { nameRu: "Опубликован (прием заявок)" },
    TrdBuy: {
      id: 17773013,
      startDate: "2026-10-13 17:01:48",
      endDate: "2026-10-15 17:01:48",
      RefBuyStatus: { nameRu: "Опубликовано (прием заявок)" },
      Files: [
        { nameRu: "Перечень лотов", originalName: "lots.pdf", filePath: "https://ows.goszakup.gov.kz/download/trd_buy/a" },
        { nameRu: "Техническая спецификация", originalName: "techspec.pdf", filePath: "https://ows.goszakup.gov.kz/download/trd_buy/b" }
      ]
    },
    ...over
  });

  it("reports the plan point and the tenders announced for it, the newest first", async () => {
    const { goszakup, bodies } = api({
      Plans: { data: [PLAN] },
      Lots: {
        data: [
          lot({ lotNumber: "88029122-ЗЦП3", trdBuyId: 17744644, trdBuyNumberAnno: "17744644-1", RefLotsStatus: { nameRu: "Закупка не состоялась" }, TrdBuy: { id: 17744644, startDate: "2026-10-09 17:00:00", endDate: "2026-10-13 17:00:00", RefBuyStatus: { nameRu: "Завершено" }, Files: [] } }),
          lot({})
        ]
      }
    });

    const status = await goszakup.planStatus(88029122);

    expect(status.plan).toEqual({ id: 88029122, name: "Бумага", year: 2026, month: "Сентябрь", status: "Опубликован", tradeMethod: "Запрос ценовых предложений", amount: 20000, count: 20, unitPrice: 1000, enstruCode: "172211.200.000000" });
    expect(status.lots.map((l) => l.announceId)).toEqual([17773013, 17744644]);
    expect(status.lots[0]).toMatchObject({
      lotNumber: "88029122-ОИ4",
      lotStatus: "Опубликован (прием заявок)",
      announceNumber: "17773013-1",
      buyStatus: "Опубликовано (прием заявок)",
      applicationsFrom: "2026-10-13 17:01",
      applicationsUntil: "2026-10-15 17:01",
      specFiles: [{ name: "techspec.pdf", url: "https://ows.goszakup.gov.kz/download/trd_buy/b" }],
      otherFiles: ["Перечень лотов"]
    });
    expect(bodies.map((b) => b.variables)).toEqual([{ id: 88029122 }, { point: 88029122 }]);
  });

  it("says there are no tenders yet for a plan point that has not been announced", async () => {
    const { goszakup } = api({ Plans: { data: [{ ...PLAN, RefPlnPointStatus: { nameRu: "На проверке камерального контроля" } }] }, Lots: { data: null } });

    const status = await goszakup.planStatus(88243985);

    expect(status.lots).toEqual([]);
    expect(status.plan?.status).toBe("На проверке камерального контроля");
  });

  it("returns no plan when the number is unknown", async () => {
    const { goszakup } = api({ Plans: { data: null }, Lots: { data: null } });

    expect(await goszakup.planStatus(1)).toEqual({ plan: null, lots: [] });
  });
});

describe("GoszakupApi.lotInfo", () => {
  const LOT = {
    lotNumber: "83132229-ЗЦП1",
    nameRu: "Компьютер",
    descriptionRu: "специализированный",
    amount: 675273.92,
    count: 1,
    customerBin: "220640048477",
    customerNameRu: 'ГУ "Аппарат акима области Ұлытау"',
    pointList: [88224537],
    trdBuyId: 17771096,
    trdBuyNumberAnno: "17771096-1",
    RefLotsStatus: { nameRu: "Опубликован (прием ценовых предложений)" },
    TrdBuy: {
      id: 17771096,
      startDate: "2026-10-13 15:35:00",
      endDate: "2026-10-15 15:35:00",
      RefBuyStatus: { nameRu: "Опубликовано (прием ценовых предложений)" },
      Files: [{ nameRu: "Техническая спецификация", originalName: "techspec.pdf", filePath: "https://ows.goszakup.gov.kz/download/trd_buy/z" }]
    }
  };
  const PLAN = { id: 88224537, nameRu: "Компьютер", plnPointYear: 2026, amount: 675274, count: 1, price: 675274, refEnstruCode: "262011.100.000001", RefMonths: { nameRu: "Октябрь" }, RefPlnPointStatus: { nameRu: "Опубликован" }, RefTradeMethods: { nameRu: "Запрос ценовых предложений" } };

  it("finds the customer BIN, the real bid period and the current plan point by the lot number, not by its prefix", async () => {
    const { goszakup, bodies } = api({ Lots: { data: [LOT] }, Plans: { data: [PLAN] } });

    const info = await goszakup.lotInfo("83132229-ЗЦП1");

    expect(info).toMatchObject({
      lotNumber: "83132229-ЗЦП1",
      name: "Компьютер",
      description: "специализированный",
      customerBin: "220640048477",
      customerName: 'ГУ "Аппарат акима области Ұлытау"',
      pointIds: [88224537],
      lotStatus: "Опубликован (прием ценовых предложений)",
      announceNumber: "17771096-1",
      applicationsFrom: "2026-10-13 15:35",
      applicationsUntil: "2026-10-15 15:35",
      specFiles: [{ name: "techspec.pdf", url: "https://ows.goszakup.gov.kz/download/trd_buy/z" }]
    });
    expect(info?.plans).toEqual([expect.objectContaining({ id: 88224537, enstruCode: "262011.100.000001", status: "Опубликован" })]);
    expect(bodies.map((b) => b.variables)).toEqual([{ lot: "83132229-ЗЦП1" }, { id: [88224537] }]);
  });

  it("returns null for an unknown lot without asking for plans", async () => {
    const { goszakup, bodies } = api({ Lots: { data: null }, Plans: { data: [PLAN] } });

    expect(await goszakup.lotInfo("1-ЗЦП1")).toBeNull();
    expect(bodies).toHaveLength(1);
  });

  it("lotsInfo resolves many lots, keeps their order and gives null for the ones it cannot read", async () => {
    const { goszakup } = api({
      Lots: { data: (variables: Record<string, unknown>) => (variables.lot === "нет-1" ? null : [{ ...LOT, lotNumber: String(variables.lot), pointList: [] }]) },
      Plans: { data: [] }
    });

    const infos = await goszakup.lotsInfo(["a-1", "нет-1", "b-1"]);

    expect(infos.map((info) => info?.lotNumber ?? null)).toEqual(["a-1", null, "b-1"]);
  });
});

describe("GoszakupApi.planStatus does not guess lots from the lot number", () => {
  it("still finds tenders through the plan point id filter", async () => {
    const { goszakup, bodies } = api({ Plans: { data: [{ id: 5, nameRu: "x", RefPlnPointStatus: { nameRu: "Опубликован" } }] }, Lots: { data: [] } });

    await goszakup.planStatus(5);

    expect(bodies[1].variables).toEqual({ point: 5 });
  });
});

describe("GoszakupApi.customerSuppliers", () => {
  const contract = (over: Record<string, unknown>) => ({
    id: 1,
    signDate: "2026-10-08 10:00:00",
    contractSum: 1000,
    trdBuyNameRu: "Закупка",
    supplierBiin: "111111111111",
    Supplier: { nameRu: "ТОО А" },
    ...over
  });

  it("ranks the customer's suppliers by contracts, then by total sum", async () => {
    const { goszakup, bodies } = api({
      Contract: {
        totalCount: 1157,
        data: [
          contract({ id: 1, contractSum: 5_000_000, signDate: "2026-10-08 10:00:00", trdBuyNameRu: "Лицензии" }),
          contract({ id: 2, contractSum: 100, signDate: "2026-09-01 10:00:00", supplierBiin: "222222222222", Supplier: { nameRu: "ТОО Б" }, trdBuyNameRu: "Почта" }),
          contract({ id: 3, contractSum: 2_000_000, signDate: "2026-10-12 10:00:00", trdBuyNameRu: "Лицензии" }),
          contract({ id: 4, contractSum: 700, signDate: "2026-08-01 10:00:00", supplierBiin: "222222222222", Supplier: { nameRu: "ТОО Б" }, trdBuyNameRu: "Реклама" }),
          contract({ id: 5, contractSum: 90_000_000, supplierBiin: "333333333333", Supplier: { nameRu: "ТОО В" }, trdBuyNameRu: "Конкурс" }),
          contract({ id: 6, contractSum: 10, supplierBiin: "", Supplier: null })
        ]
      }
    });

    const result = await goszakup.customerSuppliers("040340008429");

    expect(result.totalContracts).toBe(1157);
    expect(result.analyzed).toBe(6);
    expect(result.suppliers.map((s) => [s.bin, s.contracts, s.totalSum, s.lastSignDate])).toEqual([
      ["111111111111", 2, 7_000_000, "2026-10-12"],
      ["222222222222", 2, 800, "2026-09-01"],
      ["333333333333", 1, 90_000_000, "2026-10-08"]
    ]);
    expect(result.suppliers[0]).toMatchObject({ name: "ТОО А", subjects: ["Лицензии"] });
    expect(bodies[0].variables).toMatchObject({ bin: "040340008429", limit: 200 });
  });

  it("looks only at contracts for the given ENSTRU code when asked", async () => {
    const { goszakup, bodies } = api({ Contract: { data: [contract({})], totalCount: 1 } });

    await goszakup.customerSuppliers("040340008429", { enstruCode: "262011.100.000001" });

    expect(bodies[0].variables).toMatchObject({ code: "262011.100.000001" });
  });

  it("returns an empty list when the customer has no contracts", async () => {
    const { goszakup } = api({ Contract: { data: null, totalCount: 0 } });

    expect(await goszakup.customerSuppliers("000000000000")).toEqual({ totalContracts: 0, analyzed: 0, suppliers: [] });
  });
});

describe("GoszakupApi.contractContacts phones", () => {
  it("counts the same number written with different spaces and hyphens once", async () => {
    const { goszakup } = api({
      Contract: {
        data: [
          { customerFio: "Даутов Дархан", customerPhone: "8 7172 796593", signDate: "2026-10-08 10:00:00" },
          { customerFio: "Даутов Дархан", customerPhone: "8 7172 79-65-93", signDate: "2026-10-07 10:00:00" },
          { customerFio: "Даутов Дархан", customerPhone: "8(7172)796593", signDate: "2026-10-06 10:00:00" },
          { customerFio: "Даутов Дархан", customerPhone: "8 7172 796591", signDate: "2026-10-05 10:00:00" }
        ]
      }
    });

    expect((await goszakup.contractContacts("1", 50)).contacts[0].phones).toEqual(["8 7172 796593", "8 7172 796591"]);
  });

  it("splits several numbers written in one field, counts a number with and without the city code once, and shows at most six", async () => {
    const { goszakup } = api({
      Contract: {
        data: [
          { customerFio: "Ашуев Айдын", customerPhone: "78-68-81, 78-68-50", signDate: "2026-10-08 10:00:00" },
          { customerFio: "Ашуев Айдын", customerPhone: "78-68-50", signDate: "2026-10-07 10:00:00" },
          { customerFio: "Ашуев Айдын", customerPhone: "8 (7172) 78-68-81; 78-69-05", signDate: "2026-10-06 10:00:00" },
          { customerFio: "Ашуев Айдын", customerPhone: "78-69-18, 78-69-92, 78-69-14, 78-68-65, 78-68-10", signDate: "2026-10-05 10:00:00" }
        ]
      }
    });

    expect((await goszakup.contractContacts("1", 50)).contacts[0].phones).toEqual(["78-68-81", "78-68-50", "78-69-05", "78-69-18", "78-69-92", "78-69-14"]);
  });
});

describe("GoszakupApi.lotDeadlines", () => {
  const NOW = Date.parse("2026-10-14T05:00:00Z"); // 10:00 в Алматы
  const lot = (lotNumber: string, until: string, status = "Опубликован (прием заявок)") => ({
    lotNumber,
    RefLotsStatus: { nameRu: status },
    TrdBuy: { startDate: "2026-10-13 10:00:00", endDate: until }
  });

  function setup(lots: Record<string, unknown>) {
    const asked: string[] = [];
    const clock = { now: NOW };
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const name = JSON.parse(String(init?.body)).variables.lot as string;
      asked.push(name);
      const data = lots[name];
      if (data instanceof Error) throw data;
      return new Response(JSON.stringify({ data: { Lots: data ? [data] : null } }), { status: 200 });
    }) as typeof fetch;
    return { goszakup: new GoszakupApi({ token: "t", fetchFn, retryDelayMs: 0, maxRetries: 0 }, { now: () => clock.now }), asked, clock };
  }

  it("gives the status and the real bid period in the order asked, null for an unknown or unreadable lot", async () => {
    const { goszakup } = setup({ "A-1": lot("A-1", "2026-10-16 09:00:00"), "C-1": new Error("ECONNRESET") });

    expect(await goszakup.lotDeadlines(["A-1", "B-1", "C-1"])).toEqual([
      { lotNumber: "A-1", lotStatus: "Опубликован (прием заявок)", applicationsFrom: "2026-10-13 10:00", applicationsUntil: "2026-10-16 09:00" },
      null,
      null
    ]);
  });

  it("never asks again about a tender that has ended, and re-asks a live one only after ten minutes", async () => {
    const { goszakup, asked, clock } = setup({
      "ENDED-1": lot("ENDED-1", "2026-10-14 09:00:00", "Закупка не состоялась"),
      "LIVE-1": lot("LIVE-1", "2026-10-16 09:00:00")
    });

    await goszakup.lotDeadlines(["ENDED-1", "LIVE-1"]);
    clock.now += 5 * 60_000;
    await goszakup.lotDeadlines(["ENDED-1", "LIVE-1"]);
    expect(asked).toEqual(["ENDED-1", "LIVE-1"]);

    clock.now += 6 * 60_000;
    await goszakup.lotDeadlines(["ENDED-1", "LIVE-1"]);
    expect(asked).toEqual(["ENDED-1", "LIVE-1", "LIVE-1"]);
  });

  it("does not remember a failed lookup", async () => {
    const lots: Record<string, unknown> = { "A-1": new Error("ECONNRESET") };
    const { goszakup, asked } = setup(lots);

    expect(await goszakup.lotDeadlines(["A-1"])).toEqual([null]);
    lots["A-1"] = lot("A-1", "2026-10-16 09:00:00");
    expect((await goszakup.lotDeadlines(["A-1"]))[0]?.applicationsUntil).toBe("2026-10-16 09:00");
    expect(asked).toEqual(["A-1", "A-1"]);
  });
});

describe("GoszakupApi.enstruCodes", () => {
  it("finds the ENSTRU codes plans use for a product name, most used first, without empty codes", async () => {
    const { goszakup, bodies } = api({
      Plans: {
        totalCount: 2045,
        data: [
          { refEnstruCode: "262011.100.000002" },
          { refEnstruCode: "262011.100.000001" },
          { refEnstruCode: "262011.100.000001" },
          { refEnstruCode: "0" },
          { refEnstruCode: null }
        ]
      }
    });

    const result = await goszakup.enstruCodes("Ноутбук", 2026);

    expect(result).toEqual({ totalPoints: 2045, codes: [{ code: "262011.100.000001", points: 2 }, { code: "262011.100.000002", points: 1 }] });
    // реестр принимает год только списком: `Int` он отвергает ошибкой типа
    expect(bodies[0].variables).toMatchObject({ n: "Ноутбук", y: [2026] });
    expect(bodies[0].query).toContain("$y: [Int]");
  });

  it("returns an empty list for a name the plans do not use", async () => {
    const { goszakup } = api({ Plans: { data: null, totalCount: 0 } });

    expect(await goszakup.enstruCodes("Моноблок", 2026)).toEqual({ totalPoints: 0, codes: [] });
  });
});

