import { describe, it, expect } from "vitest";
import { buildMarketGroupView, calculateQuantile } from "../../src/kz/market/aggregate.js";
import type { MarketUnit, MarketConfig } from "../../src/kz/market/types.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";

describe("calculateQuantile", () => {
  it("calculates median and quartiles correctly", () => {
    const vals = [10, 20, 30, 40, 50];
    expect(calculateQuantile(vals, 0.5)).toBe(30);
    expect(calculateQuantile(vals, 0.25)).toBe(20);
    expect(calculateQuantile(vals, 0.75)).toBe(40);
  });
});

describe("buildMarketGroupView", () => {
  const cfg = loadMarketConfig();

  it("calculates group summary, rank, share, previous month comparison and percentiles", () => {
    const units: MarketUnit[] = [
      // September (previous month)
      {
        id: 1,
        month: "2026-09",
        date: "2026-09-10",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 1000000,
        qty: 2,
        price: 500000,
        supplier: "999999999999",
        customer: "111111111111",
        supplierName: "Поставщик 1",
        customerName: "Заказчик 1",
        method: "Открытый конкурс",
        us: false
      },
      // October (current month) - Us
      {
        id: 2,
        month: "2026-10",
        date: "2026-10-15",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 2000000,
        qty: 4,
        price: 500000,
        supplier: cfg.bin,
        customer: "222222222222",
        supplierName: 'ТОО "F3.kz"',
        customerName: "Заказчик 2",
        method: "Электронный магазин",
        us: true
      },
      // October - Competitor
      {
        id: 3,
        month: "2026-10",
        date: "2026-10-20",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 1000000,
        qty: 2,
        price: 500000,
        supplier: "888888888888",
        customer: "333333333333",
        supplierName: "Конкурент",
        customerName: "Заказчик 3",
        method: "Запрос ценовых предложений",
        us: false
      }
    ];

    const view = buildMarketGroupView("ИП", units, "2026-10-25");
    expect(view).toBeDefined();
    expect(view.total.sum).toBe(3000000);
    expect(view.total.contracts).toBe(2);
    expect(view.total.suppliers).toBe(2);

    expect(view.us.sum).toBe(2000000);
    expect(view.us.share).toBeCloseTo(2 / 3);
    expect(view.us.rank).toBe(1); // 2m > 1m

    // Previous month (1..toDay = 20) -> 1m
    expect(view.prev.sum).toBe(1000000);
    expect(view.prev.toDay).toBe("20");

    // Suppliers list
    expect(view.suppliers).toHaveLength(2);
    expect(view.suppliers[0].us).toBe(true);
    expect(view.suppliers[0].sum).toBe(2000000);

    // Kinds
    expect(view.kinds).toHaveLength(1);
    expect(view.kinds[0].kind).toBe("Интерактивные панели");
    expect(view.kinds[0].med).toBe(500000);
    expect(view.kinds[0].usMed).toBe(500000);

    // Lost contracts
    expect(view.lost).toHaveLength(1);
    expect(view.lost[0].id).toBe(3);
    expect(view.lost[0].sum).toBe(1000000);
  });
});
