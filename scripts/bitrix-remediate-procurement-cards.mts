import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import type { ProcurementCardAuditRow } from "../src/bitrix/procurementCardAudit.js";
import {
  planProcurementRemediation, verifyRemediationPlan, type RemediationPlan
} from "../src/bitrix/procurementRemediation.js";
import { fetchProcurementJson, isNotFound, withRetry } from "../src/kz/procurement/http.js";
import { parseEpzPlanDetail } from "../src/kz/procurement/planDetail.js";
import { EMPTY_PLAN_PERIOD } from "../src/kz/procurement/planPeriod.js";
import type { ProcurementRecord } from "../src/kz/procurement/types.js";

const EPZ_PLAN_ITEMS = "https://zakup.gov.kz/api/core/api/public/plan-items";
const args = parseArgs(process.argv.slice(2));

const auditBody = fs.readFileSync(path.resolve(args.audit), "utf8");
const audit = JSON.parse(auditBody) as { rows?: ProcurementCardAuditRow[] };
const rows = audit.rows ?? [];
if (!rows.length) throw new Error(`audit file has no rows: ${args.audit}`);

// Двухшаговый поток. Dry-run строит план и записывает в него хеш файла аудита;
// execute принимает только уже сохранённый план и заново сверяет хеш с файлом аудита.
// Иначе проверка была бы бессмысленной: план и сверка опирались бы на одно и то же тело.
let plan: RemediationPlan;
if (args.plan) {
  plan = JSON.parse(fs.readFileSync(path.resolve(args.plan), "utf8")) as RemediationPlan;
} else {
  if (args.execute) throw new Error("--execute requires --plan produced by a previous dry-run");
  plan = planProcurementRemediation(
    auditBody,
    rows,
    await fetchUpstreamRecords(rows),
    { wrongPlanYear: args.preserveWrongPlanYear ? "preserve-and-correct" : "skip" }
  );
}
verifyRemediationPlan(plan, auditBody);

const results: Array<{ dealId: string; action: string; error: string | null }> = [];
if (args.execute) {
  const webhook = (process.env.BITRIX24_WEBHOOK_URL ?? process.env.BITRIX_WEBHOOK_URL ?? "").trim();
  if (!webhook) throw new Error("BITRIX24_WEBHOOK_URL is required");
  const client = new BitrixClient(webhook, { requestDelayMs: 550, maxRetries: 5 });
  const targets = plan.items.filter((item) => item.action === "update")
    .slice(0, args.limit ?? plan.items.length);
  for (const item of targets) {
    try {
      await client.update("deal", item.dealId, item.fields);
      results.push({ dealId: item.dealId, action: "updated", error: null });
    } catch (error) {
      results.push({ dealId: item.dealId, action: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
}

const outputPath = path.resolve(args.output
  ?? `${path.resolve(args.audit).replace(/\.json$/i, "")}.remediation-${args.execute ? "execute" : "dry-run"}.json`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(), execute: args.execute,
  auditPath: path.resolve(args.audit), auditSha256: plan.auditSha256,
  counts: plan.counts, items: plan.items, results
}, null, 2)}\n`, "utf8");

const failed = results.filter((result) => result.action === "failed").length;
console.log(JSON.stringify({ mode: args.execute ? "execute" : "dry-run", auditSha256: plan.auditSha256,
  ...plan.counts, updated: results.filter((r) => r.action === "updated").length, failed, outputPath }, null, 2));
console.log(`AUTOMATION_RESULT_JSON=${JSON.stringify({
  stage: args.execute ? "f3-remediate" : "f3-remediate-dry-run", outputPath,
  counts: { ...plan.counts, failed }, criticalErrors: failed ? [`remediation_failed:${failed}`] : [], warnings: []
})}`);
if (failed) process.exitCode = 1;

async function fetchUpstreamRecords(auditRows: ProcurementCardAuditRow[]): Promise<ProcurementRecord[]> {
  const keys = new Map<string, string>();
  for (const row of auditRows) {
    if (row.recordKind === "plan" && row.upstreamKey && row.source !== "tizilim") keys.set(row.upstreamKey, row.upstreamKey);
  }
  const records: ProcurementRecord[] = [];
  for (const key of keys.values()) {
    let raw: unknown;
    try {
      raw = await withRetry(() => fetchProcurementJson(`${EPZ_PLAN_ITEMS}/${encodeURIComponent(key)}/`),
        { maxAttempts: 4, delayMs: 250 });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    const detail = parseEpzPlanDetail(raw);
    if (!detail) continue;
    records.push({
      source: detail.source, recordKind: "plan", sourceRecordId: detail.sourceRecordId,
      externalId: detail.externalId, parentExternalId: null, status: detail.status,
      productName: detail.nameRu ?? "", description: detail.extraDescription ?? "",
      truCode: detail.truCode, customerSourceId: detail.customerSourceId,
      customerName: detail.customerName, customerBin: detail.customerBin,
      amount: detail.amount, currency: "KZT",
      ...EMPTY_PLAN_PERIOD,
      planYear: detail.financialYear, planMonth: detail.planMonth,
      planYearId: detail.planYearId, approvedAt: detail.approvedAt,
      startDate: null, endDate: null,
      url: `https://zakup.gov.kz/plan-items/${encodeURIComponent(detail.sourceRecordId)}`,
      purchaseMethod: detail.purchaseMethod, collectedAt: new Date().toISOString()
    });
  }
  return records;
}

function parseArgs(argv: string[]): { audit: string; plan?: string; output?: string; execute: boolean;
  limit: number | null; preserveWrongPlanYear: boolean } {
  const result: { audit: string; plan?: string; output?: string; execute: boolean;
    limit: number | null; preserveWrongPlanYear: boolean } =
    { audit: "", execute: false, limit: null, preserveWrongPlanYear: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--audit" && value) { result.audit = value; index++; }
    else if (arg === "--plan" && value) { result.plan = value; index++; }
    else if (arg === "--output" && value) { result.output = value; index++; }
    else if (arg === "--limit" && value) {
      result.limit = Number(value); index++;
      if (!Number.isInteger(result.limit) || result.limit < 1) throw new Error("--limit must be a positive integer");
    }
    else if (arg === "--execute") result.execute = true;
    else if (arg === "--preserve-wrong-plan-year") result.preserveWrongPlanYear = true;
    else if (arg === "--help") {
      console.log("Dry-run:  tsx scripts/bitrix-remediate-procurement-cards.mts --audit card-audit.json [--preserve-wrong-plan-year]");
      console.log("Execute:  tsx scripts/bitrix-remediate-procurement-cards.mts --audit card-audit.json --plan card-audit.remediation-dry-run.json --execute [--limit n]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!result.audit) throw new Error("--audit is required");
  return result;
}
