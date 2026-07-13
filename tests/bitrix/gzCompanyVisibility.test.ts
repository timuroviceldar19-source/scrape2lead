import { describe, expect, it } from "vitest";
import {
  buildCompanyFields as buildPlanCompanyFields,
  type GzPlanRow
} from "../../scripts/bitrix-push-gz-deals.mjs";
import { buildCompanyFields as buildLotCompanyFields } from "../../scripts/bitrix-push-gz-lots.mjs";

function makePlanRow(): GzPlanRow {
  return {
    rowNumber: 2,
    bin: "123456789012",
    customerName: "Test customer",
    website: "",
    email: "",
    phone: "",
    reportingAdministrator: "",
    address: "",
    directorName: "",
    truCode: "262020.300.000043",
    itemName: "Computer",
    itemUrl: "",
    unit: "Piece",
    quantity: "1",
    price: "500000",
    extraSpec: "",
    keyword: "Computer",
    planNumber: "123456",
    planId: "987654",
    plannedMonth: "09.2026",
    status: "Approved",
    amount: "500000",
    purchaseMethod: "Open competition",
    customerUrl: "",
    planUrl: "",
    shortSpec: "",
    extraDescription: "",
    deliveryPlace: ""
  };
}

describe("GZ company visibility", () => {
  it("marks a company created from a plan as available to everyone", () => {
    const fields = buildPlanCompanyFields(makePlanRow(), 2301);

    expect(fields.OPENED).toBe("Y");
  });

  it("marks a company created from a lot as available to everyone", () => {
    const fields = buildLotCompanyFields(
      {
        bin: "123456789012",
        name: "Test customer",
        legalAddress: "Test address"
      },
      "gz-company:123456789012",
      2301
    );

    expect(fields.OPENED).toBe("Y");
  });
});
