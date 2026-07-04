import { describe, expect, it } from "vitest";
import {
  DEFAULT_OLD_XLS_ORIGINATOR_ID,
  buildDuplicateArchiveFields,
  findGzDuplicatePairs,
  stageMatchesDealCategory
} from "../../src/bitrix/gzDuplicateHygiene.js";
import { GZ_PLAN_LINK_FIELD, GZ_PLAN_POINT_ID_FIELD } from "../../src/bitrix/gzOriginBackfill.js";

describe("findGzDuplicatePairs", () => {
  it("selects only old XLS-copy deals when a keyed GZ deal exists for the same plan", () => {
    const pairs = findGzDuplicatePairs([
      {
        ID: 39943,
        TITLE: "Keyed deal",
        ORIGINATOR_ID: "scrape2lead-gz-plans",
        ORIGIN_ID: "gz-plan:4553677"
      },
      {
        ID: 38825,
        TITLE: "Old XLS copy",
        ORIGINATOR_ID: DEFAULT_OLD_XLS_ORIGINATOR_ID,
        ORIGIN_ID: null,
        [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/86446786/4553677"
      },
      {
        ID: 38826,
        TITLE: "Old XLS copy without keyed pair",
        ORIGINATOR_ID: DEFAULT_OLD_XLS_ORIGINATOR_ID,
        ORIGIN_ID: null,
        [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/86446786/4707153"
      },
      {
        ID: 38827,
        TITLE: "Old XLS copy that already has its own origin",
        ORIGINATOR_ID: DEFAULT_OLD_XLS_ORIGINATOR_ID,
        ORIGIN_ID: "xls:38827",
        [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/86446786/4553677"
      }
    ]);

    expect(pairs).toEqual([
      {
        planId: "4553677",
        originId: "gz-plan:4553677",
        oldDealId: "38825",
        oldCategoryId: "0",
        keyedDealId: "39943",
        oldTitle: "Old XLS copy",
        keyedTitle: "Keyed deal"
      }
    ]);
  });

  it("uses the plan point id field before URL parsing and honors configured old originators", () => {
    const pairs = findGzDuplicatePairs(
      [
        {
          ID: 40701,
          ORIGINATOR_ID: "scrape2lead-gz-plans",
          ORIGIN_ID: "gz-plan:4791188"
        },
        {
          ID: 39305,
          ORIGINATOR_ID: "legacy_portal_import",
          ORIGIN_ID: "",
          [GZ_PLAN_POINT_ID_FIELD]: "4791188",
          [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/1/111"
        }
      ],
      { oldOriginatorIds: new Set(["legacy_portal_import"]) }
    );

    expect(pairs).toMatchObject([
      {
        planId: "4791188",
        oldDealId: "39305",
        keyedDealId: "40701"
      }
    ]);
  });

  it("does not select the keyed deal even if it has a plan link", () => {
    const pairs = findGzDuplicatePairs([
      {
        ID: 39943,
        TITLE: "Keyed deal with link",
        ORIGINATOR_ID: "scrape2lead-gz-plans",
        ORIGIN_ID: "gz-plan:4553677",
        [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/86446786/4553677"
      }
    ]);

    expect(pairs).toEqual([]);
  });
});

describe("buildDuplicateArchiveFields", () => {
  it("returns null without an explicit archive stage", () => {
    expect(buildDuplicateArchiveFields(null)).toBeNull();
    expect(buildDuplicateArchiveFields("")).toBeNull();
  });

  it("updates only the deal stage when an archive stage is configured", () => {
    expect(buildDuplicateArchiveFields("C0:DUPLICATE")).toEqual({ STAGE_ID: "C0:DUPLICATE" });
  });
});

describe("stageMatchesDealCategory", () => {
  it("matches prefixed stages to their pipeline category", () => {
    expect(stageMatchesDealCategory("C41:DUPLICATE", 41)).toBe(true);
    expect(stageMatchesDealCategory("C41:DUPLICATE", "41")).toBe(true);
    expect(stageMatchesDealCategory("C41:DUPLICATE", 0)).toBe(false);
  });

  it("matches bare stage ids only to the default category 0", () => {
    expect(stageMatchesDealCategory("DUPLICATE", 0)).toBe(true);
    expect(stageMatchesDealCategory("DUPLICATE", null)).toBe(true);
    expect(stageMatchesDealCategory("DUPLICATE", 41)).toBe(false);
  });
});
