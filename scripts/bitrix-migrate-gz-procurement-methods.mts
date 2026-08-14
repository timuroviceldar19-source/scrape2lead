import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { BitrixClient } from "../src/bitrix/client.js";
import {
  buildProcurementMethodCrmItemUpdate,
  buildProcurementMethodMigrationPlan,
  PROCUREMENT_METHOD_FIELD,
  verifyProcurementMethodMigration,
  type ProcurementMigrationDeal,
  type ProcurementMigrationItem
} from "../src/bitrix/gzProcurementMethodMigration.js";

dotenv.config();

interface CliArgs {
  execute: boolean;
  limit: number | null;
  dealIds: Set<string>;
  reportPath: string;
  webhookUrl: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const args: CliArgs = {
    execute: false,
    limit: null,
    dealIds: new Set(),
    reportPath: `artifacts/bitrix/gz-procurement-method-migration-${stamp}.json`,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--limit") {
      const value = Number.parseInt(argv[++index] ?? "", 10);
      args.limit = Number.isFinite(value) && value > 0 ? value : null;
    } else if (arg === "--deal-id") {
      const value = (argv[++index] ?? "").trim();
      if (value) args.dealIds.add(value);
    } else if (arg === "--report") args.reportPath = argv[++index] ?? args.reportPath;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeReports(reportPath: string, payload: unknown, items: ProcurementMigrationItem[]): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2), "utf8");
  const csvPath = reportPath.replace(/\.json$/i, ".csv");
  const headers = [
    "dealId", "title", "purchaseMethod", "currentCategoryId", "currentStageId",
    "currentAssigneeId", "targetCategoryId", "targetStageId", "decision"
  ];
  const rows = items.map((item) => headers.map((key) => csvCell(item[key as keyof ProcurementMigrationItem])).join(","));
  fs.writeFileSync(csvPath, [headers.join(","), ...rows].join("\n"), "utf8");
  console.log(`report_json=${reportPath}`);
  console.log(`report_csv=${csvPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");
  const client = new BitrixClient(args.webhookUrl);
  const select = [
    "ID", "TITLE", "CATEGORY_ID", "STAGE_ID", "ASSIGNED_BY_ID", PROCUREMENT_METHOD_FIELD
  ];
  const deals = (
    await Promise.all([9, 41].map((categoryId) => client.listAll("deal", { CATEGORY_ID: categoryId }, select)))
  ).flat() as ProcurementMigrationDeal[];
  const items = buildProcurementMethodMigrationPlan(deals);
  let selected = items.filter((item) => item.decision === "move");
  if (args.dealIds.size > 0) selected = selected.filter((item) => args.dealIds.has(item.dealId));
  if (args.limit) selected = selected.slice(0, args.limit);

  const summary = Object.fromEntries(
    [...new Set(items.map((item) => item.decision))].map((decision) => [
      decision,
      items.filter((item) => item.decision === decision).length
    ])
  );
  console.log(`mode=${args.execute ? "execute" : "dry-run"} total=${items.length} selected=${selected.length}`);
  console.log(`decisions=${JSON.stringify(summary)}`);
  for (const item of selected) {
    console.log(`[plan] ${item.dealId} cat=${item.currentCategoryId}/${item.currentStageId} -> ${item.targetCategoryId}/${item.targetStageId} assignee=${item.currentAssigneeId} method=${item.purchaseMethod}`);
  }

  const results: Array<Record<string, unknown>> = [];
  if (args.execute) {
    for (const item of selected) {
      if (!item.updateFields) continue;
      await client.call("crm.item.update", buildProcurementMethodCrmItemUpdate(item));
      const after = await client.findFirst("deal", { ID: item.dealId }, [
        "ID", "CATEGORY_ID", "STAGE_ID", "ASSIGNED_BY_ID"
      ]);
      const verification = verifyProcurementMethodMigration(item, after);
      results.push({
        dealId: item.dealId,
        beforeAssigneeId: item.currentAssigneeId,
        ...verification
      });
      console.log(`[moved] ${item.dealId} category=${verification.afterCategoryId} stage=${verification.afterStageId} assignee_preserved=${verification.assigneePreserved}`);
    }
  }

  writeReports(args.reportPath, {
    generatedAt: new Date().toISOString(),
    mode: args.execute ? "execute" : "dry-run",
    summary,
    selectedDealIds: selected.map((item) => item.dealId),
    items,
    results
  }, items);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
