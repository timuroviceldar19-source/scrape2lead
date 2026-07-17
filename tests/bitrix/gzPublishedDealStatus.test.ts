import { describe, expect, it, vi } from "vitest";
import {
  buildPublishedDealUpdate,
  applyPublishedDealUpdate,
  selectPublishedDealBatch
} from "../../src/bitrix/gzPublishedDealStatus.js";

const DETECTED_AT = "2026-07-16T10:00:00.000Z";

function deal(overrides: Record<string, unknown> = {}) {
  return {
    UF_CRM_PLAN_STATUS: "Утвержден",
    UF_CRM_6627AEBD85B4D: "Утвержден",
    UF_CRM_S2L_GZ_PUBLISHED_AT: null,
    ...overrides
  };
}

describe("buildPublishedDealUpdate", () => {
  it("moves an approved deal to published in both status fields without touching STAGE_ID", () => {
    const result = buildPublishedDealUpdate(deal(), "Опубликован", DETECTED_AT);
    expect(result).toEqual({
      fields: {
        UF_CRM_PLAN_STATUS: "Опубликован",
        UF_CRM_6627AEBD85B4D: "Опубликован",
        UF_CRM_S2L_GZ_PUBLISHED_AT: DETECTED_AT
      },
      action: "update-status",
      skipReason: null
    });
    expect(result.fields).not.toHaveProperty("STAGE_ID");
  });

  it("never plans a STAGE_ID write regardless of the stage the deal sits in", () => {
    for (const stageId of ["C41:NEW", "C41:PREPARATION", "C41:WON", "C41:LOSE"]) {
      const result = buildPublishedDealUpdate(deal({ STAGE_ID: stageId }), "Опубликован", DETECTED_AT);
      expect(result.action).toBe("update-status");
      expect(result.fields).not.toHaveProperty("STAGE_ID");
    }
  });

  it("repairs a stale legacy status field when the primary status is approved", () => {
    const result = buildPublishedDealUpdate(deal({
      UF_CRM_6627AEBD85B4D: "Опубликован"
    }), "Опубликован", DETECTED_AT);
    expect(result.fields).toEqual({
      UF_CRM_PLAN_STATUS: "Опубликован",
      UF_CRM_S2L_GZ_PUBLISHED_AT: DETECTED_AT
    });
  });

  it("falls back to the legacy status field when the primary field is empty", () => {
    const result = buildPublishedDealUpdate(deal({ UF_CRM_PLAN_STATUS: "" }), "Опубликован", DETECTED_AT);
    expect(result.action).toBe("update-status");
    expect(result.fields.UF_CRM_PLAN_STATUS).toBe("Опубликован");
  });

  it("preserves an existing first-publication timestamp", () => {
    const result = buildPublishedDealUpdate(deal({
      UF_CRM_S2L_GZ_PUBLISHED_AT: "2026-07-15T09:00:00.000Z"
    }), "Опубликован", DETECTED_AT);
    expect(result.fields).toEqual({
      UF_CRM_PLAN_STATUS: "Опубликован",
      UF_CRM_6627AEBD85B4D: "Опубликован"
    });
  });

  it("skips a deal that is already published in Bitrix", () => {
    const result = buildPublishedDealUpdate(deal({
      UF_CRM_PLAN_STATUS: "Опубликован",
      UF_CRM_6627AEBD85B4D: "Опубликован",
      UF_CRM_S2L_GZ_PUBLISHED_AT: "2026-07-15T09:00:00.000Z"
    }), "Опубликован", DETECTED_AT);
    expect(result).toEqual({
      fields: {},
      action: "skipped",
      skipReason: "deal is already published in Bitrix"
    });
  });

  it.each(["Отменен", "Закупка состоялась", "Договор действует", "Проект заявки"])(
    "skips a deal whose Bitrix status is %s",
    (status) => {
      const result = buildPublishedDealUpdate(deal({
        UF_CRM_PLAN_STATUS: status,
        UF_CRM_6627AEBD85B4D: status
      }), "Опубликован", DETECTED_AT);
      expect(result.fields).toEqual({});
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain(status);
    }
  );

  it("skips a deal with no status in either field", () => {
    const result = buildPublishedDealUpdate(deal({
      UF_CRM_PLAN_STATUS: null,
      UF_CRM_6627AEBD85B4D: ""
    }), "Опубликован", DETECTED_AT);
    expect(result.fields).toEqual({});
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toContain("-");
  });

  it("matches the approved status regardless of case and padding", () => {
    const result = buildPublishedDealUpdate(deal({
      UF_CRM_PLAN_STATUS: "  утвержден  ",
      UF_CRM_6627AEBD85B4D: "  утвержден  "
    }), "Опубликован", DETECTED_AT);
    expect(result.action).toBe("update-status");
  });
});

describe("applyPublishedDealUpdate", () => {
  it("sends the exact planned fields to Bitrix only in execute mode", async () => {
    const updateDeal = vi.fn(async (_id: string, _fields: Record<string, string>) => {});
    const update = buildPublishedDealUpdate(deal(), "Опубликован", DETECTED_AT);
    await expect(applyPublishedDealUpdate({ updateDeal }, "41293", update, true)).resolves.toBe(true);
    expect(updateDeal).toHaveBeenCalledWith("41293", update.fields);
    expect(updateDeal.mock.calls[0]![1]).not.toHaveProperty("STAGE_ID");
  });

  it("does not call Bitrix for dry-runs or skipped deals", async () => {
    const updateDeal = vi.fn(async () => {});
    const update = buildPublishedDealUpdate(deal(), "Опубликован", DETECTED_AT);
    await expect(applyPublishedDealUpdate({ updateDeal }, "41293", update, false)).resolves.toBe(false);

    const skipped = buildPublishedDealUpdate(deal({ UF_CRM_PLAN_STATUS: "Отменен", UF_CRM_6627AEBD85B4D: "Отменен" }), "Опубликован", DETECTED_AT);
    await expect(applyPublishedDealUpdate({ updateDeal }, "41293", skipped, true)).resolves.toBe(false);
    expect(updateDeal).not.toHaveBeenCalled();
  });
});

describe("selectPublishedDealBatch", () => {
  const deals = Array.from({ length: 35 }, (_, index) => ({ id: index + 1 }));

  it("selects a non-overlapping window by offset and limit", () => {
    expect(selectPublishedDealBatch(deals, 20, 10).map((deal) => deal.id)).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30
    ]);
  });

  it("returns the remaining deals when the limit is omitted", () => {
    expect(selectPublishedDealBatch(deals, 30, null).map((deal) => deal.id)).toEqual([31, 32, 33, 34, 35]);
  });
});
