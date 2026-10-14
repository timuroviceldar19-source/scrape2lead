import { describe, expect, it } from "vitest";
import {
  bidWindowComment,
  bidWindowFields,
  isPlaceholderWindow,
  planLotDateBackfill,
  type LotDateDeal
} from "../../src/bitrix/gzLotDates.js";

const WINDOW = { startDate: "2026-10-13 10:00:00", endDate: "2026-10-15 15:35:00" };

/** Сделка, которую Bitrix заполнил сам: BEGINDATE = день создания, CLOSEDATE = +7 дней. */
function placeholderDeal(overrides: Partial<LotDateDeal> = {}): LotDateDeal {
  return {
    ID: "48667",
    ORIGIN_ID: "gz-lot:83132229-ЗЦП1",
    DATE_CREATE: "2026-10-13T15:35:52+03:00",
    BEGINDATE: "2026-10-13T03:00:00+03:00",
    CLOSEDATE: "2026-10-20T03:00:00+03:00",
    ...overrides
  };
}

describe("bidWindowFields", () => {
  it("turns the registry window into Bitrix dates", () => {
    expect(bidWindowFields(WINDOW)).toEqual({ BEGINDATE: "2026-10-13", CLOSEDATE: "2026-10-15" });
  });

  it("writes nothing when the registry has no window", () => {
    expect(bidWindowFields(null)).toEqual({});
    expect(bidWindowFields({ startDate: null, endDate: null })).toEqual({});
  });

  it("writes only the date the registry knows", () => {
    expect(bidWindowFields({ startDate: null, endDate: WINDOW.endDate })).toEqual({ CLOSEDATE: "2026-10-15" });
  });
});

describe("bidWindowComment", () => {
  it("keeps the hours that a Bitrix date field cannot hold", () => {
    expect(bidWindowComment(WINDOW)).toBe("Приём заявок: 2026-10-13 10:00 — 2026-10-15 15:35 (время Алматы)");
  });

  it("is empty without a window", () => {
    expect(bidWindowComment(null)).toBeNull();
    expect(bidWindowComment({ startDate: null, endDate: null })).toBeNull();
  });
});

describe("isPlaceholderWindow", () => {
  it("recognises the dates Bitrix fills in by default", () => {
    expect(isPlaceholderWindow(placeholderDeal())).toBe(true);
  });

  it("leaves dates a manager changed by hand", () => {
    expect(isPlaceholderWindow(placeholderDeal({ CLOSEDATE: "2026-10-25T03:00:00+03:00" }))).toBe(false);
    expect(isPlaceholderWindow(placeholderDeal({ BEGINDATE: "2026-10-01T03:00:00+03:00" }))).toBe(false);
  });

  it("treats a deal without any dates as free to fill", () => {
    expect(isPlaceholderWindow(placeholderDeal({ BEGINDATE: "", CLOSEDATE: null }))).toBe(true);
  });
});

describe("planLotDateBackfill", () => {
  it("updates only placeholder deals whose registry window differs, and counts the rest", () => {
    const deals = [
      placeholderDeal({ ID: "1", ORIGIN_ID: "gz-lot:100-ЗЦП1" }),
      placeholderDeal({ ID: "2", ORIGIN_ID: "gz-lot:200-ЗЦП1", CLOSEDATE: "2026-10-25T03:00:00+03:00" }),
      placeholderDeal({ ID: "3", ORIGIN_ID: "gz-lot:300-ЗЦП1" }),
      placeholderDeal({ ID: "4", ORIGIN_ID: "gz-lot:400-ЗЦП1", DATE_CREATE: "2026-10-13T15:35:52+03:00", BEGINDATE: "2026-10-13T03:00:00+03:00", CLOSEDATE: "2026-10-20T03:00:00+03:00" }),
      placeholderDeal({ ID: "5", ORIGIN_ID: "gz-lot:500-ЗЦП1" })
    ];
    const windows = new Map([
      ["100-ЗЦП1", WINDOW],
      ["200-ЗЦП1", WINDOW],
      ["400-ЗЦП1", { startDate: "2026-10-13 09:00:00", endDate: "2026-10-20 18:00:00" }]
    ]);

    const plan = planLotDateBackfill(deals, windows, new Set(["500-ЗЦП1"]));

    expect(plan.updates).toEqual([
      { dealId: "1", lotNumber: "100-ЗЦП1", fields: { BEGINDATE: "2026-10-13", CLOSEDATE: "2026-10-15" } }
    ]);
    expect(plan.stats).toEqual({
      total: 5,
      willUpdate: 1,
      editedByHand: 1,
      alreadyRight: 1,
      noWindow: 1,
      lookupFailed: 1
    });
  });

  it("ignores deals that are not lot deals", () => {
    const plan = planLotDateBackfill([placeholderDeal({ ORIGIN_ID: "gz-plan:555" })], new Map(), new Set());
    expect(plan.updates).toEqual([]);
    expect(plan.stats.total).toBe(0);
  });
});
