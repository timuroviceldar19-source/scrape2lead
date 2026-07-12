import dotenv from "dotenv";
import { collectGoszakupRegistryForBins } from "../src/kz/goszakupRegistryCollector.js";
import { collectGzPlans } from "../src/kz/goszakupPlanCollector.js";
import type { GoszakupPlanDetail, GoszakupPlanListItem, GzPlanExportRow } from "../src/kz/goszakupPlanTypes.js";
import { buildExportRow } from "../src/kz/gzPlanExporter.js";
import {
  DEFAULT_GZ_PLANS_CONFIG_PATH,
  loadGzPlansConfig,
  mergeGzPlansExportOptions
} from "../src/kz/gzPlansConfig.js";
import { GzPublishedLedger, buildGzPublishedFingerprint } from "../src/kz/gzPublishedLedger.js";
import { KzStorage } from "../src/kz/kzStorage.js";
import type { GoszakupRegistryRecord } from "../src/kz/registryTypes.js";

dotenv.config();

interface CliArgs {
  configPath: string;
  execute: boolean;
  dryRun: boolean;
  createMissing: boolean;
  limit: number | null;
  maxPages: number | null;
  delayMs: number | null;
  ledgerPath: string;
  webhookUrl: string | null;
}

interface NotifyConfig {
  webhookUrl: string;
  dialogId: string;
}

interface MonitorStats {
  collected: number;
  candidate: number;
  planned: number;
  updated: number;
  created: number;
  missing: number;
  skippedSeen: number;
  failed: number;
}

interface MonitorReportItem {
  originId: string;
  leadId?: string | null;
  customerName: string;
  itemName: string;
  planUrl: string;
}

interface BitrixLeadFields {
  TITLE: string;
  COMPANY_TITLE: string;
  COMMENTS: string;
  SOURCE_ID: string;
  SOURCE_DESCRIPTION: string;
  ORIGINATOR_ID: string;
  ORIGIN_ID: string;
  ADDRESS?: string;
  CURRENCY_ID: string;
  OPPORTUNITY?: number;
  PHONE?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  EMAIL?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  WEB?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  [key: string]: unknown;
}

const ORIGINATOR_ID = "scrape2lead-gz-plans";
const PUBLISHED_STATUS_ID = "5";
const DEFAULT_LEDGER_PATH = "data/gz-published-seen.json";
const PUBLISHED_AT_FIELD = "UF_CRM_S2L_GZ_PUBLISHED_AT";
const NOTIFY_ITEM_LIMIT = 10;

