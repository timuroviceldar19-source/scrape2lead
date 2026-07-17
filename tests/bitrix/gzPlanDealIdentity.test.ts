import { describe, expect, it } from "vitest";
import {
  getGzPlanDealIdentity,
  legacyDealMatchesRow
} from "../../src/bitrix/gzPlanDealIdentity.js";

const panelRow = {
  planId: "4775438",
  planNumber: "81205554",
  planUrl: "https://goszakup.gov.kz/ru/registry/show_plan/87018653/4775438"
};

const monitorRow = {
  planId: "4775438",
  planNumber: "81211733",
  planUrl: "https://goszakup.gov.kz/ru/registry/show_plan/87018811/4775438"
};

describe("getGzPlanDealIdentity", () => {
  it("gives colliding legacy rows distinct canonical origin ids", () => {
    expect(getGzPlanDealIdentity(panelRow)).toEqual({
      planPointId: "87018653",
      originId: "gz-plan:87018653",
      legacyOriginId: "gz-plan:4775438"
    });
    expect(getGzPlanDealIdentity(monitorRow).originId).toBe("gz-plan:87018811");
  });

  it("does not invent a legacy origin for one-segment links", () => {
    expect(getGzPlanDealIdentity({
      planId: "87018653",
      planNumber: "81205554",
      planUrl: "https://goszakup.gov.kz/ru/registry/show_plan/87018653"
    }).legacyOriginId).toBeNull();
  });

  it("rejects a row without any numeric identity", () => {
    expect(() => getGzPlanDealIdentity({ planId: "", planNumber: "1", planUrl: "invalid" }))
      .toThrow(/canonical plan point ID/);
  });
});

describe("legacyDealMatchesRow", () => {
  it("accepts the exact legacy deal by plan link", () => {
    expect(legacyDealMatchesRow(panelRow, {
      ORIGIN_ID: "gz-plan:4775438",
      UF_CRM_PLAN_LINK: panelRow.planUrl
    })).toBe(true);
  });

  it("does not let a sibling with the same legacy id block creation", () => {
    expect(legacyDealMatchesRow(monitorRow, {
      ORIGIN_ID: "gz-plan:4775438",
      UF_CRM_PLAN_LINK: panelRow.planUrl,
      UF_CRM_PLAN_ID: panelRow.planNumber
    })).toBe(false);
  });

  it("accepts a legacy deal by exact plan number when its link is absent", () => {
    expect(legacyDealMatchesRow(panelRow, {
      ORIGIN_ID: "gz-plan:4775438",
      UF_CRM_PLAN_ID: panelRow.planNumber
    })).toBe(true);
  });

  it("supports alternate imported link fields and rejects foreign origins", () => {
    expect(legacyDealMatchesRow(panelRow, {
      ORIGIN_ID: "gz-plan:4775438",
      UF_CRM_1782386571874_IU_XLS: panelRow.planUrl
    })).toBe(true);
    expect(legacyDealMatchesRow(panelRow, {
      ORIGIN_ID: "gz-plan:other",
      UF_CRM_PLAN_LINK: panelRow.planUrl
    })).toBe(false);
  });
});
