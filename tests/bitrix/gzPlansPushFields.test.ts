import { describe, expect, it } from "vitest";
import {
  buildLeadFields,
  formatMoneyForBitrixRobot,
  type GzPlanRow
} from "../../scripts/bitrix-push-gz-plans.mjs";

function makeRow(overrides: Partial<GzPlanRow> = {}): GzPlanRow {
  return {
    rowNumber: 2,
    bin: "123456789012",
    customerName: "Test customer",
    website: "",
    email: "buyer@example.test",
    phone: "",
    reportingAdministrator: "",
    address: "",
    directorName: "",
    planDate: "",
    truCode: "262020.300.000043",
    itemName: "Компьютер",
    itemUrl: "",
    unit: "Комплект",
    quantity: "10",
    price: "495000.00",
    extraSpec: "",
    keyword: "Компьютер персональный",
    planNumber: "123456",
    planId: "987654",
    plannedMonth: "09.2026",
    status: "Утвержден",
    amount: "4 950 000.00",
    purchaseMethod: "Открытый конкурс",
    customerUrl: "",
    planUrl: "https://goszakup.gov.kz/ru/registry/show_plan/123456/987654",
    shortSpec: "",
    extraDescription: "",
    deliveryPlace: "",
    ...overrides
  };
}

describe("formatMoneyForBitrixRobot", () => {
  it.each([
    ["4 950 000.00", "4950000.00"],
    ["4 950 000,00", "4950000.00"],
    ["4,950,000.00", "4950000.00"],
    ["4950000.00", "4950000.00"]
  ])("formats %s as %s", (input, expected) => {
    expect(formatMoneyForBitrixRobot(input)).toBe(expected);
  });

  it("returns an empty string for invalid money text", () => {
    expect(formatMoneyForBitrixRobot("not money")).toBe("");
  });
});

describe("buildLeadFields", () => {
  it("sends robot-safe planned amount text while keeping numeric opportunity", () => {
    const fields = buildLeadFields(makeRow(), 42, {
      amount: "UF_CRM_S2L_GZ_AMOUNT"
    });

    expect(fields.UF_CRM_S2L_GZ_AMOUNT).toBe("4950000.00");
    expect(fields.OPPORTUNITY).toBe(4950000);
    expect(fields.ASSIGNED_BY_ID).toBe(42);
    expect(fields.ORIGIN_ID).toBe("gz-plan:123456");
  });
});
