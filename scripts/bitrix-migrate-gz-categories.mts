import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { BitrixClient } from "../src/bitrix/client.js";
import { cellText } from "../src/bitrix/xlsxRowReader.js";
import { GZ_ORIGINATOR_ID } from "../src/bitrix/gzLeadCleanup.js";
import {
  loadGzRoutingConfig,
  resolveGzRoute,
  type GzRoutingConfig
} from "../src/bitrix/gzDealRouting.js";

dotenv.config();

const SOURCE_CATEGORY_ID = 41;
const TRU_CODE_FIELD = "UF_CRM_6A436D5A19612";
const TRU_CODE_FALLBACK_FIELD = "UF_CRM_REF_ENSTRU_CODE";
const ITEM_NAME_FIELD = "UF_CRM_6627AEBD54B8D";
/** Closed/service stage suffixes that must never be moved. */
const FROZEN_STAGE_SUFFIXES = new Set(["WON", "LOSE", "APOLOGY", "DUPLICATE", "UC_2B9SSK"]);

interface CliArgs {
  execute: boolean;
  limit: number | null;
  webhookUrl: string | null;
  routingPath: string;
  reportPath: string | null;
  /** Directory with historical gz-plans XLSX exports used to backfill missing tru codes by plan id. */
  truFromXlsxDir: string | null;
}

const USAGE = `Usage: tsx scripts/bitrix-migrate-gz-categories.mts [--execute] [--limit <n>] [--routing <path>] [--report <path>]

Re-routes existing GZ deals from category ${SOURCE_CATEGORY_ID} (B2G - Панели) to the pipeline
dictated by config/bitrix-gz-routing.json (ENSTRU code / keywords). Closed and
service stages are never touched. Dry-run by default.`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    execute: false,
    limit: null,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    routingPath: "config/bitrix-gz-routing.json",
    reportPath: null,
    truFromXlsxDir: null
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--limit") {
      const parsed = Number.parseInt(argv[++i] ?? "", 10);
      args.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } else if (arg === "--routing") args.routingPath = argv[++i] ?? args.routingPath;
    else if (arg === "--report") args.reportPath = argv[++i] ?? null;
    else if (arg === "--tru-from-xlsx") args.truFromXlsxDir = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return args;
}

interface MigrationItem {
  dealId: string;
  title: string;
  truCode: string;
  currentStageId: string;
  targetCategoryId: number;
  targetStageId: string;
  ruleName: string;
  decision: "move" | "keep" | "frozen-stage" | "no-tru-code";
}

function stageSuffix(stageId: string): string {
  return stageId.replace(/^C\d+:/, "");
}

/**
 * Old XLS-imported deals carry no tru-code UF fields, but our historical
 * gz-plans XLSX exports do: column 19 = plan point id (API), column 10 = tru
 * code. Builds a planId -> truCode map from every gz-plans*.xlsx in the dir.
 */
