import { describe, expect, it } from "vitest";
import { planProcurementUserFields, PROCUREMENT_USER_FIELDS } from "../../src/bitrix/procurementUserFields.js";

describe("procurement deal user fields", () => {
  it("declares the plan approval date as a date field", () => {
    expect(PROCUREMENT_USER_FIELDS).toEqual([expect.objectContaining({
      FIELD_NAME: "UF_CRM_PLAN_APPROVED_AT", USER_TYPE_ID: "date"
    })]);
  });

  it("plans a create for a field the portal does not have yet", () => {
    expect(planProcurementUserFields(["UF_CRM_PLAN_STATUS"])).toEqual([
      expect.objectContaining({ fieldName: "UF_CRM_PLAN_APPROVED_AT", action: "create" })
    ]);
  });

  it("is idempotent: an existing field is left untouched", () => {
    expect(planProcurementUserFields(["UF_CRM_PLAN_APPROVED_AT"])).toEqual([
      expect.objectContaining({ fieldName: "UF_CRM_PLAN_APPROVED_AT", action: "exists" })
    ]);
  });
});
