import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import { ReadOnlyBitrixClient } from "../src/bitrix/reporting/readOnlyClient.js";
import { fetchPlanStatusBatch } from "../src/kz/goszakupPlanStatusApi.js";
import {
  GZ_REFRESH_DEAL_SELECT,
  GZ_REFRESH_PIPELINE_IDS,
  GZ_REFRESH_PLAN_NUMBER_FIELD,
  formatReportLines,
  runPlanStatusRefresh,
  type RefreshDeal
} from "../src/bitrix/gzPlanStatusRefresh.js";
import { createBatchDealUpdater } from "../src/bitrix/gzPlanStatusWriter.js";

const REPORT_DIR = join("runs", "gz-plan-status");

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
  const token = process.env.GOSZAKUP_TOKEN?.trim();
  if (!webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");
  if (!token) throw new Error("GOSZAKUP_TOKEN is required");

  const reader = new ReadOnlyBitrixClient(new BitrixClient(webhookUrl, { requestDelayMs: 550, maxRetries: 5 }));
  const updateDeals = createBatchDealUpdater(webhookUrl);

  const report = await runPlanStatusRefresh(
    {
      listDeals: async () => {
        const allDeals: Array<RefreshDeal & Record<string, unknown>> = [];
        for (const categoryId of GZ_REFRESH_PIPELINE_IDS) {
          console.error(`Fetching open deals from Bitrix (category ${categoryId})...`);
          const deals = await reader.listAllBatched<RefreshDeal & Record<string, unknown>>("crm.deal.list", {
            order: { ID: "ASC" },
            filter: {
              CLOSED: "N",
              CATEGORY_ID: categoryId,
              [`!${GZ_REFRESH_PLAN_NUMBER_FIELD}`]: ""
            },
            select: [...GZ_REFRESH_DEAL_SELECT]
          });
          console.error(`Fetched ${deals.length} deals in category ${categoryId}.`);
          allDeals.push(...deals);
        }
        return allDeals;
      },
      fetchStatuses: (planNumbers) => fetchPlanStatusBatch(planNumbers, { token }),
      writeUpdates: updateDeals,
      now: () => new Date()
    },
    { execute }
  );

  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = join(REPORT_DIR, `${report.date}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  for (const line of formatReportLines(report)) console.log(line);
  console.log(`report=${reportPath}`);
  if (report.errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
