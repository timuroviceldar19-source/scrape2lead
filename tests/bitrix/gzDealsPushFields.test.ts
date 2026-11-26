import { describe, expect, it } from "vitest";
import { buildDealGzFields, type GzPlanRow } from "../../scripts/bitrix-push-gz-deals.mjs";

const TENDER_STATUS_FIELD = "UF_CRM_1705406174976";

function makeRow(overrides: Partial<GzPlanRow> = {}): GzPlanRow {
  return {
    rowNumber: 2,
    bin: "081140002412",
    customerName: "КГКП «Детская школа искусств «Жұлдыз»",
    website: "",
    email: "",
    phone: "",
    reportingAdministrator: "",
    address: "",
    directorName: "",
    truCode: "262013.000.000012",
    itemName: "Компьютер",
    itemUrl: "",
    unit: "Комплект",
    quantity: "3",
    price: "605000.00",
    extraSpec: "",
    keyword: "Моноблок",
    planNumber: "88080436",
    planId: "88080436",
    plannedMonth: "Октябрь",
    status: "На проверке камерального контроля",
    amount: "1815000.00",
    purchaseMethod: "Электронный магазин",
    customerUrl: "",
    planUrl: "https://procurement.gov.kz/ru/registry/show_plan/88080436/4898162",
    shortSpec: "",
    extraDescription: "",
    deliveryPlace: "",
    ...overrides
  };
}

describe("buildDealGzFields", () => {
  it("leaves the tender status to the manager: a fresh plan is not a won tender", () => {
    expect(buildDealGzFields(makeRow())).not.toHaveProperty(TENDER_STATUS_FIELD);
  });

  it("still carries the plan data the card shows", () => {
    expect(buildDealGzFields(makeRow())).toMatchObject({
      UF_CRM_6627AEBD54B8D: "Компьютер",
      UF_CRM_6627AEBD67FFF: "3",
      UF_CRM_6627AEBD85B4D: "На проверке камерального контроля",
      UF_CRM_1715597726664: "Октябрь",
      UF_CRM_6627AEBD4503E: "Электронный магазин"
    });
  });
});