async function buildTruCodeMapFromExports(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const files = fs.readdirSync(dir).filter((name) => /^gz-plans.*\.xlsx$/i.test(name));
  for (const name of files) {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(path.join(dir, name));
      const worksheet = workbook.worksheets[0];
      if (!worksheet) continue;
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const planId = cellText(row.getCell(19));
        const truCode = cellText(row.getCell(10));
        if (planId && truCode && !map.has(planId)) map.set(planId, truCode);
      });
    } catch (error) {
      console.warn(`[tru-from-xlsx] skipped ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`tru-from-xlsx: files=${files.length} plan_ids=${map.size}`);
  return map;
}

async function resolveTargetStage(
  client: BitrixClient,
  targetCategoryId: number,
  currentStageId: string,
  targetStageCache: Map<number, Set<string>>,
  defaultStageId: string
): Promise<string> {
  if (!targetStageCache.has(targetCategoryId)) {
    const statuses = await client.call("crm.status.list", {
      filter: { ENTITY_ID: `DEAL_STAGE_${targetCategoryId}` }
    }) as Array<{ STATUS_ID: string }>;
    targetStageCache.set(targetCategoryId, new Set(statuses.map((status) => status.STATUS_ID)));
  }
  const candidate = `C${targetCategoryId}:${stageSuffix(currentStageId)}`;
  return targetStageCache.get(targetCategoryId)!.has(candidate) ? candidate : defaultStageId;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) {
    throw new Error("Bitrix webhook URL is required: set BITRIX24_WEBHOOK_URL or pass --webhook-url");
  }
  const routing: GzRoutingConfig = loadGzRoutingConfig(args.routingPath);
  const client = new BitrixClient(args.webhookUrl);

  console.log(`gz category migration: mode=${args.execute ? "execute" : "dry-run"} source_category=${SOURCE_CATEGORY_ID}${args.limit ? ` limit=${args.limit}` : ""}`);

  const truByPlanId = args.truFromXlsxDir
    ? await buildTruCodeMapFromExports(args.truFromXlsxDir)
    : new Map<string, string>();

  const deals = await client.listAll(
    "deal",
    { ORIGINATOR_ID: GZ_ORIGINATOR_ID, CATEGORY_ID: SOURCE_CATEGORY_ID },
    ["ID", "TITLE", "STAGE_ID", "CATEGORY_ID", "ORIGIN_ID", TRU_CODE_FIELD, TRU_CODE_FALLBACK_FIELD, ITEM_NAME_FIELD]
  );
  console.log(`deals in category ${SOURCE_CATEGORY_ID} with originator ${GZ_ORIGINATOR_ID}: ${deals.length}`);

  const targetStageCache = new Map<number, Set<string>>();
  const items: MigrationItem[] = [];

  for (const deal of deals) {
    const dealId = String(deal.ID ?? "");
    const currentStageId = String(deal.STAGE_ID ?? "");
    const planId = String(deal.ORIGIN_ID ?? "").replace(/^gz-plan:/, "");
    const truCode = String(deal[TRU_CODE_FIELD] ?? "").trim()
      || String(deal[TRU_CODE_FALLBACK_FIELD] ?? "").trim()
      || (planId ? truByPlanId.get(planId) ?? "" : "");
    const itemName = String(deal[ITEM_NAME_FIELD] ?? "").trim();
    const base = {
      dealId,
      title: String(deal.TITLE ?? ""),
      truCode,
      currentStageId
    };

    if (FROZEN_STAGE_SUFFIXES.has(stageSuffix(currentStageId))) {
      items.push({ ...base, targetCategoryId: SOURCE_CATEGORY_ID, targetStageId: currentStageId, ruleName: "-", decision: "frozen-stage" });
      continue;
    }
    if (!truCode) {
      items.push({ ...base, targetCategoryId: SOURCE_CATEGORY_ID, targetStageId: currentStageId, ruleName: "-", decision: "no-tru-code" });
      continue;
    }

    const route = resolveGzRoute({ truCode, itemName }, routing);
    if (route.categoryId === SOURCE_CATEGORY_ID) {
      items.push({ ...base, targetCategoryId: route.categoryId, targetStageId: currentStageId, ruleName: route.ruleName, decision: "keep" });
      continue;
    }

    const targetStageId = await resolveTargetStage(client, route.categoryId, currentStageId, targetStageCache, route.stageId);
    items.push({ ...base, targetCategoryId: route.categoryId, targetStageId, ruleName: route.ruleName, decision: "move" });
  }

  const toMove = items.filter((item) => item.decision === "move");
  const limited = args.limit ? toMove.slice(0, args.limit) : toMove;
  const counts = {
    total: items.length,
    move: toMove.length,
    keep: items.filter((item) => item.decision === "keep").length,
    frozen: items.filter((item) => item.decision === "frozen-stage").length,
    noTruCode: items.filter((item) => item.decision === "no-tru-code").length,
    moved: 0,
    failed: 0
  };

  for (const item of limited) {
    if (!args.execute) {
      console.log(`[dry-run] deal ${item.dealId} ${item.currentStageId} -> cat ${item.targetCategoryId} ${item.targetStageId} (${item.ruleName}) | ${item.truCode}`);
      continue;
    }
    try {
      await client.update("deal", item.dealId, {
        CATEGORY_ID: item.targetCategoryId,
        STAGE_ID: item.targetStageId
      });
      counts.moved += 1;
      console.log(`[moved] deal ${item.dealId} -> cat ${item.targetCategoryId} ${item.targetStageId} (${item.ruleName})`);
    } catch (error) {
      counts.failed += 1;
      console.error(`[failed] deal ${item.dealId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (args.reportPath) {
    fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
    fs.writeFileSync(args.reportPath, JSON.stringify({ mode: args.execute ? "execute" : "dry-run", counts, items }, null, 2), "utf8");
    console.log(`report=${args.reportPath}`);
  }

  console.log(`summary: total=${counts.total} move=${counts.move} keep=${counts.keep} frozen=${counts.frozen} no_tru_code=${counts.noTruCode} moved=${counts.moved} failed=${counts.failed}`);
  if (counts.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
