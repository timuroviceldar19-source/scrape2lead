import { describe, expect, it, vi } from "vitest";
import {
  buildPublishedDealUpdate,
  ensurePublishedDealStages,
  listPublishedStageRoutes,
  type PublishedStageClient,
  type PublishedStageRoute
} from "../../src/bitrix/gzPublishedDealStage.js";
import type { GzRoutingConfig } from "../../src/bitrix/gzDealRouting.js";

const ROUTE: PublishedStageRoute = {
  categoryId: 41,
  initialStageId: "C41:NEW",
  publishedStageId: "C41:S2L_PUBLISHED"
};

function deal(overrides: Record<string, unknown> = {}) {
  return {
    CATEGORY_ID: "41",
    STAGE_ID: "C41:NEW",
    UF_CRM_PLAN_STATUS: "Утвержден",
    UF_CRM_6627AEBD85B4D: "Утвержден",
    UF_CRM_S2L_GZ_PUBLISHED_AT: null,
    ...overrides
  };
}

describe("buildPublishedDealUpdate", () => {
  it("moves an initial deal and writes the first detected timestamp", () => {
    expect(buildPublishedDealUpdate(deal(), ROUTE, "Опубликован", "2026-07-16T10:00:00.000Z")).toEqual({
      fields: {
        STAGE_ID: "C41:S2L_PUBLISHED",
        UF_CRM_PLAN_STATUS: "Опубликован",
        UF_CRM_6627AEBD85B4D: "Опубликован",
        UF_CRM_S2L_GZ_PUBLISHED_AT: "2026-07-16T10:00:00.000Z"
      },
      stageAction: "moved",
      stageSkipReason: null
    });
  });

  it.each(["C41:PREPARATION", "C41:WON", "C41:LOSE"])(
    "does not move a deal from %s backwards",
    (stageId) => {
      const result = buildPublishedDealUpdate(deal({ STAGE_ID: stageId }), ROUTE, "Опубликован", "2026-07-16T10:00:00.000Z");
      expect(result.fields).not.toHaveProperty("STAGE_ID");
      expect(result.stageAction).toBe("skipped-noninitial");
      expect(result.stageSkipReason).toContain(stageId);
    }
  );

  it("is a complete no-op when the published stage and fields are already current", () => {
    expect(buildPublishedDealUpdate(deal({
      STAGE_ID: "C41:S2L_PUBLISHED",
      UF_CRM_PLAN_STATUS: "Опубликован",
      UF_CRM_6627AEBD85B4D: "Опубликован",
      UF_CRM_S2L_GZ_PUBLISHED_AT: "2026-07-15T09:00:00.000Z"
    }), ROUTE, "Опубликован", "2026-07-16T10:00:00.000Z")).toEqual({
      fields: {},
      stageAction: "already-published",
      stageSkipReason: null
    });
  });

  it("preserves an existing first-published timestamp while repairing status fields", () => {
    const result = buildPublishedDealUpdate(deal({
      STAGE_ID: "C41:PREPARATION",
      UF_CRM_S2L_GZ_PUBLISHED_AT: "2026-07-15T09:00:00.000Z"
    }), ROUTE, "Опубликован", "2026-07-16T10:00:00.000Z");
    expect(result.fields).toEqual({
      UF_CRM_PLAN_STATUS: "Опубликован",
      UF_CRM_6627AEBD85B4D: "Опубликован"
    });
  });
});

describe("listPublishedStageRoutes", () => {
  it("deduplicates category mappings from routing rules", () => {
    const config = {
      rules: [
        { name: "one", keywordsAny: ["pc"], categoryId: 9, stageId: "C9:NEW", publishedStageId: "C9:S2L_PUBLISHED" },
        { name: "two", keywordsAny: ["monitor"], categoryId: 9, stageId: "C9:NEW", publishedStageId: "C9:S2L_PUBLISHED" }
      ],
      default: { categoryId: 29, stageId: "C29:NEW", publishedStageId: "C29:S2L_PUBLISHED" }
    } satisfies GzRoutingConfig;
    expect(listPublishedStageRoutes(config)).toEqual([
      { categoryId: 9, initialStageId: "C9:NEW", publishedStageId: "C9:S2L_PUBLISHED" },
      { categoryId: 29, initialStageId: "C29:NEW", publishedStageId: "C29:S2L_PUBLISHED" }
    ]);
  });
});

describe("ensurePublishedDealStages", () => {
  function clientWith(stages: Array<Record<string, unknown>>): PublishedStageClient & {
    addDealStage: ReturnType<typeof vi.fn>;
  } {
    let current = [...stages];
    return {
      listDealStages: vi.fn(async () => current),
      addDealStage: vi.fn(async (input) => {
        current = [...current, {
          ENTITY_ID: `DEAL_STAGE_${input.categoryId}`,
          STATUS_ID: input.statusId,
          NAME: input.name,
          SORT: String(input.sort),
          SEMANTICS: null
        }];
      })
    };
  }

  const initial = {
    ENTITY_ID: "DEAL_STAGE_41",
    STATUS_ID: "C41:NEW",
    NAME: "Лиды по панелям",
    SORT: "10",
    SEMANTICS: null
  };

  it("previews a missing stage without writing", async () => {
    const client = clientWith([initial]);
    await expect(ensurePublishedDealStages(client, [ROUTE], false)).resolves.toEqual([
      { categoryId: 41, publishedStageId: "C41:S2L_PUBLISHED", action: "planned" }
    ]);
    expect(client.addDealStage).not.toHaveBeenCalled();
  });

  it("creates a missing stage after the initial stage and verifies it", async () => {
    const client = clientWith([initial]);
    await expect(ensurePublishedDealStages(client, [ROUTE], true)).resolves.toEqual([
      { categoryId: 41, publishedStageId: "C41:S2L_PUBLISHED", action: "created" }
    ]);
    expect(client.addDealStage).toHaveBeenCalledWith({
      categoryId: 41,
      statusId: "C41:S2L_PUBLISHED",
      name: "Опубликован",
      sort: 11,
      semantics: ""
    });
  });

  it("is idempotent when the valid stage already exists", async () => {
    const client = clientWith([initial, {
      ENTITY_ID: "DEAL_STAGE_41",
      STATUS_ID: "C41:S2L_PUBLISHED",
      NAME: "Опубликован",
      SORT: "11",
      SEMANTICS: null
    }]);
    await expect(ensurePublishedDealStages(client, [ROUTE], true)).resolves.toEqual([
      { categoryId: 41, publishedStageId: "C41:S2L_PUBLISHED", action: "present" }
    ]);
    expect(client.addDealStage).not.toHaveBeenCalled();
  });

  it("fails preflight before any write when an existing stage conflicts", async () => {
    const secondRoute = { categoryId: 9, initialStageId: "C9:NEW", publishedStageId: "C9:S2L_PUBLISHED" };
    const client: PublishedStageClient = {
      listDealStages: vi.fn(async (categoryId) => categoryId === 41
        ? [initial]
        : [
            { ENTITY_ID: "DEAL_STAGE_9", STATUS_ID: "C9:NEW", NAME: "Новая", SORT: "10", SEMANTICS: null },
            { ENTITY_ID: "DEAL_STAGE_9", STATUS_ID: "C9:S2L_PUBLISHED", NAME: "Wrong", SORT: "11", SEMANTICS: null }
          ]),
      addDealStage: vi.fn(async () => {})
    };
    await expect(ensurePublishedDealStages(client, [ROUTE, secondRoute], true)).rejects.toThrow(/conflicts/i);
    expect(client.addDealStage).not.toHaveBeenCalled();
  });
});
