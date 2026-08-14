import { describe, expect, it } from "vitest";
import {
  buildProcurementMethodCrmItemUpdate,
  buildProcurementMethodMigrationPlan,
  PROCUREMENT_METHOD_FIELD,
  verifyProcurementMethodMigration,
  type ProcurementMigrationDeal
} from "../../src/bitrix/gzProcurementMethodMigration.js";

const deal = (overrides: Partial<ProcurementMigrationDeal>): ProcurementMigrationDeal => ({
  ID: "1",
  TITLE: "Test",
  CATEGORY_ID: 9,
  STAGE_ID: "C9:UC_KQEL1P",
  ASSIGNED_BY_ID: "725",
  [PROCUREMENT_METHOD_FIELD]: "Электронный магазин",
  ...overrides
});

describe("buildProcurementMethodMigrationPlan", () => {
  it("moves an electronic-shop deal to the equivalent working stage without changing assignee", () => {
    const [item] = buildProcurementMethodMigrationPlan([deal({})]);

    expect(item).toMatchObject({
      dealId: "1",
      purchaseMethod: "Электронный магазин",
      currentCategoryId: 9,
      currentStageId: "C9:UC_KQEL1P",
      currentAssigneeId: "725",
      targetCategoryId: 41,
      targetStageId: "C41:PREPARATION",
      decision: "move"
    });
    expect(item.updateFields).toEqual({ CATEGORY_ID: 41, STAGE_ID: "C41:PREPARATION" });
    expect(item.updateFields).not.toHaveProperty("ASSIGNED_BY_ID");
  });

  it("moves OK and ZCP deals from the electronic-shop pipeline", () => {
    const items = buildProcurementMethodMigrationPlan([
      deal({ ID: "2", CATEGORY_ID: 41, STAGE_ID: "C41:PREPAYMENT_INVOIC", [PROCUREMENT_METHOD_FIELD]: "Открытый конкурс" }),
      deal({ ID: "3", CATEGORY_ID: 41, STAGE_ID: "C41:EXECUTING", [PROCUREMENT_METHOD_FIELD]: "Запрос ценовых предложений" })
    ]);

    expect(items[0]).toMatchObject({ targetCategoryId: 9, targetStageId: "C9:UC_BP8G9D", decision: "move" });
    expect(items[1]).toMatchObject({ targetCategoryId: 9, targetStageId: "C9:UC_O85E7B", decision: "move" });
  });

  it("keeps correctly routed deals and ignores blank or unknown methods", () => {
    const items = buildProcurementMethodMigrationPlan([
      deal({ ID: "4", CATEGORY_ID: 41 }),
      deal({ ID: "5", [PROCUREMENT_METHOD_FIELD]: "" }),
      deal({ ID: "6", [PROCUREMENT_METHOD_FIELD]: "Аукцион" })
    ]);

    expect(items.map((item) => item.decision)).toEqual(["keep", "unknown-method", "unknown-method"]);
  });

  it("does not move closed deals or stages without a safe equivalent", () => {
    const items = buildProcurementMethodMigrationPlan([
      deal({ ID: "7", STAGE_ID: "C9:WON" }),
      deal({ ID: "8", STAGE_ID: "C9:UC_HB4Z3U" })
    ]);

    expect(items.map((item) => item.decision)).toEqual(["frozen-stage", "unmapped-stage"]);
  });
});

describe("procurement-method migration execution", () => {
  it("uses the universal CRM API shape required for cross-pipeline moves", () => {
    const [item] = buildProcurementMethodMigrationPlan([deal({})]);

    expect(buildProcurementMethodCrmItemUpdate(item)).toEqual({
      entityTypeId: 2,
      id: 1,
      fields: {
        categoryId: 41,
        stageId: "C41:PREPARATION"
      }
    });
  });

  it("rejects a silent no-op even when the assignee was preserved", () => {
    const [item] = buildProcurementMethodMigrationPlan([deal({})]);

    expect(() => verifyProcurementMethodMigration(item, {
      CATEGORY_ID: "9",
      STAGE_ID: "C9:UC_KQEL1P",
      ASSIGNED_BY_ID: "725"
    })).toThrow(/category.*9.*41/i);
  });

  it("accepts only the exact target pipeline, stage, and original assignee", () => {
    const [item] = buildProcurementMethodMigrationPlan([deal({})]);

    expect(verifyProcurementMethodMigration(item, {
      CATEGORY_ID: "41",
      STAGE_ID: "C41:PREPARATION",
      ASSIGNED_BY_ID: "725"
    })).toEqual({
      afterCategoryId: "41",
      afterStageId: "C41:PREPARATION",
      afterAssigneeId: "725",
      categoryMatched: true,
      stageMatched: true,
      assigneePreserved: true
    });
  });

  it("refuses to build an update for a deal outside the move set", () => {
    const [item] = buildProcurementMethodMigrationPlan([deal({
      [PROCUREMENT_METHOD_FIELD]: ""
    })]);

    expect(() => buildProcurementMethodCrmItemUpdate(item)).toThrow(/not eligible/i);
  });

  it("rejects an invalid deal identifier", () => {
    const [item] = buildProcurementMethodMigrationPlan([deal({ ID: "not-a-number" })]);

    expect(() => buildProcurementMethodCrmItemUpdate(item)).toThrow(/invalid deal id/i);
  });

  it("rejects a wrong stage or a changed responsible", () => {
    const [item] = buildProcurementMethodMigrationPlan([deal({})]);

    expect(() => verifyProcurementMethodMigration(item, {
      CATEGORY_ID: "41",
      STAGE_ID: "C41:NEW",
      ASSIGNED_BY_ID: "725"
    })).toThrow(/stage mismatch/i);
    expect(() => verifyProcurementMethodMigration(item, {
      CATEGORY_ID: "41",
      STAGE_ID: "C41:PREPARATION",
      ASSIGNED_BY_ID: "195"
    })).toThrow(/responsible changed/i);
  });
});
