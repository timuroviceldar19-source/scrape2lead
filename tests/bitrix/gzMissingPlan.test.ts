import { describe, expect, it } from "vitest";
import {
  buildGzDealOutcomeComment,
  buildGzMissingPlanFields,
  dealPlanAmount,
  decideMissingGzPlan,
  gzDealOutcomeKey,
  gzMissingPlanCandidates,
  parseTenge,
  shouldReplaceGzOutcomeKey,
  type GzDealPlanRef,
  type GzItemFamilies,
  type GzRegisterPlanRow
} from "../../src/bitrix/gzDealOutcome.js";

const FAMILIES: GzItemFamilies = {
  groups: [
    ["262030.100.000021", "262030.100.000043", "279020"],
    ["262011", "262013", "262040.000.000267", "265152.790.000067"]
  ],
  wildcards: ["329959.900.000019", "329953.000"]
};
const NO_DEALS = new Map<number, string>();

// Deal 46155: plan 87676031 vanished from the register on 2026-10-01.
const GYMNASIUM: GzDealPlanRef = {
  planNumber: 87676031,
  pointIds: [87676031],
  revisionIds: [],
  planNumberVerified: true,
  enstruCode: "262030.100.000021",
  itemName: "Панель интерактивная"
};
const NEW_URL = "https://procurement.gov.kz/ru/registry/show_plan/88115424/4900001";

function row(overrides: Partial<GzRegisterPlanRow>): GzRegisterPlanRow {
  return {
    planNumber: 84517837,
    pointId: 88115424,
    itemName: "Панель жидкокристаллическая",
    amount: 978_437.93,
    status: "Ожидает подтверждения",
    url: NEW_URL,
    ...overrides
  };
}

describe("decideMissingGzPlan", () => {
  it("moves a deal that holds a revision id to the real plan number", () => {
    // Deal 46329 kept the revision 87036827 of plan 81197483 as its plan number.
    const ref: GzDealPlanRef = { ...GYMNASIUM, planNumber: 87036827, pointIds: [87036827], enstruCode: "262013.000.000011", itemName: "Компьютер" };
    const owner = row({ planNumber: 81197483, pointId: 87036827, itemName: "Компьютер", amount: 10_345_600, status: "Утвержден" });

    const outcome = decideMissingGzPlan(ref, 10_345_600, [owner], FAMILIES, NO_DEALS);

    expect(outcome).toEqual({ kind: "plan-renumbered", oldPlanNumber: 87036827, plan: owner });
    expect(gzDealOutcomeKey(outcome!)).toBe("plan-renumbered:81197483");
    expect(buildGzDealOutcomeComment(outcome!, null)).toContain("87036827 → 81197483");
  });

  it("moves the deal to a free plan of the same item with the same amount", () => {
    const rows = [
      row({}),
      row({ planNumber: 82083645, pointId: 88051636, itemName: "Матрас", status: "Утвержден" })
    ];

    const outcome = decideMissingGzPlan(GYMNASIUM, 978_437.93, rows, FAMILIES, NO_DEALS);

    expect(outcome).toEqual({ kind: "plan-moved", oldPlanNumber: 87676031, plan: rows[0] });
    expect(gzDealOutcomeKey(outcome!)).toBe("plan-moved:84517837");
    const comment = buildGzDealOutcomeComment(outcome!, null);
    expect(comment).toContain("план 87676031 удалён");
    expect(comment).toContain("84517837");
    expect(comment).toContain("Ожидает подтверждения");
    expect(comment).toContain(NEW_URL);
  });

  it("takes the newest free plan when several look the same", () => {
    const rows = [81000001, 83000003, 82000002].map((planNumber, index) => row({ planNumber, pointId: 88000000 + index }));

    const outcome = decideMissingGzPlan(GYMNASIUM, 978_437.93, rows, FAMILIES, new Map([[83000003, "45851"]]));

    expect(outcome).toMatchObject({ kind: "plan-moved", plan: { planNumber: 82000002 } });
  });

  it("leaves the deal alone when every twin plan already has a deal", () => {
    // Deal 44095: plan 87540699 deleted, its twin 87540700 is deal 44093.
    const monitor: GzDealPlanRef = { ...GYMNASIUM, planNumber: 87540699, pointIds: [87540699], enstruCode: null, itemName: "Монитор" };
    const twin = row({ planNumber: 87540700, pointId: 87540700, itemName: "Монитор", amount: 1_025_853.45 });

    expect(decideMissingGzPlan(monitor, 1_025_853.45, [twin], FAMILIES, new Map([[87540700, "44093"]]))).toBeNull();
  });

  it("needs the amount to match to the tiyn", () => {
    expect(decideMissingGzPlan(GYMNASIUM, 978_437.93, [row({ amount: 978_000 })], FAMILIES, NO_DEALS)).toBeNull();
  });

  it("leaves a deleted plan alone when the customer has nothing alike", () => {
    expect(decideMissingGzPlan(GYMNASIUM, 978_437.93, [], FAMILIES, NO_DEALS)).toBeNull();
  });

  it("does not guess a move without the deal amount", () => {
    expect(decideMissingGzPlan(GYMNASIUM, null, [row({})], FAMILIES, NO_DEALS)).toBeNull();
  });

  it("lists candidates newest first, each plan once", () => {
    const rows = [81000001, 83000003, 84000004, 84000004].map((planNumber, index) => row({ planNumber, pointId: 88000000 + index }));
    expect(gzMissingPlanCandidates(GYMNASIUM, 978_437.93, rows, FAMILIES).map((item) => item.planNumber))
      .toEqual([84000004, 83000003, 81000001]);
  });

  it("stays silent for a deal without a plan number", () => {
    expect(decideMissingGzPlan({ ...GYMNASIUM, planNumber: null }, 1, [], FAMILIES, NO_DEALS)).toBeNull();
  });

  it("never downgrades a settled outcome to a moved plan", () => {
    expect(shouldReplaceGzOutcomeKey("lost:990340007507/260547", "plan-moved:84517837")).toBe(false);
    expect(shouldReplaceGzOutcomeKey("published:опубликован", "plan-moved:84517837")).toBe(true);
  });
});