const IMPORT_FIELD_CODES: Array<{ code: string; getValue: (row: GzPlanExportRow) => string }> = [
  { code: "UF_CRM_1713874828510", getValue: (row) => row.method },
  { code: "UF_CRM_1713874845756", getValue: (row) => row.stru_name },
  { code: "UF_CRM_1713874858791", getValue: (row) => row.unit_price },
  { code: "UF_CRM_1713874871715", getValue: (row) => row.quantity },
  { code: "UF_CRM_1713874888434", getValue: (row) => row.customer_name },
  { code: "UF_CRM_1713874902207", getValue: (row) => row.customer_bin },
  { code: "UF_CRM_1713874909541", getValue: (row) => row.status },
  { code: "UF_CRM_S2L_GZ_ADMIN", getValue: (row) => row.reporting_administrator },
  { code: "UF_CRM_S2L_GZ_ADDRESS", getValue: (row) => row.full_address },
  { code: "UF_CRM_S2L_GZ_DIRECTOR", getValue: (row) => row.director_name },
  { code: "UF_CRM_S2L_GZ_APPROVAL_DATE", getValue: (row) => row.plan_act_date },
  { code: "UF_CRM_S2L_GZ_TRU", getValue: (row) => row.stru_code },
  { code: "UF_CRM_S2L_GZ_ITEM_URL", getValue: (row) => row.item_link },
  { code: "UF_CRM_S2L_GZ_UNIT", getValue: (row) => row.unit },
  { code: "UF_CRM_S2L_GZ_EXTRA_SPEC", getValue: (row) => row.extra_characteristics },
  { code: "UF_CRM_S2L_GZ_KEYWORD", getValue: (row) => row.keyword },
  { code: "UF_CRM_S2L_GZ_PLAN_NO", getValue: (row) => row.plan_list_number },
  { code: "UF_CRM_S2L_GZ_PLAN_ID", getValue: (row) => row.plan_point_id },
  { code: "UF_CRM_S2L_GZ_MONTH", getValue: (row) => row.planned_month },
  { code: "UF_CRM_S2L_GZ_AMOUNT", getValue: (row) => row.planned_amount },
  { code: "UF_CRM_S2L_GZ_CUSTOMER_URL", getValue: (row) => row.customer_link },
  { code: "UF_CRM_S2L_GZ_PLAN_URL", getValue: (row) => row.plan_link },
  { code: "UF_CRM_S2L_GZ_SHORT_SPEC", getValue: (row) => row.short_characteristics },
  { code: "UF_CRM_S2L_GZ_EXTRA_DESC", getValue: (row) => row.extra_description },
  { code: "UF_CRM_S2L_GZ_DELIVERY", getValue: (row) => row.delivery_address }
];

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: DEFAULT_GZ_PLANS_CONFIG_PATH,
    execute: false,
    dryRun: false,
    createMissing: false,
    limit: null,
    maxPages: null,
    delayMs: null,
    ledgerPath: DEFAULT_LEDGER_PATH,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") args.configPath = argv[++i] ?? args.configPath;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--create-missing") args.createMissing = true;
    else if (arg === "--limit") args.limit = parseOptionalInt(argv[++i]);
    else if (arg === "--max-pages") args.maxPages = parseOptionalInt(argv[++i]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (arg === "--ledger") args.ledgerPath = argv[++i] ?? args.ledgerPath;
    else if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const execute = args.execute && !args.dryRun;
  if (execute && !args.webhookUrl) {
    throw new Error("BITRIX24_WEBHOOK_URL is required for --execute");
  }

  const fileConfig = loadGzPlansConfig(args.configPath);
  const options = mergeGzPlansExportOptions(fileConfig, {
    statuses: [PUBLISHED_STATUS_ID],
    maxPages: args.maxPages ?? undefined,
    delayMs: args.delayMs ?? undefined
  });

  console.log(`gz-published monitor: mode=${execute ? "execute" : "dry-run"} status_id=${PUBLISHED_STATUS_ID}`);
  const collectResult = await collectGzPlans({
    ...options,
    token: process.env.GOSZAKUP_TOKEN ?? null,
    onProgress: (message) => console.log(`gz-published: ${message}`)
  });

  const storage = new KzStorage({ databasePath: options.databasePath });
  try {
    await refreshRegistryIfNeeded(collectResult.items, options, storage);
    const rows = buildRows(collectResult.items, storage);
    const limited = args.limit ? rows.slice(0, args.limit) : rows;
    const ledger = new GzPublishedLedger(args.ledgerPath);
    const client = args.webhookUrl ? new BitrixClient(args.webhookUrl) : null;
    if (client && execute) {
      await client.ensurePublishedAtField();
    }

    const stats: MonitorStats = {
      collected: collectResult.items.length,
      candidate: limited.length,
      planned: 0,
      updated: 0,
      created: 0,
      missing: 0,
      skippedSeen: 0,
      failed: 0
    };
    const report = {
      updated: [] as MonitorReportItem[],
      created: [] as MonitorReportItem[],
      missing: [] as MonitorReportItem[],
      failed: [] as Array<{ originId: string; message: string }>
    };

    for (const row of limited) {
      const fingerprint = buildGzPublishedFingerprint({
        status: row.status,
        amount: row.planned_amount,
        planUrl: row.plan_link,
        itemName: row.stru_name,
        customerName: row.customer_name
      });

      if (!ledger.shouldUpdate(row.plan_point_id, fingerprint)) {
        stats.skippedSeen += 1;
        continue;
      }

      stats.planned += 1;
      const originId = `gz-plan:${row.plan_point_id}`;
      try {
        const lead = client ? await client.findLead(ORIGINATOR_ID, originId) : null;
        if (!lead && !args.createMissing) {
          stats.missing += 1;
          report.missing.push(toReportItem(row, originId, null));
          console.log(`[missing] ${originId} | ${row.customer_name} | ${row.status}`);
          continue;
        }

        const detectedAt = new Date().toISOString();
        const fields = buildLeadFields(row, detectedAt);

        if (!execute) {
          console.log(`[dry-run] ${lead ? "update" : "create"} ${originId} | ${row.customer_name} | ${row.status}`);
          continue;
        }

        if (!client) throw new Error("Bitrix client was not initialized");

        let leadId = lead?.ID ?? null;
        if (leadId) {
          await client.updateLead(leadId, fields);
          stats.updated += 1;
          report.updated.push(toReportItem(row, originId, leadId));
          console.log(`[updated] ${originId} -> lead ${leadId}`);
        } else {
          leadId = await client.addLead(fields);
          stats.created += 1;
          report.created.push(toReportItem(row, originId, leadId));
          console.log(`[created] ${originId} -> lead ${leadId}`);
        }

        ledger.record({
          plan_point_id: row.plan_point_id,
          previous_status: lead?.STATUS_IMPORT ?? null,
          detected_status: row.status,
          detected_at: detectedAt,
          bitrix_lead_id: leadId,
          fingerprint
        });
      } catch (error) {
        stats.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({ originId, message });
        console.error(`[failed] ${originId}: ${message}`);
      }
    }

    if (execute) {
      ledger.save();
    }

    console.log(JSON.stringify(stats, null, 2));
    await notifyMonitorReport(stats, report, execute);
    if (stats.failed > 0) process.exitCode = 1;
  } finally {
    storage.close();
  }
}

