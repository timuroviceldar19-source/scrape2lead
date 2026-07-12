import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import {
  loadGzRoutingConfig,
  resolveGzRoute,
  type GzRoute,
  type GzRoutingConfig
} from "../src/bitrix/gzDealRouting.js";

dotenv.config();

interface CliArgs {
  inputPath: string;
  execute: boolean;
  updateExisting: boolean;
  limit: number | null;
  assignedById: number | null;
  categoryId: number;
  stageId: string;
  webhookUrl: string | null;
  routingPath: string;
  minAmount: number;
}

interface GzPlanRow {
  rowNumber: number;
  bin: string;
  customerName: string;
  website: string;
  email: string;
  phone: string;
  reportingAdministrator: string;
  address: string;
  directorName: string;
  truCode: string;
  itemName: string;
  itemUrl: string;
  unit: string;
  quantity: string;
  price: string;
  extraSpec: string;
  keyword: string;
  planNumber: string;
  planId: string;
  plannedMonth: string;
  status: string;
  amount: string;
  purchaseMethod: string;
  customerUrl: string;
  planUrl: string;
  shortSpec: string;
  extraDescription: string;
  deliveryPlace: string;
}

interface ExistingDeal {
  ID?: string | number;
  TITLE?: string | null;
  COMPANY_ID?: string | number | null;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
  OPPORTUNITY?: string | number | null;
}

interface PreflightItem {
  row: GzPlanRow;
  originId: string;
  existingDealId: string | null;
  duplicateDealId: string | null;
  duplicateReason: string | null;
  route: GzRoute;
  action: "create" | "update" | "existing" | "duplicate" | "skip";
  issues: string[];
  warnings: string[];
}

const DEFAULT_INPUT = "exports/gz-plans-latest.xlsx";
const DEFAULT_ROUTING_CONFIG = "config/bitrix-gz-routing.json";
const ORIGINATOR_ID = "scrape2lead-gz-plans";
const DEFAULT_ASSIGNED_BY_ID = 2301;
const COMPANY_BIN_FIELD = "UF_CRM_666171B20E9E3";
// Plan line items priced at 1 tg (or below) are placeholders, not real budgets. Skip them by default.
const DEFAULT_MIN_AMOUNT = 1000;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputPath: DEFAULT_INPUT,
    execute: false,
    updateExisting: false,
    limit: null,
    assignedById: parseOptionalInt(process.env.BITRIX24_ASSIGNED_BY_ID) ?? DEFAULT_ASSIGNED_BY_ID,
    categoryId: 0,
    stageId: "NEW",
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    routingPath: DEFAULT_ROUTING_CONFIG,
    minAmount: DEFAULT_MIN_AMOUNT
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") args.inputPath = argv[++i] ?? args.inputPath;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--update-existing") args.updateExisting = true;
    else if (arg === "--limit") args.limit = parseOptionalInt(argv[++i]);
    else if (arg === "--assigned-by-id") args.assignedById = parseOptionalInt(argv[++i]);
    else if (arg === "--category-id") args.categoryId = Number(argv[++i]);
    else if (arg === "--stage-id") args.stageId = argv[++i] ?? args.stageId;
    else if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else if (arg === "--routing") args.routingPath = argv[++i] ?? DEFAULT_ROUTING_CONFIG;
    else if (arg === "--min-amount") args.minAmount = Number(argv[++i]);
  }

  return args;
}

/**
 * Routing config maps each row to a B2G pipeline by ENSTRU code / keywords.
 * When the config file is absent, every row falls back to --category-id /
 * --stage-id (pre-routing behaviour).
 */
