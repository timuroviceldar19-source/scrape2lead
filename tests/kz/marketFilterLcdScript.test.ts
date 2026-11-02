import { describe, expect, it } from "vitest";
import {
  filterLcdUnits,
  findBestSubject,
  getMonthDates,
  parseArgs,
  type OwsContractRow,
  type ZakupSubjectItem
} from "../../scripts/market-filter-lcd.mjs";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import type { MarketUnit } from "../../src/kz/market/types.js";

describe("market-filter-lcd script helpers", () => {
  it("parses CLI flags correctly", () => {
    const opts = parseArgs(["--write", "--in", "custom-in.json", "--out-dir", "custom-out", "--no-cache"]);
    expect(opts.write).toBe(true);
    expect(opts.inPath).toBe("custom-in.json");
    expect(opts.outDir).toBe("custom-out");
    expect(opts.noCache).toBe(true);
  });

  it("calculates month boundaries for regular and leap years", () => {
    expect(getMonthDates("2026-01")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(getMonthDates("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(getMonthDates("2026-04")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
    expect(getMonthDates("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("finds the best subject by exact code, price and qty match", () => {
    const unit: MarketUnit = {
      id: 1,
      month: "2026-10",
      date: "2026-10-15",
      group: "ИП",
      code: "279020.100.000001",
      kind: "Жидкокристаллические панели",
      sum: 1_500_000,
      qty: 2,
      price: 750_000,
      supplier: "111111111111",
      customer: "222222222222",
      supplierName: "Поставщик",
      customerName: "Заказчик",
      method: "ЭМ",
      us: false
    };

    const subs = [
      {
        plan_item: { enstru: { code: "279020.100.000002" } },
        item_price_without_vat: 500_000,
        quantity: 1
      },
      {
        plan_item: {
          enstru: { code: "279020.100.000001" },
          extra_description_ru: "Панель интерактивная"
        },
        item_price_without_vat: 750_000,
        quantity: 2,
        contract_price_without_vat: 1_500_000
      }
    ];

    const match = findBestSubject(subs, unit);
    expect(match).toBeDefined();
    expect(match?.plan_item?.extra_description_ru).toBe("Панель интерактивная");
  });

  it("filters LCD units using OWS fallback when missing on zakup", () => {
    const cfg = loadMarketConfig();

    const unitKept: MarketUnit = {
      id: 9001,
      unitIndex: 0,
      month: "2026-02",
      date: "2026-02-10",
      group: "ИП",
      code: "279020.100.000001",
      kind: "Жидкокристаллические панели",
      sum: 2_000_000,
      qty: 2,
      price: 1_000_000,
      supplier: "111111111111",
      customer: "222222222222",
      supplierName: "Поставщик А",
      customerName: "Заказчик А",
      method: "ЭМ",
      us: false
    };

    const unitDroppedPlansNull: MarketUnit = {
      id: 9002,
      unitIndex: 0,
      month: "2026-02",
      date: "2026-02-12",
      group: "ИП",
      code: "279020.100.000001",
      kind: "Жидкокристаллические панели",
      sum: 1_000_000,
      qty: 1,
      price: 1_000_000,
      supplier: "333333333333",
      customer: "444444444444",
      supplierName: "Поставщик Б",
      customerName: "Заказчик Б",
      method: "ЭМ",
      us: false
    };

    const unitDroppedNoKeyword: MarketUnit = {
      id: 9003,
      unitIndex: 0,
      month: "2026-02",
      date: "2026-02-15",
      group: "ИП",
      code: "279020.100.000001",
      kind: "Жидкокристаллические панели",
      sum: 800_000,
      qty: 1,
      price: 800_000,
      supplier: "555555555555",
      customer: "666666666666",
      supplierName: "Поставщик В",
      customerName: "Заказчик В",
      method: "ЭМ",
      us: false
    };

    // None of these contracts is in zakup
    const zakupSubjectsByOwsId = new Map<number, ZakupSubjectItem[]>();

    // In OWS:
    // 9001: Plans with "интерактивная"
    // 9002: Plans: null
    // 9003: Plans without "интерактив" (e.g. "LED экран")
    const owsContractsById = new Map<number, OwsContractRow>([
      [
        9001,
        {
          id: 9001,
          ContractUnits: [
            {
              refEnstruCode: ["279020.100.000001"],
              Plans: {
                nameRu: "Панель жидкокристаллическая",
                extraDescRu: "Интерактивная панель 75 c креплением",
                extraDescKz: null
              }
            }
          ]
        }
      ],
      [
        9002,
        {
          id: 9002,
          ContractUnits: [
            {
              refEnstruCode: ["279020.100.000001"],
              Plans: null
            }
          ]
        }
      ],
      [
        9003,
        {
          id: 9003,
          ContractUnits: [
            {
              refEnstruCode: ["279020.100.000001"],
              Plans: {
                nameRu: "Панель жидкокристаллическая",
                extraDescRu: "LED экран модульный",
                extraDescKz: null
              }
            }
          ]
        }
      ]
    ]);

    const result = filterLcdUnits({
      units: [unitKept, unitDroppedPlansNull, unitDroppedNoKeyword],
      cfg,
      zakupSubjectsByOwsId,
      owsContractsById
    });

    expect(result.finalUnits).toHaveLength(1);
    expect(result.finalUnits[0].id).toBe(9001);
    expect(result.finalUnits[0].kind).toBe("Интерактивные панели");

    const feb = result.scriptSummary.months.find((m) => m.month === "2026-02");
    expect(feb).toBeDefined();
    expect(feb?.lcdKeptCount).toBe(1);
    expect(feb?.lcdKeptOwsCount).toBe(1);
    expect(feb?.lcdKeptZakupCount).toBe(0);
    expect(feb?.lcdRemovedCount).toBe(2);
    expect(feb?.lcdNoTextBothCount).toBe(1); // 9002 had Plans: null
    expect(feb?.contractsNotFoundBoth).toBe(0); // all were found in OWS
  });

  it("tracks contracts not found in either source", () => {
    const cfg = loadMarketConfig();
    const unitUnknown: MarketUnit = {
      id: 9999,
      unitIndex: 0,
      month: "2026-03",
      date: "2026-03-01",
      group: "ИП",
      code: "279020.100.000001",
      kind: "Жидкокристаллические панели",
      sum: 500_000,
      qty: 1,
      price: 500_000,
      supplier: "111111111111",
      customer: "222222222222",
      supplierName: "Поставщик Неизвестный",
      customerName: "Заказчик Неизвестный",
      method: "ЭМ",
      us: false
    };

    const result = filterLcdUnits({
      units: [unitUnknown],
      cfg,
      zakupSubjectsByOwsId: new Map(),
      owsContractsById: new Map()
    });

    expect(result.finalUnits).toHaveLength(0);
    expect(result.scriptSummary.total.contractsNotFoundBoth).toBe(1);
    expect(result.scriptSummary.total.lcdNoTextBothCount).toBe(1);
  });
});
