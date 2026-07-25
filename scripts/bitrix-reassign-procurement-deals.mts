import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import {
  PROCUREMENT_CATEGORY_ID,
  PROCUREMENT_MANAGER_IDS,
  PROCUREMENT_ORIGINATOR_ID
} from "../src/bitrix/procurementDealPlan.js";
import {
  planProcurementReassignments,
  type ReassignableProcurementDeal
} from "../src/bitrix/procurementReassignment.js";

const execute = process.argv.includes("--execute");
const webhook = (process.env.BITRIX24_WEBHOOK_URL ?? process.env.BITRIX_WEBHOOK_URL ?? "").trim();
if (!webhook) throw new Error("BITRIX24_WEBHOOK_URL is required");

const client = new BitrixClient(webhook);
const select = ["ID", "TITLE", "CATEGORY_ID", "STAGE_ID", "ASSIGNED_BY_ID", "ORIGINATOR_ID", "ORIGIN_ID"];
const deals = await client.listAll("deal", {
  CATEGORY_ID: PROCUREMENT_CATEGORY_ID,
  ORIGINATOR_ID: PROCUREMENT_ORIGINATOR_ID
}, select) as ReassignableProcurementDeal[];
const planned = planProcurementReassignments(deals);

if (execute) {
  for (const item of planned) {
    await client.update("deal", item.dealId, item.fields);
  }
}

const verified = execute
  ? await Promise.all(deals.map(async (deal) =>
    await client.findFirst("deal", { ID: String(deal.ID) }, ["ID", "CATEGORY_ID", "STAGE_ID", "ASSIGNED_BY_ID", "ORIGINATOR_ID"])
  ))
  : [];
const invalidDealIds = execute
  ? verified.map((deal, index) => ({ deal, original: deals[index] }))
    .filter(({ deal }) =>
      !deal ||
      String(deal.CATEGORY_ID ?? "") !== String(PROCUREMENT_CATEGORY_ID) ||
      deal.ORIGINATOR_ID !== PROCUREMENT_ORIGINATOR_ID ||
      String(deal.ASSIGNED_BY_ID ?? "") !== PROCUREMENT_MANAGER_IDS[0]
    )
    .map(({ deal, original }) => String(deal?.ID ?? original?.ID ?? "unknown"))
  : [];
const stageChanges = execute
  ? verified.map((deal, index) => ({ deal, original: deals[index] }))
    .filter(({ deal, original }) => String(deal?.STAGE_ID ?? "") !== String(original?.STAGE_ID ?? ""))
    .map(({ deal, original }) => ({
      dealId: String(deal?.ID ?? original?.ID ?? "unknown"),
      before: original?.STAGE_ID ?? null,
      after: deal?.STAGE_ID ?? null
    }))
  : [];

const report = {
  generatedAt: new Date().toISOString(),
  mode: execute ? "execute" : "dry-run",
  targetAssigneeId: PROCUREMENT_MANAGER_IDS[0],
  matchedDeals: deals.length,
  alreadyAssigned: deals.length - planned.length,
  plannedUpdates: planned.length,
  updatedDeals: execute ? planned.length : 0,
  invalidDealIds,
  stageChanges,
  items: planned
};
const outputDirectory = path.resolve("output/procurement");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, `reassignment-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ ...report, items: undefined, outputPath }, null, 2));

if (execute && (invalidDealIds.length > 0 || stageChanges.length > 0)) process.exitCode = 1;