function loadRoutingOrFallback(args: CliArgs): GzRoutingConfig {
  if (fs.existsSync(args.routingPath)) {
    return loadGzRoutingConfig(args.routingPath);
  }
  console.warn(`routing config ${args.routingPath} not found; using --category-id=${args.categoryId} --stage-id=${args.stageId} for all rows`);
  return {
    rules: [],
    default: { categoryId: args.categoryId, stageId: args.stageId }
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

  const client = new BitrixClient(args.webhookUrl);
  if (args.execute) {
    await client.ensureDealDetailsFields([
      "UF_CRM_1782274598760",
      "UF_CRM_6A436D5A5700E",
      "UF_CRM_1715597726664",
      "UF_CRM_MONTH",
      "UF_CRM_1782386433277_IU_XLS"
    ]);
  }

  const routing = loadRoutingOrFallback(args);
  const allRows = await readGzPlanRows(args.inputPath);
  const rows = args.limit ? allRows.slice(0, args.limit) : allRows;
  const preflight: PreflightItem[] = [];

  for (const row of rows) {
    const existingDeal = await client.findDeal(ORIGINATOR_ID, originId(row));
    const duplicateDeal = existingDeal?.ID ? null : await client.findPotentialDuplicateDeal(row);
    const issues = validateRequired(row, args.minAmount);
    const warnings = validateWarnings(row);
    const action: PreflightItem["action"] = issues.length > 0
      ? "skip"
      : existingDeal?.ID
        ? (args.updateExisting ? "update" : "existing")
        : duplicateDeal
          ? "duplicate"
        : "create";
    preflight.push({
      row,
      originId: originId(row),
      existingDealId: existingDeal?.ID ? String(existingDeal.ID) : null,
      duplicateDealId: duplicateDeal ? String(duplicateDeal.deal.ID ?? "") : null,
      duplicateReason: duplicateDeal?.reason ?? null,
      route: resolveGzRoute(row, routing),
      action,
      issues,
      warnings
    });
  }

  printPreflight(args, allRows.length, preflight);

  for (const item of preflight) {
    if (item.action === "skip") {
      console.warn(`[skipped] ${item.originId}: ${item.issues.join("; ")}`);
      continue;
    }
    if (item.action === "existing") {
      console.log(`[existing] ${item.originId} -> deal ${item.existingDealId}`);
      continue;
    }
    if (item.action === "duplicate") {
      console.log(`[duplicate] ${item.originId} -> deal ${item.duplicateDealId} (${item.duplicateReason})`);
      continue;
    }
    if (!args.execute) {
      console.log(`[dry-run] ${item.action} ${item.originId} -> cat ${item.route.categoryId} (${item.route.ruleName}) | ${buildTitle(item.row)}`);
      continue;
    }

    try {
      if (item.action === "update") {
        if (!item.existingDealId) throw new Error("existing deal id is missing");
        await client.updateDeal(item.existingDealId, buildDealUpdateFields(item.row));
        console.log(`[updated] ${item.originId} -> deal ${item.existingDealId}`);
        continue;
      }

      const companyId = await findOrCreateCompany(client, item.row, args.assignedById);
      const dealId = await client.addDeal(buildDealCreateFields(item.row, item.route, args.assignedById, companyId));
      console.log(`[created] ${item.originId} -> deal ${dealId} cat ${item.route.categoryId} company ${companyId}`);
    } catch (error) {
      console.error(`[failed] ${item.originId}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async findDeal(originatorId: string, dealOriginId: string): Promise<ExistingDeal | null> {
    const result = await this.call("crm.deal.list", {
      filter: {
        ORIGINATOR_ID: originatorId,
        ORIGIN_ID: dealOriginId
      },
      select: ["ID", "TITLE", "COMPANY_ID", "ORIGINATOR_ID", "ORIGIN_ID", "OPPORTUNITY"]
    });
    const rows = Array.isArray(result) ? result : [];
    return (rows[0] as ExistingDeal | undefined) ?? null;
  }

  async findPotentialDuplicateDeal(row: GzPlanRow): Promise<{ deal: ExistingDeal; reason: string } | null> {
    const searches: Array<{ reason: string; filter: Record<string, unknown> }> = [];
    if (row.planId) {
      searches.push({ reason: "plan point id", filter: { UF_CRM_6A436D5A3614C: row.planId } });
    }
    if (row.planNumber) {
      searches.push({ reason: "plan number", filter: { UF_CRM_PLAN_ID: row.planNumber } });
    }
    if (row.planUrl) {
      searches.push({ reason: "plan url", filter: { UF_CRM_PLAN_LINK: row.planUrl } });
      searches.push({ reason: "plan url alt", filter: { UF_CRM_1782386571874_IU_XLS: row.planUrl } });
    }
    const bin = normalizeBin(row.bin);
    const amount = parseMoney(row.amount);
    if (bin && amount > 0) {
      searches.push({ reason: "BIN + amount", filter: { UF_CRM_6627AEBD7C2D2: bin, OPPORTUNITY: amount } });
    }

    const seen = new Set<string>();
    for (const search of searches) {
      const result = await this.call("crm.deal.list", {
        filter: search.filter,
        select: ["ID", "TITLE", "COMPANY_ID", "ORIGINATOR_ID", "ORIGIN_ID", "OPPORTUNITY"]
      });
      const rows = Array.isArray(result) ? result as ExistingDeal[] : [];
      for (const deal of rows) {
        const id = String(deal.ID ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (String(deal.ORIGINATOR_ID ?? "") === ORIGINATOR_ID && String(deal.ORIGIN_ID ?? "") === originId(row)) {
          continue;
        }
        return { deal, reason: search.reason };
      }
    }

    return null;
  }

  async findCompanyByBin(bin: string): Promise<string | null> {
    const normalized = normalizeBin(bin);
    if (!normalized) return null;
    const result = await this.call("crm.company.list", {
      filter: { [COMPANY_BIN_FIELD]: normalized },
      select: ["ID", "TITLE", COMPANY_BIN_FIELD]
    });
    const rows = Array.isArray(result) ? result : [];
    const first = rows[0] as { ID?: string | number } | undefined;
    return first?.ID ? String(first.ID) : null;
  }

  async findCompanyByOrigin(companyOriginId: string): Promise<string | null> {
    const result = await this.call("crm.company.list", {
      filter: {
        ORIGINATOR_ID,
        ORIGIN_ID: companyOriginId
      },
      select: ["ID"]
    });
    const rows = Array.isArray(result) ? result : [];
    const first = rows[0] as { ID?: string | number } | undefined;
    return first?.ID ? String(first.ID) : null;
  }

  async addCompany(fields: Record<string, unknown>): Promise<string> {
    const result = await this.call("crm.company.add", {
      fields,
      params: {
        REGISTER_SONET_EVENT: "Y"
      }
    });
    return String(result);
  }

  async addDeal(fields: Record<string, unknown>): Promise<string> {
    const result = await this.call("crm.deal.add", {
      fields,
      params: {
        REGISTER_SONET_EVENT: "Y"
      }
    });
    return String(result);
  }

  async updateDeal(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.call("crm.deal.update", {
      id,
      fields,
      params: {
        REGISTER_SONET_EVENT: "Y"
      }
    });
  }

  async ensureDealDetailsFields(fieldNames: string[]): Promise<void> {
    const configuration = await this.call("crm.deal.details.configuration.get", {
      scope: "C",
      categoryId: 0
    });
    if (!Array.isArray(configuration)) return;

    const sections = configuration as DealDetailsSection[];
    let targetSection = sections.find((section) => section.name === "additional");
    if (!targetSection) {
      targetSection = {
        name: "additional",
        title: "Additional",
        type: "section",
        elements: []
      };
      sections.push(targetSection);
    }
    targetSection.elements ??= [];

    let changed = false;
    for (const fieldName of fieldNames) {
      const existing = targetSection.elements.find((element) => element.name === fieldName);
      if (existing) {
        if (existing.optionFlags !== "0") {
          existing.optionFlags = "0";
          changed = true;
        }
        continue;
      }

      targetSection.elements.push({
        name: fieldName,
        optionFlags: "0"
      });
      changed = true;
    }

    if (changed) {
      await this.call("crm.deal.details.configuration.set", {
        scope: "C",
        categoryId: 0,
        data: sections
      });
    }
  }

  private async call(method: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/${method}.json`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as { result: unknown; error?: string; error_description?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    }
    return payload.result;
  }
}

interface DealDetailsSection {
  name: string;
  title: string;
  type: "section";
  elements?: Array<{
    name: string;
    optionFlags?: string | number;
    options?: Record<string, unknown>;
  }>;
}

async function findOrCreateCompany(client: BitrixClient, row: GzPlanRow, assignedById: number | null): Promise<string> {
  const byBin = await client.findCompanyByBin(row.bin);
  if (byBin) return byBin;

  const byOrigin = await client.findCompanyByOrigin(companyOriginId(row));
  if (byOrigin) return byOrigin;

  return client.addCompany(buildCompanyFields(row, assignedById));
}

async function readGzPlanRows(inputPath: string): Promise<GzPlanRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error(`No worksheet found in ${inputPath}`);

  const rows: GzPlanRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const planId = cellText(row.getCell(19));
    if (!planId) return;

    rows.push({
      rowNumber,
      bin: cellText(row.getCell(1)),
      customerName: cellText(row.getCell(2)),
      website: cellText(row.getCell(3)),
      email: cellText(row.getCell(4)),
      phone: cellText(row.getCell(5)),
      reportingAdministrator: cellText(row.getCell(6)),
      address: cellText(row.getCell(7)),
      directorName: cellText(row.getCell(8)),
      truCode: cellText(row.getCell(10)),
      itemName: cellText(row.getCell(11)),
      itemUrl: cellText(row.getCell(12)),
      unit: cellText(row.getCell(13)),
      quantity: cellText(row.getCell(14)),
      price: cellText(row.getCell(15)),
      extraSpec: cellText(row.getCell(16)),
      keyword: cellText(row.getCell(17)),
      planNumber: cellText(row.getCell(18)),
      planId,
      plannedMonth: cellText(row.getCell(20)),
      status: cellText(row.getCell(21)),
      amount: cellText(row.getCell(22)),
      purchaseMethod: cellText(row.getCell(23)),
      customerUrl: cellText(row.getCell(24)),
      planUrl: cellText(row.getCell(25)),
      shortSpec: cellText(row.getCell(26)),
      extraDescription: cellText(row.getCell(27)),
      deliveryPlace: cellText(row.getCell(28))
    });
  });
  return rows;
}

