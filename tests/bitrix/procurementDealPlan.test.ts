import { describe, expect, it } from "vitest";
import {
  buildProcurementDealDecision,
  procurementOpportunityOriginId,
  verifyProcurementAssignmentGate
} from "../../src/bitrix/procurementDealPlan.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

describe("procurement Bitrix lifecycle", () => {
  it("creates plans in F3-B2B tenders without hardcoded assignee", () => {
    const result = buildProcurementDealDecision(row(), null);
    expect(result.action).toBe("create");
    expect(result.fields).toMatchObject({ CATEGORY_ID: 1, STAGE_ID: "C1:NEW", OPENED: "Y" });
    expect(result.fields).not.toHaveProperty("ASSIGNED_BY_ID");
    expect(result.fields).toMatchObject({
      ORIGINATOR_ID: "scrape2lead-procurement",
      ORIGIN_ID: "proc:mitwork:plan:42"
    });
  });

  it("maps enriched plan and Excel data into visible procurement fields", () => {
    const result = buildProcurementDealDecision(row({
      source: "samruk",
      sourceRecordId: "18121209",
      externalId: "4128263137",
      productName: "Панель интерактивная",
      customerName: "ТОО \"АЭС Шульбинская ГЭС\"",
      customerBin: "970940002871",
      amount: 5_900_000,
      truCode: "262030.100.000021",
      purchaseMethod: "Запрос ценовых предложений",
      url: "https://zakup.gov.kz/plan-items/18121209",
      enrichment: { source: "epz-plan-detail", confidence: "exact" },
      customerProfile: {
        source: "goszakup", website: "https://customer.example", email: "info@example.kz",
        phone: "+7 700 000 00 00", reportingAdministrator: "Администратор", fullAddress: "г. Шульбинск",
        directorName: "Руководитель"
      },
      planDetail: {
        approvedAt: "15-04-2026", financialYear: 2026, nameRu: "Панель интерактивная", nameKk: "Интерактивті панель",
        shortDescriptionRu: "LCD поверхность", shortDescriptionKk: "LCD сыртқы бет", extraDescription: "Диагональ 75 дюймов",
        unitName: "Штука", quantity: 4, unitPrice: 1_475_000, prepaymentPercent: 0,
        deliveryDeadline: "30 календарных дней", itemType: "Товар",
        deliveries: [{ address: "п. Шульбинск", kato: "101065100", quantity: 4 }]
      }
    }), null);

    expect(result.fields).toMatchObject({
      BEGINDATE: "2026-04-15",
      UF_CRM_6627AEBD4503E: "Запрос ценовых предложений",
      UF_CRM_6627AEBD54B8D: "Панель интерактивная",
      UF_CRM_6627AEBD5E68B: "1475000",
      UF_CRM_6627AEBD67FFF: "4",
      UF_CRM_6627AEBD72587: "ТОО \"АЭС Шульбинская ГЭС\"",
      UF_CRM_6627AEBD7C2D2: "970940002871",
      UF_CRM_6627AEBD85B4D: "Утвержден",
      UF_CRM_1715597423325: "5900000",
      UF_CRM_1782386293000_IU_XLS: "18121209",
      UF_CRM_1782386571874_IU_XLS: "https://zakup.gov.kz/plan-items/18121209",
      UF_CRM_PLAN_ID: "18121209",
      UF_CRM_TRADE_METHOD: "2026",
      UF_CRM_POINT_TYPE: "plan",
      UF_CRM_REF_ENSTRU_CODE: "262030.100.000021",
      UF_CRM_REF_SUBJECT_TYPE_NAME: "Товар",
      UF_CRM_ENSTRU_NAME: "Панель интерактивная",
      UF_CRM_DESC_RU: "LCD поверхность",
      UF_CRM_DESC_KZ: "LCD сыртқы бет",
      UF_CRM_EXTRA_DESC_RU: "Диагональ 75 дюймов",
      UF_CRM_UNIT_NAME: "Штука",
      UF_CRM_COUNT: "4",
      UF_CRM_PRICE_PER_UNIT: "1475000|KZT",
      UF_CRM_PREPAYMENT: "0",
      UF_CRM_SUPPLY_DATE: "30 календарных дней",
      UF_CRM_DELIVERY_ADDRESSES: "п. Шульбинск",
      UF_CRM_PLAN_STATUS: "Утвержден",
      UF_CRM_PLAN_LINK: "https://zakup.gov.kz/plan-items/18121209",
      UF_CRM_6A436D598EC82: "Администратор",
      UF_CRM_6A436D59AACBF: "г. Шульбинск",
      UF_CRM_6A436D59CD2B1: "Руководитель",
      UF_CRM_6A436D5A19612: "262030.100.000021",
      UF_CRM_6A436D5A3614C: "4128263137",
      UF_CRM_6A436D5A76648: "LCD поверхность",
      UF_CRM_6A436D5A92D16: "Диагональ 75 дюймов",
      UF_CRM_6A436D5AD0A2B: "п. Шульбинск"
    });
    expect(String(result.fields.COMMENTS)).toContain("КАТО: 101065100");
    expect(String(result.fields.COMMENTS)).toContain("E-mail: info@example.kz");
    expect(String(result.fields.COMMENTS)).toContain("Источник обогащения: epz-plan-detail (exact)");
  });

  it("updates the linked plan when its tender is published without resetting manual stage", () => {
    const tender = row({ recordKind: "tender", externalId: "lot-9", parentExternalId: "42", status: "Опубликован" });
    const result = buildProcurementDealDecision(tender, {
      ID: "500", CATEGORY_ID: "1", STAGE_ID: "C1:UC_XMKT7F", ASSIGNED_BY_ID: "2015"
    });
    expect(result.action).toBe("update");
    expect(result.dealId).toBe("500");
    expect(result.fields).not.toHaveProperty("STAGE_ID");
    expect(result.fields).not.toHaveProperty("ASSIGNED_BY_ID");
    expect(result.fields).toMatchObject({ CATEGORY_ID: 1, OPENED: "Y" });
  });

  it("passes the distribution gate only for the configured manager pool", () => {
    expect(procurementOpportunityOriginId(row({ sourceRecordId: "42", externalId: "MTW-42" })))
      .toBe(procurementOpportunityOriginId(row({ recordKind: "tender", externalId: "lot-9", parentExternalId: "42" })));

    expect(verifyProcurementAssignmentGate([
      { ID: "1", ASSIGNED_BY_ID: "147" },
      { ID: "2", ASSIGNED_BY_ID: "1751" },
      { ID: "3", ASSIGNED_BY_ID: "725" }
    ])).toEqual({ ok: true, invalidDealIds: [] });
    expect(verifyProcurementAssignmentGate([
      { ID: "1", ASSIGNED_BY_ID: "2015" },
      { ID: "2", ASSIGNED_BY_ID: "2209" },
      { ID: "3", ASSIGNED_BY_ID: "2255" },
      { ID: "4", ASSIGNED_BY_ID: "2301" },
      { ID: "5", ASSIGNED_BY_ID: "205" }
    ])).toEqual({ ok: false, invalidDealIds: ["1", "2", "3", "4", "5"] });
  });
});

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return {
    source: "mitwork", recordKind: "plan", sourceRecordId: null, externalId: "42", parentExternalId: null,
    status: "Утвержден", productName: "Ноутбук", description: "16 GB", truCode: "262011.100.000002",
    customerName: "Customer", customerBin: "123456789012", amount: 1_000_000, currency: "KZT",
    startDate: null, endDate: null, url: "https://example.kz/42", purchaseMethod: "ЗЦП",
    collectedAt: "2026-07-21T00:00:00.000Z", ...overrides
  };
}
