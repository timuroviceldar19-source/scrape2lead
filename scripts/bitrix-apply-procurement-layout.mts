import "dotenv/config";
import { BitrixClient } from "../src/bitrix/client.js";
import { buildProcurementDealConfiguration } from "../src/bitrix/procurementDealLayout.js";
import { planProcurementUserFields } from "../src/bitrix/procurementUserFields.js";

const execute = process.argv.includes("--execute");
const webhook = (process.env.BITRIX24_WEBHOOK_URL ?? process.env.BITRIX_WEBHOOK_URL ?? "").trim();
if (!webhook) throw new Error("BITRIX24_WEBHOOK_URL is required");

const client = new BitrixClient(webhook);
const data = buildProcurementDealConfiguration();

// Раскладка ссылается на поля по имени, поэтому недостающие создаём до её применения.
const existingFields = await client.call("crm.deal.userfield.list", { order: { SORT: "ASC" } });
const existingFieldNames = (Array.isArray(existingFields) ? existingFields as Array<{ FIELD_NAME?: string }> : [])
  .map((field) => field.FIELD_NAME ?? "");
const userFieldPlan = planProcurementUserFields(existingFieldNames);

if (execute) {
  for (const item of userFieldPlan.filter((field) => field.action === "create")) {
    await client.call("crm.deal.userfield.add", { fields: item.fields });
  }
}

if (execute) {
  await client.call("crm.deal.details.configuration.set", {
    scope: "C",
    extras: { dealCategoryId: 1 },
    data
  });
}

const saved = execute
  ? await client.call("crm.deal.details.configuration.get", {
    scope: "C",
    extras: { dealCategoryId: 1 }
  })
  : data;
const sections = Array.isArray(saved) ? saved as Array<{ elements?: Array<{ name?: string }> }> : [];
const fields = sections.flatMap((section) => section.elements ?? []).map((field) => field.name);

console.log(JSON.stringify({
  mode: execute ? "execute" : "dry-run",
  userFields: userFieldPlan.map((item) => ({ field: item.fieldName, action: item.action })),
  sections: sections.length,
  hasPlanApprovedAt: fields.includes("UF_CRM_PLAN_APPROVED_AT"),
  hasOfferWindow: fields.includes("BEGINDATE") && fields.includes("CLOSEDATE"),
  hasPlanNumber: fields.includes("UF_CRM_1782386293000_IU_XLS"),
  hasTechnicalPlanId: fields.includes("UF_CRM_PLAN_ID"),
  hasPlanLink: fields.includes("UF_CRM_PLAN_LINK")
}, null, 2));