function buildCompanyFields(row: GzPlanRow, assignedById: number | null): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    TITLE: row.customerName || row.bin || `GZ plan ${row.planId}`,
    ASSIGNED_BY_ID: assignedById ?? undefined,
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: "scrape2lead gz-plans",
    ORIGINATOR_ID,
    ORIGIN_ID: companyOriginId(row),
    COMMENTS: buildComments(row),
    UF_CRM_666171B204419: row.customerName,
    [COMPANY_BIN_FIELD]: normalizeBin(row.bin) ?? row.bin,
    UF_CRM_1782385360978_IU_XLS: row.address,
    UF_CRM_1782385389103_IU_XLS: row.directorName,
    UF_CRM_1782385532195_IU_XLS: row.planUrl,
    UF_CRM_1782386541642_IU_XLS: row.customerUrl
  };
  if (row.phone) fields.PHONE = [{ VALUE: row.phone, VALUE_TYPE: "WORK" }];
  const email = normalizeEmail(row.email);
  if (email) fields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
  if (row.website) fields.WEB = [{ VALUE: row.website, VALUE_TYPE: "WORK" }];
  return stripUndefined(fields);
}

function buildDealCreateFields(row: GzPlanRow, route: GzRoute, assignedById: number | null, companyId: string): Record<string, unknown> {
  return stripUndefined({
    ...buildDealGzFields(row),
    TYPE_ID: "SALE",
    CATEGORY_ID: route.categoryId,
    STAGE_ID: route.stageId,
    COMPANY_ID: companyId,
    ASSIGNED_BY_ID: assignedById ?? undefined
  });
}

