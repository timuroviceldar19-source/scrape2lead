import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";
import { BitrixClient } from "../src/bitrix/client.js";
import {
  GZ_PLAN_DETAILS_FIELD_NAMES,
  GZ_PLAN_DETAILS_SECTION_NAME,
  mergeGzPlanDetailsSection,
  type GzDealLayoutSection
} from "../src/bitrix/gzPlanDealLayout.js";

const CATEGORY_ID = 9;
const execute = process.argv.includes("--execute");
const webhook = (process.env.BITRIX24_WEBHOOK_URL ?? process.env.BITRIX_WEBHOOK_URL ?? "").trim();
if (!webhook) throw new Error("BITRIX24_WEBHOOK_URL is required");

const client = new BitrixClient(webhook);
const request = { scope: "C", extras: { dealCategoryId: CATEGORY_ID } };
const currentRaw = await client.call("crm.deal.details.configuration.get", request);
if (!Array.isArray(currentRaw) || currentRaw.length === 0) {
  throw new Error(`Bitrix returned no custom deal layout for category ${CATEGORY_ID}`);
}

const current = currentRaw as GzDealLayoutSection[];
const next = mergeGzPlanDetailsSection(current);
let backupPath: string | null = null;

if (execute) {
  const backupDir = resolve("runs", "bitrix-layout-backups");
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  backupPath = resolve(backupDir, `deal-category-${CATEGORY_ID}-${timestamp}.json`);
  writeFileSync(backupPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");

  await client.call("crm.deal.details.configuration.set", { ...request, data: next });
}

const savedRaw = execute
  ? await client.call("crm.deal.details.configuration.get", request)
  : next;
const saved = Array.isArray(savedRaw) ? savedRaw as GzDealLayoutSection[] : [];
const visibleFields = new Set(saved.flatMap((section) => (section.elements ?? []).map((element) => element.name)));
const missingFields = GZ_PLAN_DETAILS_FIELD_NAMES.filter((name) => !visibleFields.has(name));

if (execute && missingFields.length > 0) {
  await client.call("crm.deal.details.configuration.set", { ...request, data: current });
  throw new Error(`layout verification failed and was rolled back; missing: ${missingFields.join(", ")}`);
}

const planSection = saved.find((section) => section.name === GZ_PLAN_DETAILS_SECTION_NAME);
console.log(JSON.stringify({
  mode: execute ? "execute" : "dry-run",
  categoryId: CATEGORY_ID,
  backupPath,
  sectionTitle: planSection?.title ?? null,
  addedFields: planSection?.elements.length ?? 0,
  missingFields
}, null, 2));
