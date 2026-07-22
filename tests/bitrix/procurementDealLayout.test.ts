import { describe, expect, it } from "vitest";
import { buildProcurementDealConfiguration } from "../../src/bitrix/procurementDealLayout.js";

describe("F3-B2B procurement deal layout", () => {
  it("shows procurement data and removes unrelated sales and test sections", () => {
    const sections = buildProcurementDealConfiguration();
    expect(sections.map((section) => section.title)).toEqual([
      "О закупке", "Заказчик", "Параметры закупки", "Товар и характеристики", "Поставка", "Служебное"
    ]);
    const fieldNames = sections.flatMap((section) => section.elements.map((element) => element.name));
    expect(fieldNames).toEqual(expect.arrayContaining([
      "UF_CRM_6627AEBD72587", "UF_CRM_6627AEBD7C2D2", "UF_CRM_PLAN_STATUS", "UF_CRM_PLAN_LINK",
      "UF_CRM_REF_ENSTRU_CODE", "UF_CRM_ENSTRU_NAME", "UF_CRM_COUNT", "UF_CRM_PRICE_PER_UNIT",
      "UF_CRM_DELIVERY_ADDRESSES", "ASSIGNED_BY_ID", "COMMENTS"
    ]));
    expect(fieldNames).not.toEqual(expect.arrayContaining(["TYPE_ID", "SOURCE_ID", "UTM", "CLIENT"]));
    expect(sections.some((section) => /Техническое заключение|Тестовый раздел/i.test(section.title))).toBe(false);
    expect(sections[0]?.elements.find((element) => element.name === "OPPORTUNITY_WITH_CURRENCY")?.options)
      .toEqual({ isPayButtonVisible: "false", isPaymentDocumentsVisible: "false" });
  });
});
