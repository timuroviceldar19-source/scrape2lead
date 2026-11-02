import { describe, expect, it } from "vitest";
import { findBestSubject, getMonthDates, parseArgs } from "../../scripts/market-filter-lcd.mjs";
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
});