describe("buildGzMissingPlanFields", () => {
  it("rewrites the plan number, point, links, status and title of a moved deal", () => {
    const outcome = decideMissingGzPlan(GYMNASIUM, 978_437.93, [row({})], FAMILIES, NO_DEALS)!;

    expect(buildGzMissingPlanFields({ TITLE: "[GZ 87676031] Гимназия №36 - Панель" }, outcome)).toEqual({
      TITLE: "[GZ 84517837] Гимназия №36 - Панель",
      UF_CRM_PLAN_ID: "84517837",
      UF_CRM_1782386293000_IU_XLS: "84517837",
      UF_CRM_6A436D5A3614C: "88115424",
      UF_CRM_PLAN_LINK: NEW_URL,
      UF_CRM_1782386571874_IU_XLS: NEW_URL,
      UF_CRM_1782386080157_IU_XLS: NEW_URL,
      UF_CRM_6627AEBD85B4D: "Ожидает подтверждения",
      UF_CRM_PLAN_STATUS: "Ожидает подтверждения"
    });
  });

  it("leaves a title without the plan number and missing link or status alone", () => {
    const outcome = decideMissingGzPlan(GYMNASIUM, 978_437.93, [row({ url: null, status: null })], FAMILIES, NO_DEALS)!;

    expect(buildGzMissingPlanFields({ TITLE: "Панель интерактивная" }, outcome)).toEqual({
      UF_CRM_PLAN_ID: "84517837",
      UF_CRM_1782386293000_IU_XLS: "84517837",
      UF_CRM_6A436D5A3614C: "88115424"
    });
  });
});

describe("plan amounts", () => {
  it("reads amounts the way Bitrix and the register print them", () => {
    expect(parseTenge("9 051 724.10")).toBe(9_051_724.1);
    expect(parseTenge("978 437,93")).toBe(978_437.93);
    expect(parseTenge("")).toBeNull();
    expect(parseTenge(null)).toBeNull();
  });

  it("prefers the plan amount field over the deal sum", () => {
    expect(dealPlanAmount({ UF_CRM_1715597423325: "9 051 724.10", OPPORTUNITY: "10500000.00" })).toBe(9_051_724.1);
    expect(dealPlanAmount({ UF_CRM_1715597423325: "", OPPORTUNITY: "978437.93" })).toBe(978_437.93);
    expect(dealPlanAmount({ OPPORTUNITY: "0.00" })).toBeNull();
  });
});