function buildDealUpdateFields(row: GzPlanRow): Record<string, unknown> {
  return buildDealGzFields(row);
}

function buildDealGzFields(row: GzPlanRow): Record<string, unknown> {
  return stripUndefined({
    TITLE: buildTitle(row),
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: "scrape2lead gz-plans",
    ORIGINATOR_ID,
    ORIGIN_ID: originId(row),
    CURRENCY_ID: "KZT",
    OPPORTUNITY: parseMoney(row.amount),
    COMMENTS: buildComments(row),
    UF_CRM_1705406174976: 57,
    UF_CRM_1711518716644: row.unit,
    UF_CRM_6627AEBD4503E: row.purchaseMethod,
    UF_CRM_6627AEBD54B8D: row.itemName,
    UF_CRM_6627AEBD5E68B: row.price,
    UF_CRM_6627AEBD67FFF: row.quantity,
    UF_CRM_6627AEBD72587: row.customerName,
    UF_CRM_6627AEBD7C2D2: row.bin,
    UF_CRM_6627AEBD85B4D: row.status,
    UF_CRM_1715597423325: formatMoneyForBitrixRobot(row.amount),
    UF_CRM_1715597726664: row.plannedMonth,
    UF_CRM_1782274598760: row.customerUrl,
    UF_CRM_1782386080157_IU_XLS: row.itemUrl,
    UF_CRM_1782386193634_IU_XLS: row.extraSpec,
    UF_CRM_1782386244985_IU_XLS: row.keyword,
    UF_CRM_1782386293000_IU_XLS: row.planNumber,
    UF_CRM_1782386433277_IU_XLS: row.plannedMonth,
    UF_CRM_1782386571874_IU_XLS: row.planUrl,
    UF_CRM_6A436D598EC82: row.reportingAdministrator,
    UF_CRM_6A436D59AACBF: row.address,
    UF_CRM_6A436D59CD2B1: row.directorName,
    UF_CRM_6A436D5A19612: row.truCode,
    UF_CRM_6A436D5A3614C: row.planId,
    UF_CRM_6A436D5A5700E: row.customerUrl,
    UF_CRM_6A436D5A76648: row.shortSpec,
    UF_CRM_6A436D5A92D16: row.extraDescription,
    UF_CRM_6A436D5AD0A2B: row.deliveryPlace,
    UF_CRM_PLAN_ID: row.planNumber,
    UF_CRM_PLAN_LINK: row.planUrl,
    UF_CRM_PLAN_STATUS: row.status,
    UF_CRM_MONTH: row.plannedMonth,
    UF_CRM_REF_ENSTRU_CODE: row.truCode,
    UF_CRM_ENSTRU_NAME: row.itemName,
    UF_CRM_UNIT_NAME: row.unit,
    UF_CRM_COUNT: row.quantity,
    UF_CRM_PRICE_PER_UNIT: row.price ? `${parseMoney(row.price)}|KZT` : undefined,
    UF_CRM_DELIVERY_ADDRESSES: row.deliveryPlace || row.address
  });
}

