import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import {
  auditProcurementCards, needsManualDecision, parseProcurementOriginId,
  PROCUREMENT_ORIGINATOR_ID, type ProcurementCardDeal
} from "../src/bitrix/procurementCardAudit.js";
import { PROCUREMENT_CATEGORY_ID } from "../src/bitrix/procurementDealPlan.js";
import { sha256 } from "../src/bitrix/procurementRemediation.js";
import { loadProcurementConfig } from "../src/kz/procurement/config.js";
import { fetchProcurementJson, isNotFound, withRetry } from "../src/kz/procurement/http.js";
import { parseEpzPlanDetail } from "../src/kz/procurement/planDetail.js";
import { buildPlanPeriodWindow, EMPTY_PLAN_PERIOD } from "../src/kz/procurement/planPeriod.js";
import type { ProcurementRecord } from "../src/kz/procurement/types.js";

// Аудит только читает: ни add, ни update, ни delete здесь нет и флага --execute тоже.
const EPZ_PLAN_ITEMS = "https://zakup.gov.kz/api/core/api/public/plan-items";
const args = parseArgs(process.argv.slice(2));
const config = loadProcurementConfig(args.config);
const webhook = (process.env.BITRIX24_WEBHOOK_URL ?? process.env.BITRIX_WEBHOOK_URL ?? "").trim();
if (!webhook) throw new Error("BITRIX24_WEBHOOK_URL is required");

const client = new BitrixClient(webhook, { requestDelayMs: 550, maxRetries: 5 });
const deals = (await client.listAll("deal",
  { ORIGINATOR_ID: PROCUREMENT_ORIGINATOR_ID, CATEGORY_ID: PROCUREMENT_CATEGORY_ID },
  ["ID", "TITLE", "ORIGIN_ID", "ORIGINATOR_ID", "STAGE_ID", "ASSIGNED_BY_ID", "BEGINDATE"]
)) as unknown as ProcurementCardDeal[];

// Каждую позицию запрашиваем ПРЯМО по ключу карточки, независимо от текущего окна сбора:
// записи прошлых лет в новое окно не попадают и иначе выглядели бы как исчезнувшие.
const upstream = await fetchUpstreamRecords(deals);
const window = buildPlanPeriodWindow(new Date(), config.rollingMonths);
const audit = auditProcurementCards(deals, upstream, {
  allowedPlanYears: window.years,
  allowedStatuses: config.planStatuses.map((status) => status.name)
});

const payload = {
  generatedAt: new Date().toISOString(),
  categoryId: PROCUREMENT_CATEGORY_ID,
  allowedPlanYears: window.years,
  totals: { deals: deals.length, upstreamResolved: upstream.length, ...audit.counts },
  manualDecision: audit.rows.filter(needsManualDecision).map((row) => row.dealId),
  rows: audit.rows
};
const body = `${JSON.stringify(payload, null, 2)}\n`;
const outputPath = path.resolve(args.output
  ?? path.join(config.outputDirectory, `card-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, body, "utf8");

// Тот же хеш, что проверяет remediation: план исправления привязан к конкретному файлу аудита.
const auditSha256 = sha256(body);
console.log(JSON.stringify({ mode: "read-only", outputPath, sha256: auditSha256, ...payload.totals }, null, 2));
console.log(`AUTOMATION_RESULT_JSON=${JSON.stringify({
  stage: "f3-audit", outputPath, sha256: auditSha256, counts: payload.totals, criticalErrors: [], warnings: []
})}`);

async function fetchUpstreamRecords(cards: ProcurementCardDeal[]): Promise<ProcurementRecord[]> {
  const wanted = new Map<string, { source: ProcurementRecord["source"]; kind: "plan" | "tender"; key: string }>();
  for (const deal of cards) {
    const parsed = parseProcurementOriginId(deal.ORIGIN_ID);
    if (parsed && parsed.source !== "tizilim") {
      wanted.set(`${parsed.source}:${parsed.recordKind}:${parsed.upstreamKey}`,
        { source: parsed.source, kind: parsed.recordKind, key: parsed.upstreamKey });
    }
  }

  const records: ProcurementRecord[] = [];
  for (const item of wanted.values()) {
    if (item.kind !== "plan") continue;
    let raw: unknown;
    try {
      raw = await withRetry(() => fetchProcurementJson(`${EPZ_PLAN_ITEMS}/${encodeURIComponent(item.key)}/`),
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

function parseArgs(argv: string[]): { config: string; output?: string } {
  const result: { config: string; output?: string } = { config: "config/procurement-sources.f3.json" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--config" && value) { result.config = value; index++; }
    else if (arg === "--output" && value) { result.output = value; index++; }
    else if (arg === "--help") {
      console.log("tsx scripts/bitrix-audit-procurement-cards.mts [--config path] [--output file.json]");
      console.log("Read-only. Never writes to Bitrix.");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return result;
}
