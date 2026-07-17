import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { goszakupGetJson } from "../src/kz/goszakupClient.js";
import { parseGoszakupPlanSearchHtml } from "../src/kz/goszakupPlanHtmlParser.js";
import { GZ_PLAN_STATUS_BY_NAME } from "../src/kz/goszakupPlanTypes.js";
import { extractGzPlanPointIdFromUrl } from "../src/kz/gzPlanIdentity.js";
import {
  buildPublishedDealUpdate,
  applyPublishedDealUpdate,
  selectPublishedDealBatch,
  type PublishedDealAction
} from "../src/bitrix/gzPublishedDealStatus.js";

dotenv.config();

interface CliArgs {
  webhookUrl: string | null;
  since: string;
  execute: boolean;
  offset: number;
  limit: number | null;
  delayMs: number;
  jsonReportPath: string;
  xlsxReportPath: string;
  token: string | null;
}

interface BitrixDeal {
  ID?: string | number;
  TITLE?: string | null;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
  OPPORTUNITY?: string | number | null;
  DATE_CREATE?: string | null;
  DATE_MODIFY?: string | null;
  UF_CRM_PLAN_LINK?: string | null;
  UF_CRM_1782386571874_IU_XLS?: string | null;
  UF_CRM_PLAN_STATUS?: string | null;
  UF_CRM_6627AEBD85B4D?: string | null;
  UF_CRM_6A436D5A3614C?: string | null;
  UF_CRM_S2L_GZ_PUBLISHED_AT?: string | null;
  CATEGORY_ID?: string | number | null;
}

interface StatusCheck {
  planId: string;
  status: string | null;
  statusId: string | null;
  published: boolean;
  planUrl: string;
  source: "api" | "html";
}

interface ReportItem {
  dealId: string;
  originId: string;
  planId: string;
  title: string;
  assignedById: string | null;
  amount: string | null;
  dateCreate: string | null;
  dateModify: string | null;
  previousBitrixStatus: string | null;
  currentGoszakupStatus: string | null;
  currentGoszakupStatusId: string | null;
  published: boolean;
  planUrl: string;
  checkedAt: string;
  updatedInBitrix: boolean;
  source: "api" | "html";
  categoryId: string | null;
  statusAction: PublishedDealAction | "not-published";
  skipReason: string | null;
}

interface Report {
  mode: "dry-run" | "execute";
  originatorId: string;
  since: string;
  offset: number;
  limit: number | null;
  totalDeals: number;
  startedAt: string;
  finishedAt: string | null;
  jsonReportPath: string;
  xlsxReportPath: string;
  stats: {
    dealsFetched: number;
    checked: number;
    published: number;
    notPublished: number;
    updated: number;
    failed: number;
    skippedInvalidOrigin: number;
    skippedNotApproved: number;
    noOp: number;
  };
  published: ReportItem[];
  notPublished: ReportItem[];
  failed: Array<{ dealId: string; originId: string | null; title: string | null; message: string }>;
  skippedInvalidOrigin: BitrixDeal[];
}

const ORIGINATOR_ID = "scrape2lead-gz-plans";
const PUBLISHED_STATUS_ID = "5";
const PUBLISHED_STATUS_NAME = "Опубликован";
const PUBLISHED_AT_FIELD = "UF_CRM_S2L_GZ_PUBLISHED_AT";
const KNOWN_STATUS_NAMES = new Set(Object.keys(GZ_PLAN_STATUS_BY_NAME).map((status) => normalizeRu(status)));

function parseArgs(argv: string[]): CliArgs {
  const stamp = timestampForFile();
  const args: CliArgs = {
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    since: defaultSinceDate(),
    execute: false,
    offset: 0,
    limit: null,
    delayMs: 350,
    jsonReportPath: path.join("logs", `gz-deals-published-monitor-${stamp}.json`),
    xlsxReportPath: path.join("logs", `gz-deals-published-monitor-${stamp}.xlsx`),
    token: process.env.GOSZAKUP_TOKEN?.trim() || null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else if (arg === "--since") args.since = argv[++i] ?? args.since;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--offset") args.offset = parseNonNegativeInt(argv[++i], "--offset");
    else if (arg === "--limit") args.limit = parseOptionalInt(argv[++i]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i] ?? args.delayMs);
    else if (arg === "--report") {
      args.jsonReportPath = argv[++i] ?? args.jsonReportPath;
      args.xlsxReportPath = replaceExtension(args.jsonReportPath, ".xlsx");
    } else if (arg === "--xlsx-report") args.xlsxReportPath = argv[++i] ?? args.xlsxReportPath;
    else if (arg === "--goszakup-token") args.token = argv[++i]?.trim() || null;
  }

  return args;
}

