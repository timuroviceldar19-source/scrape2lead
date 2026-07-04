import { describe, expect, it } from "vitest";
import {
  buildBackfillFields,
  buildGzOriginId,
  decideBackfillAction,
  extractPlanIdFromUrl,
  GZ_PLAN_LINK_FIELD,
  GZ_PLAN_POINT_ID_FIELD
} from "../../src/bitrix/gzOriginBackfill.js";

describe("extractPlanIdFromUrl", () => {
  it("extracts the plan point id from goszakup show_plan urls", () => {
    expect(extractPlanIdFromUrl("https://goszakup.gov.kz/ru/registry/show_plan/86446786/4714749"))
      .toBe("4714749");
    expect(extractPlanIdFromUrl("https://goszakup.gov.kz/ru/registry/show_plan/86446786/4714749?tab=x"))
      .toBe("4714749");
  });

  it("returns null for foreign or malformed urls", () => {
    expect(extractPlanIdFromUrl("https://goszakup.gov.kz/ru/registry/show_supplier/7862")).toBeNull();
    expect(extractPlanIdFromUrl("https://goszakup.gov.kz/ru/registry/show_plan/86446786")).toBeNull();
    expect(extractPlanIdFromUrl("")).toBeNull();
    expect(extractPlanIdFromUrl(null)).toBeNull();
  });
});

describe("decideBackfillAction", () => {
  const noClaims = new Map<string, string>();

  it("backfills deals without origin using the plan link", () => {
    expect(decideBackfillAction({
      ID: 39299,
      [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/86446786/4714749"
    }, noClaims)).toEqual({ action: "backfill", originId: "gz-plan:4714749", planId: "4714749" });
  });

  it("prefers the plan point id field over url parsing when present", () => {
    expect(decideBackfillAction({
      ID: 1,
      [GZ_PLAN_POINT_ID_FIELD]: "555",
      [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/1/999"
    }, noClaims)).toEqual({ action: "backfill", originId: "gz-plan:555", planId: "555" });
  });

  it("leaves already-keyed deals alone", () => {
    expect(decideBackfillAction({
      ID: 40673,
      ORIGINATOR_ID: "scrape2lead-gz-plans",
      ORIGIN_ID: "gz-plan:4553677"
    }, noClaims)).toEqual({ action: "already-keyed" });
  });

  it("does not touch deals owned by other originators or with foreign origin ids", () => {
    expect(decideBackfillAction({
      ID: 2,
      ORIGINATOR_ID: "some-other-import",
      [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/1/2"
    }, noClaims)).toEqual({ action: "foreign-origin" });

    expect(decideBackfillAction({
      ID: 3,
      ORIGIN_ID: "manual:2",
      [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/1/2"
    }, noClaims)).toEqual({ action: "foreign-origin" });
  });

  it("claims foreign-import deals only when explicitly allowed and origin id is empty", () => {
    const xlsDeal = {
      ID: 39299,
      ORIGINATOR_ID: "app_iu_xls_import",
      [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/86446786/4714749"
    };

    expect(decideBackfillAction(xlsDeal, noClaims)).toEqual({ action: "foreign-origin" });

    expect(decideBackfillAction(xlsDeal, noClaims, { claimOriginators: new Set(["app_iu_xls_import"]) }))
      .toEqual({ action: "backfill", originId: "gz-plan:4714749", planId: "4714749" });

    expect(decideBackfillAction(
      { ...xlsDeal, ORIGIN_ID: "xls:1" },
      noClaims,
      { claimOriginators: new Set(["app_iu_xls_import"]) }
    )).toEqual({ action: "foreign-origin" });
  });

  it("skips deals without a derivable plan id", () => {
    expect(decideBackfillAction({ ID: 4, [GZ_PLAN_LINK_FIELD]: "not a url" }, noClaims))
      .toEqual({ action: "no-plan-id" });
  });

  it("flags a conflict when the derived origin id is already claimed by another deal", () => {
    const claims = new Map([["gz-plan:4714749", "40673"]]);
    expect(decideBackfillAction({
      ID: 39299,
      [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/86446786/4714749"
    }, claims)).toEqual({ action: "conflict", originId: "gz-plan:4714749", claimedByDealId: "40673" });
  });

  it("does not flag a conflict against the deal itself", () => {
    const claims = new Map([["gz-plan:4714749", "39299"]]);
    expect(decideBackfillAction({
      ID: 39299,
      [GZ_PLAN_LINK_FIELD]: "https://goszakup.gov.kz/ru/registry/show_plan/86446786/4714749"
    }, claims)).toEqual({ action: "backfill", originId: "gz-plan:4714749", planId: "4714749" });
  });
});

describe("buildBackfillFields", () => {
  it("sets originator, origin id, and the plan point id field", () => {
    expect(buildBackfillFields("4714749")).toEqual({
      ORIGINATOR_ID: "scrape2lead-gz-plans",
      ORIGIN_ID: buildGzOriginId("4714749"),
      [GZ_PLAN_POINT_ID_FIELD]: "4714749"
    });
  });
});
