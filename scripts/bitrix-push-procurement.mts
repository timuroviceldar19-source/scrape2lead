import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import { ProcurementBitrixClient } from "../src/bitrix/procurementClient.js";
import { planProcurementPush } from "../src/bitrix/procurementPush.js";
import { verifyProcurementAssignmentGate } from "../src/bitrix/procurementDealPlan.js";
import { loadProcurementConfig } from "../src/kz/procurement/config.js";
import { evaluateProcurementReleaseGate, type ProcurementManualRun } from "../src/kz/procurement/releaseGate.js";
import type { ClassifiedProcurement } from "../src/kz/procurement/types.js";

const args = parseArgs(process.argv.slice(2));
const config = loadProcurementConfig(args.config);
const webhook = (process.env.BITRIX24_WEBHOOK_URL ?? process.env.BITRIX_WEBHOOK_URL ?? "").trim();
if (!webhook) throw new Error("BITRIX24_WEBHOOK_URL is required for duplicate checks and dry-run");
const report = JSON.parse(fs.readFileSync(path.resolve(args.report), "utf8")) as {
  classification?: { data?: ClassifiedProcurement[] };
};
const records = (report.classification?.data ?? []).map((item) => item.record);

if (args.execute) {
  if (!config.bitrix.executeEnabled) throw new Error("Production push is disabled in procurement config");
  const runs = readManualRuns(args.gateFile);
  const gate = evaluateProcurementReleaseGate(runs, config.manualRunsRequired);
  if (!gate.ok) throw new Error(`Production gate failed: ${gate.reasons.join(", ")}`);
}

const transport = new BitrixClient(webhook, { requestDelayMs: 550, maxRetries: 5 });
const client = new ProcurementBitrixClient(transport);
const result = await planProcurementPush(records, client, { execute: args.execute });
let assignmentGate: ReturnType<typeof verifyProcurementAssignmentGate> | null = null;
if (args.verifyDealIds.length) {
  const deals = [];
  for (const id of args.verifyDealIds) {
    const deal = await transport.findFirst("deal", { ID: id }, ["ID", "ASSIGNED_BY_ID"]);
    if (deal) deals.push(deal);
  }
  assignmentGate = verifyProcurementAssignmentGate(deals);
}

const outputPath = `${path.resolve(args.report).replace(/\.json$/i, "")}.bitrix-${args.execute ? "push" : "dry-run"}.json`;
fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), execute: args.execute,
  inputRecords: records.length, counts: result.counts, assignmentGate, items: result.items }, null, 2), "utf8");
console.log(JSON.stringify({ mode: args.execute ? "execute" : "dry-run", inputRecords: records.length,
  counts: result.counts, assignmentGate, outputPath }, null, 2));
if (result.counts.failed > 0 || assignmentGate?.ok === false) process.exitCode = 1;

function readManualRuns(filePath: string): ProcurementManualRun[] {
  if (!fs.existsSync(filePath)) return [];
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return Array.isArray(value) ? value as ProcurementManualRun[] : [];
}
function parseArgs(argv: string[]): { report: string; config: string; execute: boolean; gateFile: string; verifyDealIds: string[] } {
  const result = { report: "", config: "config/procurement-sources.json", execute: false,
    gateFile: "data/procurement-manual-runs.json", verifyDealIds: [] as string[] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]; const value = argv[index + 1];
    if (arg === "--report" && value) { result.report = value; index++; }
    else if (arg === "--config" && value) { result.config = value; index++; }
    else if (arg === "--gate-file" && value) { result.gateFile = value; index++; }
    else if (arg === "--verify-deal-ids" && value) { result.verifyDealIds = value.split(",").map((id) => id.trim()).filter(Boolean); index++; }
    else if (arg === "--execute") result.execute = true;
    else if (arg === "--help") { console.log("tsx scripts/bitrix-push-procurement.mts --report file.json [--verify-deal-ids 1,2] [--execute]"); process.exit(0); }
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!result.report) throw new Error("--report is required");
  return result;
}
