import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import { ReadOnlyBitrixClient } from "../src/bitrix/reporting/readOnlyClient.js";
import { chunkPlanNumbers, fetchPlanStatusBatch } from "../src/kz/goszakupPlanStatusApi.js";
import { GzPlanLookup, type GzPlanContext } from "../src/kz/zakupGzPlans.js";
import { PortalPlanVerifier } from '../src/kz/goszakupPlanRegistry.js';
import { fullEnstruCodes } from "../src/kz/zakupGzRegistry.js";
import {
  GZ_REFRESH_DEAL_SELECT,
  GZ_REFRESH_PIPELINE_IDS,
  GZ_REFRESH_PLAN_NUMBER_FIELD,
  buildReportFilename,
  formatReportLines,
  parseCliArgs,
  planStatusContextOf,
  runPlanStatusRefresh,
  type RefreshDeal
} from "../src/bitrix/gzPlanStatusRefresh.js";
import { createBatchDealUpdater } from "../src/bitrix/gzPlanStatusWriter.js";

const REPORT_DIR = join("runs", "gz-plan-status");

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
  const token = process.env.GOSZAKUP_TOKEN?.trim();
  if (!webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");
  const contexts = new Map<number, GzPlanContext>();
  const lookup = new GzPlanLookup({ token, contexts, maxFullScans: cli.maxFullScans });
  const versions = new Map<string, number>();
  const portal = new PortalPlanVerifier();
  const missingContextDeals = new Set<string>();

  const reader = new ReadOnlyBitrixClient(new BitrixClient(webhookUrl, { requestDelayMs: 550, maxRetries: 5 }));
  const updateDeals = createBatchDealUpdater(webhookUrl);

  const report = await runPlanStatusRefresh(
    {
      listDeals: async () => {
        const allDeals: Array<RefreshDeal & Record<string, unknown>> = [];
        for (const categoryId of GZ_REFRESH_PIPELINE_IDS) {
          const filter: Record<string, unknown> = {
            CLOSED: "N",
            CATEGORY_ID: categoryId,
            [`!${GZ_REFRESH_PLAN_NUMBER_FIELD}`]: ""
          };
          if (cli.dealId) filter.ID = cli.dealId;
          console.error(`Fetching open deals from Bitrix (category ${categoryId})...`);
          const deals = await reader.listAllBatched<RefreshDeal & Record<string, unknown>>("crm.deal.list", {
            order: { ID: "ASC" },
            filter,
            select: [...GZ_REFRESH_DEAL_SELECT, "DATE_CREATE", "UF_CRM_6627AEBD7C2D2", "COMPANY_ID", "UF_CRM_REF_ENSTRU_CODE", "UF_CRM_6A436D5A19612", "ORIGIN_ID", "UF_CRM_PLAN_LINK"]
          });
          console.error(`Fetched ${deals.length} deals in category ${categoryId}.`);
          allDeals.push(...deals);
          if (cli.dealId && allDeals.length > 0) break;
        }
        const companyBins = new Map<string, string>();
        const companyIds = [...new Set(allDeals.filter(deal => !/^\d{12}$/.test(String(deal.UF_CRM_6627AEBD7C2D2 ?? "")))
          .map(deal => String(deal.COMPANY_ID ?? "")).filter(id => /^[1-9]\d*$/.test(id)))];
        for (const ids of chunkPlanNumbers(companyIds)) {
          const companies = await reader.call("crm.company.list", { filter: { ID: ids }, select: ["ID", "UF_CRM_666171B20E9E3"], start: -1 });
          if (!Array.isArray(companies)) throw new Error("crm.company.list: expected an array");
          for (const company of companies) {
            const bin = String(company.UF_CRM_666171B20E9E3 ?? "").replace(/\D/g, "");
            if (ids.includes(String(company.ID)) && /^\d{12}$/.test(bin)) companyBins.set(String(company.ID), bin);
          }
        }
        for (const deal of allDeals) {
          const context = planStatusContextOf(deal, companyBins);
          if (context) contexts.set(Number(deal.UF_CRM_PLAN_ID), context);
          else missingContextDeals.add(String(deal.ID));
        }
        console.log(`lookup_input=${JSON.stringify({ deals: allDeals.length, without_enstru: allDeals.filter(deal => !fullEnstruCodes(deal.UF_CRM_REF_ENSTRU_CODE, deal.UF_CRM_6A436D5A19612).length).length,
          without_verified_context: missingContextDeals.size })}`);
        return allDeals;
      },
      fetchStatuses: async (planNumbers) => {
        const result = await fetchPlanStatusBatch(planNumbers, { token, contexts, lookup });
        for (const [number, version] of result.versions ?? []) versions.set(number, version);
        return result;
      },
      verifyUpdate: update => portal.verify(Number(update.planNumber), versions.get(update.planNumber) ?? null,
        row => row.status?.trim().toLocaleLowerCase('ru') === update.to.trim().toLocaleLowerCase('ru')),
      skipReason: deal => missingContextDeals.has(String(deal.ID)) ? 'no_bin' : null,
      writeUpdates: updateDeals,
      now: () => new Date()
    },
    { execute: cli.execute, limit: cli.limit, dealId: cli.dealId }
  );

  await mkdir(REPORT_DIR, { recursive: true });
  const filename = buildReportFilename(report.date, { dealId: report.dealId, limit: report.limit });
  const reportPath = join(REPORT_DIR, filename);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  for (const line of formatReportLines(report)) console.log(line);
  console.log(`report=${reportPath}`);
  console.log(`lookup_stats=${JSON.stringify({ full_scan_limit: cli.maxFullScans ?? 2, full_scan_skipped_plans: lookup.fullScanSkippedPlans.size,
    full_scan_skipped_customers: lookup.fullScanSkippedBins.size, full_scan_plans_attempted: lookup.fullScanPlans.size,
    full_scan_customers: lookup.fullScanBins.size, plan_sources: Object.fromEntries(["q", "enstru", "lots", "full", "ows"].map(path => [path, [...lookup.planSources.values()].filter(value => value === path).length])) })}`);
  if (report.errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