function defaultSinceDate(now = new Date()): string {
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

  const startedAt = new Date().toISOString();
  const client = new BitrixClient(args.webhookUrl);

  if (args.execute) await client.ensurePublishedAtField();

  const deals = await client.listRecentGzDeals(args.since);
  const limitedDeals = selectPublishedDealBatch(deals, args.offset, args.limit);

  const report: Report = {
    mode: args.execute ? "execute" : "dry-run",
    originatorId: ORIGINATOR_ID,
    since: args.since,
    offset: args.offset,
    limit: args.limit,
    totalDeals: deals.length,
    startedAt,
    finishedAt: null,
    jsonReportPath: args.jsonReportPath,
    xlsxReportPath: args.xlsxReportPath,
    stats: {
      dealsFetched: limitedDeals.length,
      checked: 0,
      published: 0,
      notPublished: 0,
      updated: 0,
      failed: 0,
      skippedInvalidOrigin: 0,
      skippedNotApproved: 0,
      noOp: 0
    },
    published: [],
    notPublished: [],
    failed: [],
    skippedInvalidOrigin: []
  };

  console.log(`gz deals published monitor: mode=${report.mode} since=${args.since} total=${deals.length} offset=${args.offset} deals=${limitedDeals.length}`);

  for (const deal of limitedDeals) {
    const originId = stringOrNull(deal.ORIGIN_ID);
    const planUrl = stringOrNull(deal.UF_CRM_PLAN_LINK)
      ?? stringOrNull(deal.UF_CRM_1782386571874_IU_XLS);
    const planId = extractGzPlanPointIdFromUrl(planUrl) ?? extractPlanId(originId);
    if (!originId || !planId) {
      report.stats.skippedInvalidOrigin += 1;
      report.skippedInvalidOrigin.push(deal);
      console.warn(`[skipped] deal ${deal.ID ?? "?"}: invalid origin ${originId ?? "-"}`);
      continue;
    }

    try {
      const check = await checkPlanStatus(planId, deal, args.token);
      const checkedAt = new Date().toISOString();
      const item: ReportItem = {
        dealId: String(deal.ID ?? ""),
        originId,
        planId,
        title: stringOrNull(deal.TITLE) ?? "",
        assignedById: stringOrNull(deal.ASSIGNED_BY_ID),
        amount: stringOrNull(deal.OPPORTUNITY),
        dateCreate: stringOrNull(deal.DATE_CREATE),
        dateModify: stringOrNull(deal.DATE_MODIFY),
        previousBitrixStatus: stringOrNull(deal.UF_CRM_PLAN_STATUS) ?? stringOrNull(deal.UF_CRM_6627AEBD85B4D),
        currentGoszakupStatus: check.status,
        currentGoszakupStatusId: check.statusId,
        published: check.published,
        planUrl: check.planUrl,
        checkedAt,
        updatedInBitrix: false,
        source: check.source,
        categoryId: stringOrNull(deal.CATEGORY_ID),
        statusAction: "not-published",
        skipReason: null
      };

      report.stats.checked += 1;
      if (item.published) {
        report.stats.published += 1;
        const update = buildPublishedDealUpdate(deal, check.status ?? PUBLISHED_STATUS_NAME, checkedAt);
        item.statusAction = update.action;
        item.skipReason = update.skipReason;
        if (update.action === "skipped") report.stats.skippedNotApproved += 1;
        else if (Object.keys(update.fields).length === 0) report.stats.noOp += 1;

        if (await applyPublishedDealUpdate(client, item.dealId, update, args.execute)) {
          item.updatedInBitrix = true;
          report.stats.updated += 1;
          console.log(`[updated] deal ${item.dealId} | ${originId} | ${check.status}`);
        } else if (update.action === "skipped") {
          console.log(`[skipped] deal ${item.dealId} | ${originId} | ${update.skipReason}`);
        } else if (Object.keys(update.fields).length === 0) {
          console.log(`[no-op] deal ${item.dealId} | ${originId} | ${check.status}`);
        } else {
          console.log(`[dry-run] update deal ${item.dealId} | ${originId} | ${check.status}`);
        }
        report.published.push(item);
      } else {
        report.stats.notPublished += 1;
        report.notPublished.push(item);
        console.log(`[not-published] deal ${item.dealId} | ${originId} | ${item.currentGoszakupStatus ?? "-"}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.stats.failed += 1;
      report.failed.push({
        dealId: String(deal.ID ?? ""),
        originId,
        title: stringOrNull(deal.TITLE),
        message
      });
      console.error(`[failed] deal ${deal.ID ?? "?"} | ${originId}: ${message}`);
    }

    if (args.delayMs > 0) await sleep(args.delayMs);
  }

  report.finishedAt = new Date().toISOString();
  await writeReports(report);

  console.log(JSON.stringify(report.stats, null, 2));
  console.log(`json_report=${args.jsonReportPath}`);
  console.log(`xlsx_report=${args.xlsxReportPath}`);

  if (report.stats.failed > 0) process.exitCode = 1;
}

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async listRecentGzDeals(since: string): Promise<BitrixDeal[]> {
    const filter: Record<string, string> = {
      ORIGINATOR_ID,
      ">=DATE_CREATE": since
    };
    const deals = await this.callPaged<BitrixDeal>("crm.deal.list", {
      order: { DATE_CREATE: "ASC", ID: "ASC" },
      filter,
      select: [
        "ID",
        "TITLE",
        "ORIGINATOR_ID",
        "ORIGIN_ID",
        "ASSIGNED_BY_ID",
        "OPPORTUNITY",
        "DATE_CREATE",
        "DATE_MODIFY",
        "CATEGORY_ID",
        "UF_CRM_PLAN_LINK",
        "UF_CRM_1782386571874_IU_XLS",
        "UF_CRM_PLAN_STATUS",
        "UF_CRM_6627AEBD85B4D",
        "UF_CRM_6A436D5A3614C",
        PUBLISHED_AT_FIELD
      ]
    });
    return deals.filter((deal) => String(deal.ORIGINATOR_ID ?? "") === ORIGINATOR_ID);
  }

  async updateDeal(id: string, fields: Record<string, string>): Promise<void> {
    await this.call("crm.deal.update", {
      id,
      fields,
      params: {
        REGISTER_SONET_EVENT: "Y"
      }
    });
  }

  async ensurePublishedAtField(): Promise<void> {
    const fields = await this.call("crm.deal.userfield.list", { order: { SORT: "ASC" } });
    const rows = Array.isArray(fields) ? fields as Array<{ FIELD_NAME?: string }> : [];
    if (rows.some((field) => field.FIELD_NAME === PUBLISHED_AT_FIELD)) return;

    await this.call("crm.deal.userfield.add", {
      fields: {
        FIELD_NAME: PUBLISHED_AT_FIELD,
        EDIT_FORM_LABEL: "GZ published detected at",
        LIST_COLUMN_LABEL: "GZ published detected at",
        USER_TYPE_ID: "string",
        XML_ID: "scrape2lead_gz_published_at",
        SORT: 530
      }
    });
  }

  private async callPaged<T>(method: string, body: Record<string, unknown>): Promise<T[]> {
    const result: T[] = [];
    let start: number | undefined = 0;
    while (start !== undefined) {
      const payload = await this.callRaw(method, { ...body, start });
      if (Array.isArray(payload.result)) result.push(...payload.result as T[]);
      else if (payload.result && typeof payload.result === "object") result.push(...Object.values(payload.result) as T[]);
      start = typeof payload.next === "number" ? payload.next : undefined;
    }
    return result;
  }

  private async call(method: string, body: unknown): Promise<unknown> {
    return (await this.callRaw(method, body)).result;
  }

  private async callRaw(method: string, body: unknown): Promise<{ result: unknown; next?: number; error?: string; error_description?: string }> {
    const response = await fetch(`${this.baseUrl}/${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as { result: unknown; next?: number; error?: string; error_description?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }
}

async function checkPlanStatus(planId: string, deal: BitrixDeal, token: string | null): Promise<StatusCheck> {
  if (token) {
    const apiStatus = await checkPlanStatusFromApi(planId, token);
    if (apiStatus) return apiStatus;
  }
  return checkPlanStatusFromHtml(planId, deal);
}

async function checkPlanStatusFromApi(planId: string, token: string): Promise<StatusCheck | null> {
  const payload = await goszakupGetJson(`/v2/plans/view/${planId}`, { token }) as Record<string, unknown>;
  const extracted = extractStatusFromObject(payload);
  if (!extracted.status && !extracted.statusId) return null;
  return {
    planId,
    status: extracted.status,
    statusId: extracted.statusId,
    published: isPublished(extracted.status, extracted.statusId),
    planUrl: buildPlanUrl(planId),
    source: "api"
  };
}

async function checkPlanStatusFromHtml(planId: string, deal: BitrixDeal): Promise<StatusCheck> {
  const planUrl = stringOrNull(deal.UF_CRM_PLAN_LINK)
    ?? stringOrNull(deal.UF_CRM_1782386571874_IU_XLS)
    ?? buildPlanUrl(planId);
  const planListNumber = extractPlanListNumber(planUrl);
  const searchUrl = planListNumber
    ? `https://goszakup.gov.kz/ru/registry/plan?filter%5Bnumber%5D=${encodeURIComponent(planListNumber)}&count_record=50`
    : planUrl;
  const response = await fetch(searchUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });
  if (!response.ok) throw new Error(`goszakup HTML HTTP ${response.status} for ${planUrl}`);

  const html = await response.text();
  const searchRows = parseGoszakupPlanSearchHtml(html, "status-check");
  const searchRow = searchRows.find((row) => row.plan_point_id === planId)
    ?? (planListNumber ? searchRows.find((row) => row.plan_list_number === planListNumber) : undefined);
  if (planListNumber && !searchRow) {
    throw new Error(`status row not found on goszakup search page ${searchUrl}`);
  }
  const extracted = searchRow
    ? { status: searchRow.status, statusId: searchRow.status === PUBLISHED_STATUS_NAME ? PUBLISHED_STATUS_ID : null }
    : extractStatusFromHtml(html);
  if (!extracted.status && !extracted.statusId) {
    throw new Error(`status not found on goszakup page ${searchUrl}`);
  }
  if (extracted.status && !KNOWN_STATUS_NAMES.has(normalizeRu(extracted.status))) {
    throw new Error(`unknown goszakup status "${extracted.status}" on ${searchUrl}`);
  }

  return {
    planId,
    status: extracted.status,
    statusId: extracted.statusId,
    published: isPublished(extracted.status, extracted.statusId),
    planUrl,
    source: "html"
  };
}

async function writeReports(report: Report): Promise<void> {
  fs.mkdirSync(path.dirname(report.jsonReportPath), { recursive: true });
  fs.writeFileSync(report.jsonReportPath, JSON.stringify(report, null, 2), "utf8");

  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 28 },
    { header: "Value", key: "value", width: 24 }
  ];
  summary.addRows([
    { metric: "Mode", value: report.mode },
    { metric: "Since", value: report.since },
    { metric: "Deals fetched", value: report.stats.dealsFetched },
    { metric: "Checked", value: report.stats.checked },
    { metric: "Published", value: report.stats.published },
    { metric: "Not published", value: report.stats.notPublished },
    { metric: "Updated", value: report.stats.updated },
    { metric: "Failed", value: report.stats.failed },
    { metric: "Skipped (not approved)", value: report.stats.skippedNotApproved },
    { metric: "No-op", value: report.stats.noOp },
    { metric: "Started at", value: report.startedAt },
    { metric: "Finished at", value: report.finishedAt ?? "" }
  ]);
  summary.getRow(1).font = { bold: true };

  addItemsSheet(workbook, "Published", report.published);
  addItemsSheet(workbook, "Not published", report.notPublished);
  const failed = workbook.addWorksheet("Failed");
  failed.columns = [
    { header: "Deal ID", key: "dealId", width: 12 },
    { header: "Origin ID", key: "originId", width: 18 },
    { header: "Title", key: "title", width: 70 },
    { header: "Message", key: "message", width: 80 }
  ];
  failed.addRows(report.failed);
  failed.getRow(1).font = { bold: true };

  fs.mkdirSync(path.dirname(report.xlsxReportPath), { recursive: true });
  await workbook.xlsx.writeFile(report.xlsxReportPath);
}

function addItemsSheet(workbook: ExcelJS.Workbook, name: string, items: ReportItem[]): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { header: "Deal ID", key: "dealId", width: 12 },
    { header: "Plan ID", key: "planId", width: 14 },
    { header: "Origin ID", key: "originId", width: 18 },
    { header: "Title", key: "title", width: 70 },
    { header: "Assigned by", key: "assignedById", width: 14 },
    { header: "Amount", key: "amount", width: 16 },
    { header: "Old status", key: "previousBitrixStatus", width: 18 },
    { header: "New status", key: "currentGoszakupStatus", width: 18 },
    { header: "Category", key: "categoryId", width: 12 },
    { header: "Status action", key: "statusAction", width: 22 },
    { header: "Skip reason", key: "skipReason", width: 48 },
    { header: "Published", key: "published", width: 12 },
    { header: "Updated in Bitrix", key: "updatedInBitrix", width: 18 },
    { header: "Plan URL", key: "planUrl", width: 60 },
    { header: "Checked at", key: "checkedAt", width: 24 }
  ];
  sheet.addRows(items);
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn("title").alignment = { wrapText: true };
  sheet.getColumn("planUrl").alignment = { wrapText: true };
}

