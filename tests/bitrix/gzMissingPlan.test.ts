import { describe, expect, it } from "vitest";
import {
  buildGzDealOutcomeComment,
  dealPlanAmount,
  decideMissingGzPlan,
  gzDealOutcomeKey,
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

// Deal 46155: plan 87676031 vanished from the register on 2026-10-01.
const GYMNASIUM: GzDealPlanRef = {
  planNumber: 87676031,
  pointIds: [87676031],
  revisionIds: [],
  planNumberVerified: true,
  enstruCode: "262030.100.000021",
  itemName: "Панель интерактивная"
};

function row(overrides: Partial<GzRegisterPlanRow>): GzRegisterPlanRow {
  return { planNumber: 84517837, pointId: 88115424, itemName: "Панель жидкокристаллическая", amount: 978_437.93, status: "Ожидает подтверждения", ...overrides };
}

describe("decideMissingGzPlan", () => {
  it("points at the real plan number when the deal holds a revision id", () => {
    // Deal 46329 kept the revision 87036827 of plan 81197483 as its plan number.
    const ref: GzDealPlanRef = { ...GYMNASIUM, planNumber: 87036827, pointIds: [87036827], enstruCode: "262013.000.000011", itemName: "Компьютер" };
    const rows = [row({ planNumber: 81197483, pointId: 87036827, itemName: "Компьютер", amount: 10_345_600, status: "Утвержден" })];

    const outcome = decideMissingGzPlan(ref, 10_345_600, rows, FAMILIES);

    expect(outcome).toEqual({ kind: "plan-renumbered", planNumber: 81197483, planStatus: "Утвержден" });
    expect(gzDealOutcomeKey(outcome!)).toBe("plan-renumbered:81197483");
    expect(buildGzDealOutcomeComment(outcome!, null)).toContain("81197483");
  });

  it("suggests a plan of the same item with the same amount as the new home", () => {
    const rows = [
      row({}),
      row({ planNumber: 82083645, pointId: 88051636, itemName: "Матрас", amount: 978_437.93, status: "Утвержден" })
    ];

    const outcome = decideMissingGzPlan(GYMNASIUM, 978_437.93, rows, FAMILIES);

    expect(outcome).toEqual({ kind: "plan-moved", planNumber: 87676031, candidates: [rows[0]] });
    expect(gzDealOutcomeKey(outcome!)).toBe("plan-moved:84517837");
    const comment = buildGzDealOutcomeComment(outcome!, null);
    expect(comment).toContain("87676031");
    expect(comment).toContain("84517837");
    expect(comment).toContain("Ожидает подтверждения");
  });

  it("needs the amount to match to the tiyn", () => {
    const outcome = decideMissingGzPlan(GYMNASIUM, 978_437.93, [row({ amount: 978_000 })], FAMILIES);
    expect(outcome).toEqual({ kind: "plan-deleted", planNumber: 87676031 });
  });

  it("reports a deleted plan when the customer has nothing alike", () => {
    const outcome = decideMissingGzPlan(GYMNASIUM, 978_437.93, [], FAMILIES);

    expect(outcome).toEqual({ kind: "plan-deleted", planNumber: 87676031 });
    expect(gzDealOutcomeKey(outcome!)).toBe("plan-deleted:87676031");
    expect(buildGzDealOutcomeComment(outcome!, null)).toContain("удалён");
  });

  it("does not guess a move without the deal amount", () => {
    expect(decideMissingGzPlan(GYMNASIUM, null, [row({})], FAMILIES)).toEqual({ kind: "plan-deleted", planNumber: 87676031 });
  });

  it("lists at most three candidates, newest plan first, each plan once", () => {
    const rows = [81000001, 83000003, 82000002, 84000004, 84000004]
      .map((planNumber, index) => row({ planNumber, pointId: 88000000 + index }));

    const outcome = decideMissingGzPlan(GYMNASIUM, 978_437.93, rows, FAMILIES);

    expect(outcome?.kind).toBe("plan-moved");
    expect(gzDealOutcomeKey(outcome!)).toBe("plan-moved:84000004,83000003,82000002");
  });

  it("stays silent for a deal without a plan number", () => {
    expect(decideMissingGzPlan({ ...GYMNASIUM, planNumber: null }, 1, [], FAMILIES)).toBeNull();
  });

  it("never downgrades a settled outcome to a missing plan", () => {
    expect(shouldReplaceGzOutcomeKey("lost:990340007507/260547", "plan-deleted:87676031")).toBe(false);
    expect(shouldReplaceGzOutcomeKey("published:опубликован", "plan-deleted:87676031")).toBe(true);
  });
});

describe("plan amounts", () => {
  it("reads amounts the way Bitrix and the register print them", () => {
    expect(parseTenge("9 051 724.10")).toBe(9_051_724.1);
    expect(parseTenge("978 437,93")).toBe(978_437.93);
    expect(parseTenge("")).toBeNull();
    expect(parseTenge(null)).toBeNull();
  });

  it("prefers the plan amount field over the deal sum", () => {
    expect(dealPlanAmount({ UF_CRM_1715597423325: "9 051 724.10", OPPORTUNITY: "10500000.00" })).toBe(9_051_724.1);
    expect(dealPlanAmount({ UF_CRM_1715597423325: "", OPPORTUNITY: "978437.93" })).toBe(978_437.93);
    expect(dealPlanAmount({ OPPORTUNITY: "0.00" })).toBeNull();
  });
});
