export const PROCUREMENT_METHOD_FIELD = "UF_CRM_6627AEBD4503E";

export interface ProcurementMigrationDeal {
  ID: string | number;
  TITLE?: string | null;
  CATEGORY_ID?: string | number | null;
  STAGE_ID?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
  [PROCUREMENT_METHOD_FIELD]?: unknown;
}

export type ProcurementMigrationDecision =
  | "move"
  | "keep"
  | "unknown-method"
  | "frozen-stage"
  | "unmapped-stage"
  | "out-of-scope";

export interface ProcurementMigrationItem {
  dealId: string;
  title: string;
  purchaseMethod: string;
  currentCategoryId: number;
  currentStageId: string;
  currentAssigneeId: string;
  targetCategoryId: number | null;
  targetStageId: string | null;
  decision: ProcurementMigrationDecision;
  updateFields: { CATEGORY_ID: number; STAGE_ID: string } | null;
}

export interface ProcurementMigrationAfter {
  CATEGORY_ID?: string | number | null;
  STAGE_ID?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
}

export interface ProcurementMigrationVerification {
  afterCategoryId: string;
  afterStageId: string;
  afterAssigneeId: string;
  categoryMatched: boolean;
  stageMatched: boolean;
  assigneePreserved: boolean;
}

const METHOD_TARGETS = new Map<string, number>([
  ["электронный магазин", 41],
  ["открытый конкурс", 9],
  ["запрос ценовых предложений", 9]
]);

const FROZEN_STAGE_SUFFIXES = new Set([
  "WON", "LOSE", "APOLOGY", "DUPLICATE",
  "1", "2", "3", "4", "5", "6", "7", "8", "9"
]);

const SAFE_STAGE_MAP = new Map<string, string>([
  ["C9:NEW", "C41:NEW"],
  ["C9:UC_KQEL1P", "C41:PREPARATION"],
  ["C9:UC_BP8G9D", "C41:PREPAYMENT_INVOIC"],
  ["C9:UC_O85E7B", "C41:EXECUTING"],
  ["C9:UC_9BYKHS", "C41:UC_U884PG"],
  ["C41:NEW", "C9:NEW"],
  ["C41:PREPARATION", "C9:UC_KQEL1P"],
  ["C41:PREPAYMENT_INVOIC", "C9:UC_BP8G9D"],
  ["C41:EXECUTING", "C9:UC_O85E7B"],
  ["C41:UC_U884PG", "C9:UC_9BYKHS"],
  ["C41:UC_3J3PDR", "C9:UC_KQEL1P"]
]);

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeMethod(value: unknown): string {
  return text(value).toLocaleLowerCase("ru");
}

function stageSuffix(stageId: string): string {
  return stageId.replace(/^C\d+:/, "");
}

export function buildProcurementMethodMigrationPlan(
  deals: ProcurementMigrationDeal[]
): ProcurementMigrationItem[] {
  return deals.map((deal) => {
    const dealId = text(deal.ID);
    const currentCategoryId = Number(deal.CATEGORY_ID ?? 0);
    const currentStageId = text(deal.STAGE_ID);
    const currentAssigneeId = text(deal.ASSIGNED_BY_ID);
    const purchaseMethod = text(deal[PROCUREMENT_METHOD_FIELD]);
    const base = {
      dealId,
      title: text(deal.TITLE),
      purchaseMethod,
      currentCategoryId,
      currentStageId,
      currentAssigneeId
    };

    if (currentCategoryId !== 9 && currentCategoryId !== 41) {
      return { ...base, targetCategoryId: null, targetStageId: null, decision: "out-of-scope" as const, updateFields: null };
    }

    const targetCategoryId = METHOD_TARGETS.get(normalizeMethod(purchaseMethod)) ?? null;
    if (targetCategoryId === null) {
      return { ...base, targetCategoryId: null, targetStageId: null, decision: "unknown-method" as const, updateFields: null };
    }
    if (targetCategoryId === currentCategoryId) {
      return { ...base, targetCategoryId, targetStageId: currentStageId, decision: "keep" as const, updateFields: null };
    }
    if (FROZEN_STAGE_SUFFIXES.has(stageSuffix(currentStageId))) {
      return { ...base, targetCategoryId, targetStageId: null, decision: "frozen-stage" as const, updateFields: null };
    }

    const targetStageId = SAFE_STAGE_MAP.get(currentStageId) ?? null;
    if (!targetStageId) {
      return { ...base, targetCategoryId, targetStageId: null, decision: "unmapped-stage" as const, updateFields: null };
    }

    return {
      ...base,
      targetCategoryId,
      targetStageId,
      decision: "move" as const,
      updateFields: { CATEGORY_ID: targetCategoryId, STAGE_ID: targetStageId }
    };
  });
}

export function buildProcurementMethodCrmItemUpdate(item: ProcurementMigrationItem): {
  entityTypeId: 2;
  id: number;
  fields: { categoryId: number; stageId: string };
} {
  if (item.decision !== "move" || item.targetCategoryId === null || item.targetStageId === null) {
    throw new Error(`deal ${item.dealId} is not eligible for migration`);
  }
  const id = Number(item.dealId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`invalid deal id: ${item.dealId}`);
  }
  return {
    entityTypeId: 2,
    id,
    fields: {
      categoryId: item.targetCategoryId,
      stageId: item.targetStageId
    }
  };
}

export function verifyProcurementMethodMigration(
  item: ProcurementMigrationItem,
  after: ProcurementMigrationAfter | null
): ProcurementMigrationVerification {
  const afterCategoryId = text(after?.CATEGORY_ID);
  const afterStageId = text(after?.STAGE_ID);
  const afterAssigneeId = text(after?.ASSIGNED_BY_ID);
  const categoryMatched = afterCategoryId === text(item.targetCategoryId);
  const stageMatched = afterStageId === text(item.targetStageId);
  const assigneePreserved = afterAssigneeId === item.currentAssigneeId;

  if (!categoryMatched) {
    throw new Error(
      `category mismatch for deal ${item.dealId}: ${afterCategoryId || "missing"} != ${item.targetCategoryId}`
    );
  }
  if (!stageMatched) {
    throw new Error(
      `stage mismatch for deal ${item.dealId}: ${afterStageId || "missing"} != ${item.targetStageId}`
    );
  }
  if (!assigneePreserved) {
    throw new Error(
      `responsible changed for deal ${item.dealId}: ${item.currentAssigneeId} -> ${afterAssigneeId || "missing"}`
    );
  }

  return {
    afterCategoryId,
    afterStageId,
    afterAssigneeId,
    categoryMatched,
    stageMatched,
    assigneePreserved
  };
}
