import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import { ReadOnlyBitrixClient } from "../src/bitrix/reporting/readOnlyClient.js";
import {
  computeActivityMetrics,
  type ActivityDealInput,
  type RawActivity
} from "../src/bitrix/reporting/activityMetrics.js";

const SALES_PIPELINE_IDS = [9, 41, 43];
const STALE_AFTER_DAYS = 14;
const LOST_WINDOW_MONTHS = 6;
const LOST_SAMPLE_LIMIT = 1500;
const DEAL_SELECT = ["ID", "CATEGORY_ID", "STAGE_ID", "DATE_CREATE", "ASSIGNED_BY_ID"];
const ACTIVITY_SELECT = ["ID", "OWNER_ID", "OWNER_TYPE_ID", "CREATED", "COMPLETED", "RESPONSIBLE_ID", "TYPE_ID"];

interface RawDealRow {
  ID: string;
  CATEGORY_ID: string | number;
  DATE_CREATE: string;
  ASSIGNED_BY_ID?: string | number;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function toDealInput(row: RawDealRow, isOpen: boolean): ActivityDealInput {
  return {
    id: String(row.ID),
    pipelineId: Number(row.CATEGORY_ID),
    createdAt: row.DATE_CREATE,
    isOpen,
    managerId: String(row.ASSIGNED_BY_ID ?? "0")
  };
}

function sampleEvenly<T>(rows: T[], limit: number): T[] {
  if (rows.length <= limit) return rows;
  const step = rows.length / limit;
  return Array.from({ length: limit }, (_, index) => rows[Math.floor(index * step)]);
}

// Fetching per-deal (filter by 50 OWNER_IDs) is pathologically slow on the Bitrix
// side, so pull every deal-owned activity in one linear batched pass and join
// against the audited deals in memory (computeActivityMetrics drops unknown ids).
async function listAllDealActivities(client: ReadOnlyBitrixClient): Promise<RawActivity[]> {
  return client.listAllBatched<RawActivity>("crm.activity.list", {
    order: { ID: "ASC" },
    filter: { OWNER_TYPE_ID: 2 },
    select: ACTIVITY_SELECT
  }, undefined, 20);
}

const asOfDate = arg("--as-of") ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error("--as-of must use YYYY-MM-DD");
const outputDir = resolve(arg("--output") ?? `exports/bitrix-b2g-${asOfDate}`);
const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
if (!webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

const lostWindowFrom = new Date(`${asOfDate}T00:00:00+03:00`);
lostWindowFrom.setMonth(lostWindowFrom.getMonth() - LOST_WINDOW_MONTHS);
const lostFromDate = lostWindowFrom.toISOString().slice(0, 10);

const transport = new BitrixClient(webhookUrl, { requestDelayMs: 550, maxRetries: 5 });
const client = new ReadOnlyBitrixClient(transport);

const openRows = await client.listAllBatched<Record<string, unknown>>("crm.deal.list", {
  order: { ID: "ASC" },
  filter: { CATEGORY_ID: SALES_PIPELINE_IDS, STAGE_SEMANTIC_ID: "P" },
  select: DEAL_SELECT
}) as unknown as RawDealRow[];
console.error(`open deals: ${openRows.length}`);

const lostRows = await client.listAllBatched<Record<string, unknown>>("crm.deal.list", {
  order: { ID: "ASC" },
  filter: { CATEGORY_ID: SALES_PIPELINE_IDS, STAGE_SEMANTIC_ID: "F", ">=CLOSEDATE": lostFromDate },
  select: DEAL_SELECT
}) as unknown as RawDealRow[];
console.error(`lost deals in window since ${lostFromDate}: ${lostRows.length}`);

const lostSample = sampleEvenly(lostRows, LOST_SAMPLE_LIMIT);
const deals: ActivityDealInput[] = [
  ...openRows.map((row) => toDealInput(row, true)),
  ...lostSample.map((row) => toDealInput(row, false))
];

const activities = await listAllDealActivities(client);
console.error(`activities fetched: ${activities.length}`);

const metrics = computeActivityMetrics(deals, activities, {
  asOf: `${asOfDate}T23:59:59+03:00`,
  staleAfterDays: STALE_AFTER_DAYS
});

await mkdir(outputDir, { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  asOfDate,
  scope: {
    salesPipelineIds: SALES_PIPELINE_IDS,
    openDeals: openRows.length,
    lostDealsInWindow: lostRows.length,
    lostSampleSize: lostSample.length,
    lostWindowFrom: lostFromDate,
    activitiesFetched: activities.length
  },
  metrics
};
await writeFile(join(outputDir, "activity-metrics.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputDir, scope: payload.scope, abandonedOpenDeals: metrics.abandonedOpenDeals }, null, 2));
