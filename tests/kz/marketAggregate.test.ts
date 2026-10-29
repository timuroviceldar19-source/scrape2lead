import { describe, it, expect } from "vitest";
import { buildMarketGroupView, buildMarketView, calculateQuantile, getPreviousWorkday } from "../../src/kz/market/aggregate.js";
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
        supplier: cfg.bin || (typeof cfg.ourBins[0] === "string" ? cfg.ourBins[0] : cfg.ourBins[0].bin),
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

  it("combines group companies (F3 + Amanat Asia) into a single row, ignores stale us:false in cache, excludes both from lost", () => {
    const testCfg: MarketConfig = {
      ...cfg,
      ourBins: ["061140003942", "130540000688"]
    };

    const units: MarketUnit[] = [
      // F3 company unit (with us: true)
      {
        id: 101,
        month: "2026-10",
        date: "2026-10-10",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 88200000,
        qty: 100,
        price: 882000,
        supplier: "061140003942",
        customer: "111111111111",
        supplierName: 'ТОО "F3.kz"',
        customerName: "Заказчик 1",
        method: "Открытый конкурс",
        us: true
      },
      // Amanat Asia company unit (simulating OLD cache where us was false!)
      {
        id: 102,
        month: "2026-10",
        date: "2026-10-12",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 11800000,
        qty: 20,
        price: 590000,
        supplier: "130540000688",
        customer: "222222222222",
        supplierName: 'ТОО "Amanat Asia"',
        customerName: "Заказчик 2",
        method: "Электронный магазин",
        us: false // old cache flag must be ignored
      },
      // Competitor with 50m
      {
        id: 103,
        month: "2026-10",
        date: "2026-10-15",
        group: "ИП",
        code: "262030.100.000021",
        kind: "Интерактивные панели",
        sum: 50000000,
        qty: 60,
        price: 833333,
        supplier: "777777777777",
        customer: "333333333333",
        supplierName: "ТОО Конкурент",
        customerName: "Заказчик 3",
        method: "Запрос ценовых предложений",
        us: false
      }
    ];

    const view = buildMarketGroupView("ИП", units, "2026-10-25", testCfg);

    // Group ranking: exactly 1 row for our group with combined sum
    const ourSuppliers = view.suppliers.filter((s) => s.us);
    expect(ourSuppliers).toHaveLength(1);
    expect(ourSuppliers[0].name).toBe("Группа F3");
    expect(ourSuppliers[0].sum).toBe(88200000 + 11800000);
    expect(ourSuppliers[0].details).toContain("F3");
    expect(ourSuppliers[0].details).toContain("Amanat Asia");

    // Total suppliers: 2 (Группа F3 + ТОО Конкурент)
    expect(view.suppliers).toHaveLength(2);
    expect(view.us.rank).toBe(1); // 100m > 50m
    expect(view.us.sum).toBe(100000000);

    // Neither F3 nor Amanat Asia contracts appear in lost contracts
    expect(view.lost).toHaveLength(1);
    expect(view.lost[0].id).toBe(103);
    expect(view.lost.some((l) => l.supplierBin === "061140003942" || l.supplierBin === "130540000688")).toBe(false);
  });

  it("calculates ourCompanies breakdown by month and year-to-date (ytd) summary", () => {
    const testCfg: MarketConfig = {
      ...cfg,
      ourBins: [
        { bin: "061140003942", name: "F3" },
        { bin: "130540000688", name: "Amanat Asia" }
      ]
    };

    const units: MarketUnit[] = [
      // January: only Amanat Asia sold (e.g. in KT before July)
      {
        id: 1,
        month: "2026-01",
        date: "2026-01-15",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 60000000,
        qty: 100,
        price: 600000,
        supplier: "130540000688",
        customer: "111111111111",
        supplierName: 'ТОО "Amanat Asia"',
        customerName: "Колледж 1",
        method: "Электронный магазин",
        us: true
      },
      // January: competitor sold 40m
      {
        id: 2,
        month: "2026-01",
        date: "2026-01-20",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 40000000,
        qty: 80,
        price: 500000,
        supplier: "999999999999",
        customer: "222222222222",
        supplierName: "Конкурент КТ",
        customerName: "Колледж 2",
        method: "Открытый конкурс",
        us: false
      },
      // October: F3 sold 150m
      {
        id: 3,
        month: "2026-10",
        date: "2026-10-10",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 150000000,
        qty: 250,
        price: 600000,
        supplier: "061140003942",
        customer: "333333333333",
        supplierName: 'ТОО "F3.kz"',
        customerName: "Колледж 3",
        method: "Открытый конкурс",
        us: true
      },
      // October: Amanat Asia sold 10m
      {
        id: 4,
        month: "2026-10",
        date: "2026-10-12",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 10000000,
        qty: 15,
        price: 666666,
        supplier: "130540000688",
        customer: "444444444444",
        supplierName: 'ТОО "Amanat Asia"',
        customerName: "Колледж 4",
        method: "Электронный магазин",
        us: true
      },
      // October: competitor sold 140m
      {
        id: 5,
        month: "2026-10",
        date: "2026-10-14",
        group: "КТ",
        code: "262011.100.000001",
        kind: "Ноутбуки",
        sum: 140000000,
        qty: 200,
        price: 700000,
        supplier: "888888888888",
        customer: "555555555555",
        supplierName: "Конкурент 2",
        customerName: "Колледж 5",
        method: "Открытый конкурс",
        us: false
      }
    ];

    const view = buildMarketGroupView("КТ", units, "2026-10-25", testCfg);

    // 1. ourCompanies on view
    expect(view.ourCompanies).toEqual([
      { bin: "061140003942", name: "F3" },
      { bin: "130540000688", name: "Amanat Asia" }
    ]);

    // 2. Months breakdown
    expect(view.months).toHaveLength(2);
    const jan = view.months[0];
    expect(jan.m).toBe("2026-01");
    expect(jan.sum).toBe(100000000);
    expect(jan.us).toBe(60000000);
    expect(jan.ourCompanies).toBeDefined();
    expect(jan.ourCompanies![0]).toEqual({ bin: "061140003942", name: "F3", sum: 0 });
    expect(jan.ourCompanies![1]).toEqual({ bin: "130540000688", name: "Amanat Asia", sum: 60000000 });

    const oct = view.months[1];
    expect(oct.m).toBe("2026-10");
    expect(oct.sum).toBe(300000000);
    expect(oct.us).toBe(160000000);
    expect(oct.ourCompanies![0]).toEqual({ bin: "061140003942", name: "F3", sum: 150000000 });
    expect(oct.ourCompanies![1]).toEqual({ bin: "130540000688", name: "Amanat Asia", sum: 10000000 });

    // 3. Year-to-date (ytd) summary
    expect(view.ytd).toBeDefined();
    const ytd = view.ytd!;
    expect(ytd.totalSum).toBe(400000000); // 100m in Jan + 300m in Oct
    expect(ytd.sum).toBe(220000000); // 60m + 160m
    expect(ytd.share).toBeCloseTo(220000000 / 400000000); // 55%
    expect(ytd.rank).toBe(1); // 220m > 140m > 40m
    expect(ytd.totalSuppliers).toBe(3); // Группа F3, Конкурент 2 (140m), Конкурент КТ (40m)
    expect(ytd.companies).toEqual([
      { bin: "061140003942", name: "F3", sum: 150000000, share: 150000000 / 400000000 },
      { bin: "130540000688", name: "Amanat Asia", sum: 70000000, share: 70000000 / 400000000 }
    ]);
  });

  it("calculates previous workday correctly across weekends", () => {
    // Tuesday -> Monday
    expect(getPreviousWorkday("2026-10-27")).toBe("2026-10-26");
    // Monday -> Friday
    expect(getPreviousWorkday("2026-10-26")).toBe("2026-10-23");
    // Sunday -> Friday
    expect(getPreviousWorkday("2026-10-25")).toBe("2026-10-23");
  });

  it("only marks market view as stale if data is older than previous workday", () => {
    // Thursday with Wednesday data: NOT stale (yesterday's data during morning run)
    const viewNormal = buildMarketView([], "2026-10-29", cfg, undefined, "2026-10-28");
    expect(viewNormal.stale).toBe(false);

    // Thursday with Tuesday data: STALE (missed Wednesday)
    const viewStale = buildMarketView([], "2026-10-29", cfg, undefined, "2026-10-27");
    expect(viewStale.stale).toBe(true);

    // Monday with Friday data: NOT stale
    const viewMonday = buildMarketView([], "2026-10-26", cfg, undefined, "2026-10-23");
    expect(viewMonday.stale).toBe(false);
  });
});