async function refreshRegistryIfNeeded(
  items: Array<GoszakupPlanListItem & { detail: GoszakupPlanDetail | null }>,
  options: ReturnType<typeof mergeGzPlansExportOptions>,
  storage: KzStorage
): Promise<void> {
  const bins = [...new Set(items.map((item) => item.detail?.customer_bin).filter((bin): bin is string => Boolean(bin)))];
  const missing = bins.filter((bin) => !storage.getGoszakupRegistryByBin(bin));
  if (missing.length === 0) return;

  await collectGoszakupRegistryForBins(missing, {
    databasePath: options.databasePath,
    delayMs: options.delayMs,
    headless: options.headless,
    requireContacts: true
  });
}

function buildRows(
  items: Array<GoszakupPlanListItem & { detail: GoszakupPlanDetail | null }>,
  storage: KzStorage
): GzPlanExportRow[] {
  const rows: GzPlanExportRow[] = [];
  for (const item of items) {
    const registry = getRegistry(item.detail?.customer_bin ?? "", storage);
    const row = buildExportRow(item, item.detail, registry);
    if (row) rows.push(row);
  }
  return dedupeRows(rows);
}

function getRegistry(bin: string, storage: KzStorage): GoszakupRegistryRecord | null {
  return bin ? storage.getGoszakupRegistryByBin(bin) : null;
}

function toReportItem(row: GzPlanExportRow, originId: string, leadId: string | null): MonitorReportItem {
  return {
    originId,
    leadId,
    customerName: row.customer_name || row.customer_bin || "-",
    itemName: row.stru_name || row.keyword || "-",
    planUrl: row.plan_link
  };
}

function buildLeadFields(row: GzPlanExportRow, detectedAt: string): BitrixLeadFields {
  const comments = [
    `Published detected: ${detectedAt}`,
    `GZ plan ID: ${row.plan_point_id}`,
    `BIN: ${row.customer_bin || "-"}`,
    `Customer: ${row.customer_name || "-"}`,
    `Status: ${row.status || "-"}`,
    `Amount: ${row.planned_amount || "-"}`,
    `Plan URL: ${row.plan_link || "-"}`
  ].join("\n");

  const fields: BitrixLeadFields = {
    TITLE: buildTitle(row),
    COMPANY_TITLE: row.customer_name || row.customer_bin || `GZ plan ${row.plan_point_id}`,
    COMMENTS: comments,
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: "scrape2lead gz published monitor",
    ORIGINATOR_ID,
    ORIGIN_ID: `gz-plan:${row.plan_point_id}`,
    ADDRESS: row.full_address || undefined,
    CURRENCY_ID: "KZT",
    OPPORTUNITY: parseMoney(row.planned_amount),
    [PUBLISHED_AT_FIELD]: detectedAt
  };

  for (const mapping of IMPORT_FIELD_CODES) {
    const value = mapping.getValue(row);
    if (value.trim()) fields[mapping.code] = value;
  }
  if (row.phone) fields.PHONE = [{ VALUE: row.phone, VALUE_TYPE: "WORK" }];
  if (row.email) fields.EMAIL = [{ VALUE: normalizeEmail(row.email), VALUE_TYPE: "WORK" }];
  if (row.website) fields.WEB = [{ VALUE: row.website, VALUE_TYPE: "WORK" }];

  return stripUndefined(fields) as BitrixLeadFields;
}