function extractStatusFromObject(value: unknown): { status: string | null; statusId: string | null } {
  const stack: unknown[] = [value];
  let status: string | null = null;
  let statusId: string | null = null;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    for (const [key, raw] of Object.entries(current)) {
      if (raw && typeof raw === "object") stack.push(raw);
      const normalizedKey = key.toLocaleLowerCase("ru");
      if (!/(status|статус)/i.test(normalizedKey)) continue;

      if (/id$/i.test(normalizedKey) || /_id$/i.test(normalizedKey)) {
        const candidate = scalarText(raw);
        if (candidate) statusId ??= candidate;
      } else {
        const candidate = scalarText(raw);
        if (candidate) status ??= candidate;
      }
    }
  }

  return { status, statusId };
}

function extractStatusFromHtml(html: string): { status: string | null; statusId: string | null } {
  const text = cleanHtmlText(html);
  const statusPatterns = [
    /Статус\s+пункта\s+плана\s*[:\-]?\s*([А-Яа-яЁёA-Za-z0-9 .,\-]+?)(?=\s{2,}|Дата|Сумма|Цена|Количество|$)/iu,
    /Статус\s*[:\-]?\s*([А-Яа-яЁёA-Za-z0-9 .,\-]+?)(?=\s{2,}|Дата|Сумма|Цена|Количество|$)/iu
  ];

  for (const pattern of statusPatterns) {
    const match = text.match(pattern);
    const status = match?.[1]?.trim();
    if (status) return { status, statusId: status.includes(PUBLISHED_STATUS_NAME) ? PUBLISHED_STATUS_ID : null };
  }

  if (text.includes(PUBLISHED_STATUS_NAME)) {
    return { status: PUBLISHED_STATUS_NAME, statusId: PUBLISHED_STATUS_ID };
  }

  return { status: null, statusId: null };
}

function isPublished(status: string | null, statusId: string | null): boolean {
  return statusId === PUBLISHED_STATUS_ID || normalizeRu(status ?? "") === normalizeRu(PUBLISHED_STATUS_NAME);
}

function normalizeRu(value: string): string {
  return value.trim().toLocaleLowerCase("ru");
}

function extractPlanId(originId: string | null): string | null {
  const match = originId?.match(/^gz-plan:(\d+)$/);
  return match?.[1] ?? null;
}

function extractPlanListNumber(planUrl: string): string | null {
  const match = planUrl.match(/\/registry\/show_plan\/(\d+)\/\d+/i);
  return match?.[1] ?? null;
}

function buildPlanUrl(planId: string): string {
  return `https://goszakup.gov.kz/ru/registry/show_plan/${planId}`;
}

function cleanHtmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function scalarText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim() || null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text : null;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNonNegativeInt(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} must be a non-negative integer`);
  return Number.parseInt(value, 10);
}

function replaceExtension(filePath: string, extension: string): string {
  return path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${extension}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