function validateRequired(row: GzPlanRow, minAmount: number): string[] {
  const issues: string[] = [];
  if (!row.planId) issues.push("missing plan ID");
  if (!row.planNumber) issues.push("missing plan number");
  if (!row.customerName) issues.push("missing customer");
  if (!normalizeBin(row.bin)) issues.push("missing or invalid BIN");
  const amount = parseMoney(row.amount);
  if (amount <= 0) issues.push("missing or invalid amount");
  else if (amount < minAmount) issues.push(`amount ${amount} below min ${minAmount}`);
  if (!isHttpUrl(row.planUrl)) issues.push("missing or invalid plan URL");
  if (!row.plannedMonth) issues.push("missing planned month");
  return issues;
}

function validateWarnings(row: GzPlanRow): string[] {
  const warnings: string[] = [];
  const amount = parseMoney(row.amount);
  if (amount > 0 && amount < 1000) warnings.push(`suspicious low amount=${amount}`);
  if (row.customerUrl && !isHttpUrl(row.customerUrl)) warnings.push("invalid customer URL");
  if (row.itemUrl && !isHttpUrl(row.itemUrl)) warnings.push("invalid item URL");
  return warnings;
}

function printPreflight(args: CliArgs, totalRows: number, items: PreflightItem[]): void {
  const count = (action: PreflightItem["action"]) => items.filter((item) => item.action === action).length;
  const warningCount = items.reduce((sum, item) => sum + item.warnings.length, 0);
  const issueCount = items.reduce((sum, item) => sum + item.issues.length, 0);
  console.log(`bitrix gz deals: mode=${args.execute ? "execute" : "dry-run"} update_existing=${args.updateExisting}`);
  console.log(`input=${path.normalize(args.inputPath)} rows_total=${totalRows} rows_checked=${items.length}`);
  console.log(`preflight: create=${count("create")} update=${count("update")} existing=${count("existing")} duplicate=${count("duplicate")} skipped=${count("skip")} issues=${issueCount} warnings=${warningCount}`);
  const routeCounts = new Map<string, number>();
  for (const item of items) {
    const key = `cat ${item.route.categoryId} (${item.route.ruleName})`;
    routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
  }
  console.log(`routing: ${[...routeCounts.entries()].map(([key, n]) => `${key}=${n}`).join(" ")}`);
  for (const item of items.filter((row) => row.action === "duplicate").slice(0, 10)) {
    console.log(`[preflight-duplicate] row ${item.row.rowNumber} ${item.originId} -> deal ${item.duplicateDealId} (${item.duplicateReason})`);
  }
  for (const item of items.filter((row) => row.issues.length > 0 || row.warnings.length > 0).slice(0, 10)) {
    console.log(`[preflight] row ${item.row.rowNumber} ${item.originId} issues=${item.issues.join("|") || "-"} warnings=${item.warnings.join("|") || "-"}`);
  }
}

