import "dotenv/config";
import { BitrixClient } from "../src/bitrix/client.js";
import { buildProcurementDealConfiguration } from "../src/bitrix/procurementDealLayout.js";

const execute = process.argv.includes("--execute");
const webhook = (process.env.BITRIX24_WEBHOOK_URL ?? process.env.BITRIX_WEBHOOK_URL ?? "").trim();
if (!webhook) throw new Error("BITRIX24_WEBHOOK_URL is required");

const client = new BitrixClient(webhook);
const data = buildProcurementDealConfiguration();

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
  sections: sections.length,
  hasPlanNumber: fields.includes("UF_CRM_1782386293000_IU_XLS"),
  hasTechnicalPlanId: fields.includes("UF_CRM_PLAN_ID"),
  hasPlanLink: fields.includes("UF_CRM_PLAN_LINK")
}, null, 2));
