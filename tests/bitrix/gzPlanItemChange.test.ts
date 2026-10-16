import { describe, expect, it } from "vitest";
import { planItemChange, planItemSync, type CurrentPlanItem, type PlanItemDeal } from "../../src/bitrix/gzPlanItemChange.js";

// Сделка 48115: создана 06.10 по первой версии пункта; 15.10 заказчик заменил товар, сумма и количество остались прежними.
const DEAL: PlanItemDeal = {
  ID: "48115",
  ORIGIN_ID: "gz-plan:88137237",
  TITLE: '[GZ 88137237] КГП "Городской родильный дом № 4" - Доска специальная',
  COMMENTS: "GZ plan ID: 88137237\nBIN: 990240002999\nItem: Доска специальная\nAmount: 1 200 000.00",
  DATE_CREATE: "2026-10-06T08:11:34+03:00",
  UF_CRM_REF_ENSTRU_CODE: "262030.100.000043",
  UF_CRM_6A436D5A19612: "262030.100.000043",
  UF_CRM_6627AEBD54B8D: "Доска специальная",
  UF_CRM_ENSTRU_NAME: "Доска специальная",
  UF_CRM_6627AEBD7C2D2: "990240002999",
  UF_CRM_PLAN_LINK: "https://procurement.gov.kz/ru/registry/show_plan/88137237/4904694"
};
const CURRENT: CurrentPlanItem = {
  id: 88294659,
  rootId: 88137237,
  code: "279020.100.000002",
  name: "Панель жидкокристаллическая",
  bin: "990240002999",
  year: 2026,
  createdAt: "2026-10-15 13:30:14"
};

describe("planItemChange", () => {
  it("rewrites the code and the name in every field the robot wrote them to, the title and the comment line", () => {
    const change = planItemChange(DEAL, CURRENT);

    expect(change?.fields).toEqual({
      UF_CRM_REF_ENSTRU_CODE: "279020.100.000002",
      UF_CRM_6A436D5A19612: "279020.100.000002",
      UF_CRM_6627AEBD54B8D: "Панель жидкокристаллическая",
      UF_CRM_ENSTRU_NAME: "Панель жидкокристаллическая",
      TITLE: '[GZ 88137237] КГП "Городской родильный дом № 4" - Панель жидкокристаллическая',
      COMMENTS: "GZ plan ID: 88137237\nBIN: 990240002999\nItem: Панель жидкокристаллическая\nAmount: 1 200 000.00"
    });
  });

  it("explains in a deal comment what changed and when", () => {
    const change = planItemChange(DEAL, CURRENT);

    expect(change?.comment).toBe(
      [
        "План изменён заказчиком 2026-10-15.",
        "Товар: Доска специальная (262030.100.000043) → Панель жидкокристаллическая (279020.100.000002)",
        "Новая версия пункта плана: https://procurement.gov.kz/ru/registry/show_plan/88137237/4904694"
      ].join("\n")
    );
    expect(change).toMatchObject({ dealId: "48115", previous: { code: "262030.100.000043", name: "Доска специальная" }, current: { code: "279020.100.000002", name: "Панель жидкокристаллическая" } });
  });

  it("leaves a title and a comment that a manager rewrote alone", () => {
    const change = planItemChange({ ...DEAL, TITLE: "Роддом 4, панель для Станкевича", COMMENTS: "позвонить в среду" }, CURRENT);

    expect(change?.fields).not.toHaveProperty("TITLE");
    expect(change?.fields).not.toHaveProperty("COMMENTS");
    expect(change?.fields.UF_CRM_REF_ENSTRU_CODE).toBe("279020.100.000002");
  });

  it("does nothing when the code already matches, in either of the two code fields", () => {
    expect(planItemChange({ ...DEAL, UF_CRM_REF_ENSTRU_CODE: "279020.100.000002", UF_CRM_6A436D5A19612: "" }, CURRENT)).toBeNull();
  });

  it("reads the stored code from the second field when the first is empty", () => {
    const change = planItemChange({ ...DEAL, UF_CRM_REF_ENSTRU_CODE: "" }, CURRENT);

    expect(change?.previous.code).toBe("262030.100.000043");
  });

  it("does nothing for a deal without a stored code: there is no amendment to speak of", () => {
    expect(planItemChange({ ...DEAL, UF_CRM_REF_ENSTRU_CODE: "", UF_CRM_6A436D5A19612: "" }, CURRENT)).toBeNull();
  });

  it("does nothing when the registry gives no code or no name", () => {
    expect(planItemChange(DEAL, { ...CURRENT, code: "" })).toBeNull();
    expect(planItemChange(DEAL, { ...CURRENT, name: "" })).toBeNull();
  });

  it("does nothing for another plan number", () => {
    expect(planItemChange({ ...DEAL, ORIGIN_ID: "gz-plan:1" }, CURRENT)).toBeNull();
    expect(planItemChange({ ...DEAL, ORIGIN_ID: "gz-lot:88137237-ЗЦП1" }, CURRENT)).toBeNull();
  });

  describe("guards against a record that only shares the number", () => {
    it("rejects a record of another organization", () => {
      expect(planItemChange(DEAL, { ...CURRENT, bin: "111111111111" })).toBeNull();
    });

    it("takes the deal BIN from the comment when the field is empty", () => {
      expect(planItemChange({ ...DEAL, UF_CRM_6627AEBD7C2D2: "" }, CURRENT)).not.toBeNull();
      expect(planItemChange({ ...DEAL, UF_CRM_6627AEBD7C2D2: "", COMMENTS: "BIN: 222222222222" }, CURRENT)).toBeNull();
    });

    it("rejects a deal whose BIN cannot be checked", () => {
      expect(planItemChange({ ...DEAL, UF_CRM_6627AEBD7C2D2: "", COMMENTS: "" }, CURRENT)).toBeNull();
    });

    it("rejects a version that is older than the deal (an old record with a colliding number)", () => {
      expect(planItemChange(DEAL, { ...CURRENT, createdAt: "2016-03-25 11:14:00" })).toBeNull();
    });

    it("rejects a version from an earlier year than the deal", () => {
      expect(planItemChange(DEAL, { ...CURRENT, year: 2025 })).toBeNull();
    });
  });
});