function buildComments(row: GzPlanRow): string {
  return [
    `GZ plan ID: ${row.planId}`,
    `GZ plan number: ${row.planNumber || "-"}`,
    `BIN: ${row.bin || "-"}`,
    `Customer: ${row.customerName || "-"}`,
    `Item: ${row.itemName || "-"}`,
    `Amount: ${row.amount || "-"}`
  ].join("\n");
}

function buildTitle(row: GzPlanRow): string {
  return `[GZ ${row.planNumber || row.planId}] ${row.customerName || row.bin} - ${row.itemName || row.keyword}`.slice(0, 250);
}

function originId(row: GzPlanRow): string {
  return `gz-plan:${row.planId}`;
}

function companyOriginId(row: GzPlanRow): string {
  const bin = normalizeBin(row.bin);
  return bin ? `gz-company:${bin}` : originId(row);
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((part) => part.text ?? "").join("").trim();
    if ("result" in value) return String(value.result ?? "").trim();
  }
  return String(value).trim();
}

function normalizeEmail(value: string): string | null {
  const email = value.split(/[;,]/)[0]?.trim() ?? value.trim();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizeBin(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length === 12 ? digits : null;
}

function parseMoney(value: string): number {
  const normalized = normalizeMoneyText(value).replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoneyForBitrixRobot(value: string): string {
  const parsed = parseMoney(value);
  return parsed > 0 ? parsed.toFixed(2) : "";
}

function normalizeMoneyText(value: string): string {
  const compact = value.replace(/[\s\u00a0]+/g, "").trim();
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    return compact
      .replaceAll(thousandsSeparator, "")
      .replace(decimalSeparator, ".");
  }

  if (lastComma >= 0) return compact.replace(",", ".");
  return compact;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function stripUndefined<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== "")
  ) as T;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
