import { describe, expect, it } from "vitest";
import { buildPlanPeriodWindow, evaluatePlanPeriod, EMPTY_PLAN_PERIOD } from "../../src/kz/procurement/planPeriod.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

describe("plan period window", () => {
  it("covers the current month plus the next six, crossing the year boundary", () => {
    const window = buildPlanPeriodWindow(new Date(2026, 9, 15), 7); // октябрь 2026
    expect(window.years).toEqual([2026, 2027]);
    expect([...window.yearMonths].sort()).toEqual(
      ["2026-10", "2026-11", "2026-12", "2027-1", "2027-2", "2027-3", "2027-4"].sort()
    );
  });

  it("keeps a single year when the window does not reach December", () => {
    expect(buildPlanPeriodWindow(new Date(2026, 0, 5), 7).years).toEqual([2026]);
  });
});

describe("evaluatePlanPeriod", () => {
  const window = buildPlanPeriodWindow(new Date(2026, 6, 27), 7); // июль 2026 -> янв 2027

  it("accepts a plan inside the window whose month the source did not publish", () => {
    expect(evaluatePlanPeriod(plan({ planYear: 2026, planMonth: null }), window))
      .toEqual({ status: "ok", monthKnown: false });
  });

  it("accepts a plan whose known month falls inside the window", () => {
    expect(evaluatePlanPeriod(plan({ planYear: 2026, planMonth: 9 }), window))
      .toEqual({ status: "ok", monthKnown: true });
  });

  it("rejects a known month that falls outside the window in an otherwise valid year", () => {
    expect(evaluatePlanPeriod(plan({ planYear: 2026, planMonth: 2 }), window))
      .toEqual({ status: "period_outside_window", year: 2026, month: 2 });
  });

  it("rejects a plan year outside the window", () => {
    expect(evaluatePlanPeriod(plan({ planYear: 2024, collectionPlanYear: 2024 }), window))
      .toEqual({ status: "year_outside_window", actual: 2024 });
  });

  it("reports a record whose year contradicts the year it was collected under", () => {
    expect(evaluatePlanPeriod(plan({ planYear: 2024, collectionPlanYear: 2026 }), window))
      .toEqual({ status: "year_conflict", expected: 2026, actual: 2024 });
  });

  it("leaves tenders alone — they are selected by deadline, not by plan year", () => {
    expect(evaluatePlanPeriod(plan({ recordKind: "tender", planYear: 2024 }), window))
      .toEqual({ status: "ok", monthKnown: true });
  });
});

function plan(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return {
    source: "samruk", recordKind: "plan", sourceRecordId: "1", externalId: "1", parentExternalId: null,
    status: "Утвержден", productName: "Ноутбук", description: "", truCode: "262011.100.000002",
    customerName: "Customer", customerBin: "123456789012", amount: 900_000, currency: "KZT",
    startDate: null, endDate: null, url: "https://example.kz/1", purchaseMethod: null,
    ...EMPTY_PLAN_PERIOD, collectionPlanYear: 2026, collectionPlanYearId: 12,
    collectedAt: "2026-07-27T00:00:00.000Z", ...overrides
  };
}