describe("planItemSync", () => {
  const other: PlanItemDeal = { ...DEAL, ID: "5", ORIGIN_ID: "gz-plan:5", UF_CRM_REF_ENSTRU_CODE: "262011.100.000001", UF_CRM_6A436D5A19612: "262011.100.000001" };

  it("plans updates only for deals whose point changed, and counts the rest", () => {
    const items = new Map<number, CurrentPlanItem>([
      [88137237, CURRENT],
      [5, { ...CURRENT, id: 6, rootId: 5, code: "262011.100.000001", name: "Ноутбук" }]
    ]);

    const plan = planItemSync([DEAL, other, { ...DEAL, ID: "9", ORIGIN_ID: "gz-plan:9" }, { ...DEAL, ID: "10", ORIGIN_ID: "gz-lot:1-ЗЦП1" }], items, new Set([77]));

    expect(plan.updates.map((update) => update.dealId)).toEqual(["48115"]);
    expect(plan.stats).toEqual({ total: 3, willUpdate: 1, alreadyRight: 1, notInRegistry: 1, lookupFailed: 0, skipped: 0 });
  });

  it("counts a record that failed the checks as skipped, not as already right", () => {
    const plan = planItemSync([DEAL], new Map([[88137237, { ...CURRENT, bin: "111111111111" }]]), new Set());

    expect(plan.updates).toEqual([]);
    expect(plan.stats).toMatchObject({ willUpdate: 0, alreadyRight: 0, skipped: 1 });
  });

  it("does not count a deal as missing from the registry when the lookup itself failed", () => {
    const plan = planItemSync([DEAL], new Map(), new Set([88137237]));

    expect(plan.stats).toMatchObject({ notInRegistry: 0, lookupFailed: 1 });
  });
});