function buildTitle(row: GzPlanExportRow): string {
  return `[GZ ${row.plan_point_id}] ${row.customer_name || row.customer_bin} - ${row.stru_name || row.keyword}`.slice(0, 250);
}

async function notifyMonitorReport(
  stats: MonitorStats,
  report: {
    updated: MonitorReportItem[];
    created: MonitorReportItem[];
    missing: MonitorReportItem[];
    failed: Array<{ originId: string; message: string }>;
  },
  execute: boolean
): Promise<void> {
  const config = readNotifyConfig();
  if (!config) return;

  try {
    const client = new BitrixNotifyClient(config.webhookUrl);
    await client.sendMessage(config.dialogId, buildNotifyMessage(stats, report, execute, config.webhookUrl));
    console.log(`notify: sent Bitrix report to dialog ${config.dialogId}`);
  } catch (error) {
    console.error(`notify: failed to send Bitrix report: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readNotifyConfig(): NotifyConfig | null {
  const webhookUrl = process.env.BITRIX24_NOTIFY_WEBHOOK_URL?.trim();
  const dialogId = process.env.BITRIX24_NOTIFY_DIALOG_ID?.trim();
  if (!webhookUrl || !dialogId) return null;
  return { webhookUrl, dialogId };
}

function buildNotifyMessage(
  stats: MonitorStats,
  report: {
    updated: MonitorReportItem[];
    created: MonitorReportItem[];
    missing: MonitorReportItem[];
    failed: Array<{ originId: string; message: string }>;
  },
  execute: boolean,
  webhookUrl: string
): string {
  const portalUrl = getPortalUrl(webhookUrl);
  const lines = [
    `[B]GZ Published Monitor ${execute ? "completed" : "dry-run"}[/B]`,
    "",
    `Collected: ${stats.collected}`,
    `Candidates: ${stats.candidate}`,
    `Planned updates: ${stats.planned}`,
    `Updated leads: ${stats.updated}`,
    `Created leads: ${stats.created}`,
    `Missing in Bitrix: ${stats.missing}`,
    `Already seen: ${stats.skippedSeen}`,
    `Failed: ${stats.failed}`
  ];

  appendReportItems(lines, "Updated", report.updated, portalUrl);
  appendReportItems(lines, "Created", report.created, portalUrl);
  appendReportItems(lines, "Missing", report.missing, portalUrl);
  appendFailures(lines, report.failed);

  return lines.join("\n");
}

function appendReportItems(lines: string[], title: string, items: MonitorReportItem[], portalUrl: string): void {
  if (items.length === 0) return;
  lines.push("", `[B]${title}[/B]`);
  for (const item of items.slice(0, NOTIFY_ITEM_LIMIT)) {
    const leadPart = item.leadId ? `lead ${item.leadId}: ${portalUrl}/crm/lead/details/${item.leadId}/` : item.originId;
    lines.push(`- ${leadPart}`);
    lines.push(`  ${trimForReport(item.customerName, 90)} - ${trimForReport(item.itemName, 70)}`);
    if (!item.leadId && item.planUrl) lines.push(`  ${item.planUrl}`);
  }
  if (items.length > NOTIFY_ITEM_LIMIT) {
    lines.push(`... and ${items.length - NOTIFY_ITEM_LIMIT} more`);
  }
}

function appendFailures(lines: string[], failed: Array<{ originId: string; message: string }>): void {
  if (failed.length === 0) return;
  lines.push("", "[B]Failures[/B]");
  for (const item of failed.slice(0, NOTIFY_ITEM_LIMIT)) {
    lines.push(`- ${item.originId}: ${trimForReport(item.message, 120)}`);
  }
  if (failed.length > NOTIFY_ITEM_LIMIT) {
    lines.push(`... and ${failed.length - NOTIFY_ITEM_LIMIT} more`);
  }
}

function getPortalUrl(webhookUrl: string): string {
  try {
    const url = new URL(webhookUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://ft3.bitrix24.kz";
  }
}

function trimForReport(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function dedupeRows(rows: GzPlanExportRow[]): GzPlanExportRow[] {
  const seen = new Set<string>();
  const result: GzPlanExportRow[] = [];
  for (const row of rows) {
    if (seen.has(row.plan_point_id)) continue;
    seen.add(row.plan_point_id);
    result.push(row);
  }
  return result;
}

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async findLead(originatorId: string, originId: string): Promise<{ ID: string; STATUS_IMPORT?: string | null } | null> {
    const response = await this.call("crm.lead.list", {
      filter: { ORIGINATOR_ID: originatorId, ORIGIN_ID: originId },
      select: ["ID", "UF_CRM_1713874909541"]
    });
    const rows = Array.isArray(response.result) ? response.result : [];
    const first = rows[0] as { ID?: string | number; UF_CRM_1713874909541?: string | null } | undefined;
    return first?.ID ? { ID: String(first.ID), STATUS_IMPORT: first.UF_CRM_1713874909541 ?? null } : null;
  }

  async addLead(fields: BitrixLeadFields): Promise<string> {
    const response = await this.call("crm.lead.add", { fields, params: { REGISTER_SONET_EVENT: "Y" } });
    return String(response.result);
  }

  async updateLead(id: string, fields: BitrixLeadFields): Promise<void> {
    await this.call("crm.lead.update", { id, fields });
  }

  async ensurePublishedAtField(): Promise<void> {
    const response = await this.call("crm.lead.userfield.list", { order: { SORT: "ASC" } });
    const fields = Array.isArray(response.result) ? response.result as Array<{ FIELD_NAME: string }> : [];
    if (!fields.some((field) => field.FIELD_NAME === PUBLISHED_AT_FIELD)) {
      await this.call("crm.lead.userfield.add", {
      fields: {
        FIELD_NAME: PUBLISHED_AT_FIELD,
        USER_TYPE_ID: "string",
        XML_ID: "scrape2lead_gz_published_detected_at",
        SORT: "880",
        EDIT_FORM_LABEL: "GZ published detected at",
        LIST_COLUMN_LABEL: "GZ published detected at",
        LIST_FILTER_LABEL: "GZ published detected at"
      }
      });
    }
    await this.ensureImportLayoutElement(PUBLISHED_AT_FIELD);
  }

  private async ensureImportLayoutElement(fieldName: string): Promise<void> {
    for (const leadCustomerType of [1, 2]) {
      const response = await this.call("crm.lead.details.configuration.get", {
        scope: "C",
        leadCustomerType
      });
      const configuration = Array.isArray(response.result)
        ? response.result as Array<{ name: string; title: string; type: string; elements: Array<{ name: string; optionFlags?: string }> }>
        : [];
      const section = configuration.find((item) => item.type === "section" && item.title.toLowerCase() === "импорт");
      if (!section) continue;
      if (section.elements.some((element) => element.name === fieldName)) continue;
      section.elements.push({ name: fieldName, optionFlags: "1" });
      await this.call("crm.lead.details.configuration.set", {
        scope: "C",
        leadCustomerType,
        data: configuration
      });
    }
  }

  private async call(method: string, body: unknown): Promise<{ result: unknown; error?: string; error_description?: string }> {
    const response = await fetch(`${this.baseUrl}/${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as { result: unknown; error?: string; error_description?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }
}

class BitrixNotifyClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async sendMessage(dialogId: string, message: string): Promise<void> {
    await this.call("im.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: message,
      SYSTEM: "N",
      URL_PREVIEW: "N"
    });
  }

  private async call(method: string, body: unknown): Promise<{ result: unknown; error?: string; error_description?: string }> {
    const response = await fetch(`${this.baseUrl}/${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as { result: unknown; error?: string; error_description?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }
}

function parseMoney(value: string): number | undefined {
  const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeEmail(value: string): string {
  return value.trim().replace(/[.,;:]+$/g, "");
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stripUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== ""));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
