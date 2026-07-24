import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { chromium, type Browser, type Page } from "playwright";
import { parseAnnounceCustomer, type AnnounceCustomer } from "../src/kz/goszakupAnnounceCustomer.js";
import {
  callBitrixBatch,
  chunkBatchCommands,
  type BitrixBatchCommand
} from "../src/bitrix/batch.js";

dotenv.config();

const DEFAULT_INPUT = "exports/gz-lots-latest.xlsx";
const DEFAULT_CATEGORY_ID = 43;
const DEFAULT_STAGE_ID = "C43:NEW";
const DEFAULT_ASSIGNED_BY_ID = 2301;
const ORIGINATOR_ID = "scrape2lead-gz-lots";
const COMPANY_BIN_FIELD = "UF_CRM_666171B20E9E3";
const COMPANY_NAME_FIELD = "UF_CRM_666171B204419";
const DEFAULT_DELAY_MS = 1500;
const PAGE_TIMEOUT_MS = 60_000;

interface CliArgs {
  inputPath: string;
  execute: boolean;
  limit: number | null;
  categoryId: number;
  stageId: string;
  assignedById: number | null;
  webhookUrl: string | null;
  enrichCompany: boolean;
  delayMs: number;
}

interface GzLotRow {
  rowNumber: number;
  query: string;
  month: string;
  lotNumber: string;
  lotName: string;
  announceNumber: string;
  announceName: string;
  customer: string;
  quantity: string;
  amount: string;
  method: string;
  status: string;
  lotUrl: string;
  announceUrl: string;
  customerUrl: string;
}

interface ExistingDeal {
  ID: string;
  COMPANY_ID: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputPath: DEFAULT_INPUT,
    execute: false,
    limit: null,
    categoryId: DEFAULT_CATEGORY_ID,
    stageId: DEFAULT_STAGE_ID,
    assignedById: parseOptionalInt(process.env.BITRIX24_ASSIGNED_BY_ID) ?? DEFAULT_ASSIGNED_BY_ID,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    enrichCompany: true,
    delayMs: DEFAULT_DELAY_MS
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") args.inputPath = argv[++i] ?? args.inputPath;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--limit") args.limit = parseOptionalInt(argv[++i]);
    else if (arg === "--category-id") args.categoryId = Number(argv[++i]);
    else if (arg === "--stage-id") args.stageId = argv[++i] ?? args.stageId;
    else if (arg === "--assigned-by-id") args.assignedById = parseOptionalInt(argv[++i]);
    else if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else if (arg === "--no-company") args.enrichCompany = false;
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i]);
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

  const client = new BitrixClient(args.webhookUrl);
  const allRows = await readGzLotRows(args.inputPath);
  const rows = args.limit ? allRows.slice(0, args.limit) : allRows;

  console.log(`bitrix gz lots: mode=${args.execute ? "execute" : "dry-run"} cat=${args.categoryId} stage=${args.stageId} enrich_company=${args.enrichCompany}`);
  console.log(`input=${args.inputPath} rows_total=${allRows.length} rows_checked=${rows.length}`);

  const resolver = args.enrichCompany ? new CustomerResolver(args.delayMs) : null;
  const stats = { created: 0, updated: 0, companyLinked: 0, existing: 0, skipped: 0, failed: 0, binMissing: 0 };

  // Batch the existing-deal lookups (1 crm.deal.list per row → 50 per request)
  // before the sequential enrichment loop. Company/browser enrichment and the
  // create/link flow stay per-row and untouched.
  const existingDeals = await resolveLotExistingDeals(client, args.webhookUrl, rows);

  try {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const issues = validateRequired(row);
      if (issues.length > 0) {
        stats.skipped += 1;
        console.warn(`[skipped] row ${row.rowNumber} ${row.lotNumber || "?"}: ${issues.join("; ")}`);
        continue;
      }

      const dealOriginId = originId(row);
      try {
        const customer = resolver ? await resolver.resolve(row.announceUrl) : null;
        if (resolver && !customer) {
          stats.binMissing += 1;
          console.warn(`[bin-missing] ${dealOriginId}: no organizer BIN on ${row.announceUrl || "-"}`);
        }

        const existingDeal = existingDeals[rowIndex];
        const companyId = customer ? await resolveCompanyId(client, customer, args, args.execute) : null;

        if (existingDeal) {
          if (companyId && !hasCompany(existingDeal) && args.execute) {
            await client.updateDeal(existingDeal.ID, { COMPANY_ID: companyId });
            stats.companyLinked += 1;
            console.log(`[linked] ${dealOriginId} -> deal ${existingDeal.ID} company ${companyId}`);
          } else {
            stats.existing += 1;
            console.log(`[existing] ${dealOriginId} -> deal ${existingDeal.ID}${companyId ? ` company ${companyId}` : ""}`);
          }
          continue;
        }

        if (!args.execute) {
          console.log(`[dry-run] create ${dealOriginId}${customer ? ` bin=${customer.bin}` : ""} | ${buildTitle(row)}`);
          continue;
        }

        const dealId = await client.addDeal(buildDealFields(row, args, companyId));
        stats.created += 1;
        if (companyId) stats.companyLinked += 1;
        console.log(`[created] ${dealOriginId} -> deal ${dealId}${companyId ? ` company ${companyId}` : ""}`);
      } catch (error) {
        stats.failed += 1;
        console.error(`[failed] ${dealOriginId}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  } finally {
    if (resolver) await resolver.close();
  }

  console.log(
    `done: created=${stats.created} company_linked=${stats.companyLinked} existing=${stats.existing} skipped=${stats.skipped} bin_missing=${stats.binMissing} failed=${stats.failed}`
  );
}

/**
 * Batches existing-deal lookups for all valid rows. Rows whose batch command
 * fails fall back to the original per-row findDeal, so the classification and
 * counters are identical to the sequential path. Invalid rows are left null
 * (the loop skips them before the value is read) and never enrich anything.
 */
async function resolveLotExistingDeals(
  client: BitrixClient,
  webhookUrl: string,
  rows: GzLotRow[]
): Promise<Array<ExistingDeal | null>> {
  const existing: Array<ExistingDeal | null> = rows.map(() => null);
  const needsSequential = new Set<number>();

  const entries: Array<{ index: number; command: BitrixBatchCommand }> = [];
  for (let index = 0; index < rows.length; index++) {
    if (validateRequired(rows[index]).length > 0) continue;
    entries.push({
      index,
      command: {
        key: `lot_find_${index}`,
        method: "crm.deal.list",
        params: {
          filter: { ORIGINATOR_ID, ORIGIN_ID: originId(rows[index]) },
          select: ["ID", "COMPANY_ID"]
        }
      }
    });
  }

  for (const chunk of chunkBatchCommands(entries)) {
    let results;
    try {
      results = await callBitrixBatch(webhookUrl, chunk.map((entry) => entry.command));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[batch] ${chunk.length} lot lookups failed, falling back to sequential: ${message}`);
      for (const entry of chunk) needsSequential.add(entry.index);
      continue;
    }
    for (const entry of chunk) {
      const outcome = results.get(entry.command.key);
      if (!outcome || outcome.error) {
        needsSequential.add(entry.index);
        continue;
      }
      const deals = Array.isArray(outcome.result) ? outcome.result as Array<{ ID?: string | number; COMPANY_ID?: string | number | null }> : [];
      existing[entry.index] = mapLotExistingDeal(deals[0]);
    }
  }

  for (const index of needsSequential) {
    existing[index] = await client.findDeal(ORIGINATOR_ID, originId(rows[index]));
  }

  return existing;
}

function mapLotExistingDeal(first: { ID?: string | number; COMPANY_ID?: string | number | null } | undefined): ExistingDeal | null {
  if (!first?.ID) return null;
  return { ID: String(first.ID), COMPANY_ID: first.COMPANY_ID != null ? String(first.COMPANY_ID) : null };
}

async function resolveCompanyId(
  client: BitrixClient,
  customer: AnnounceCustomer,
  args: CliArgs,
  execute: boolean
): Promise<string | null> {
  const byBin = await client.findCompanyByBin(customer.bin);
  if (byBin) return byBin;

  const companyOriginId = `gz-company:${customer.bin}`;
  const byOrigin = await client.findCompanyByOrigin(companyOriginId);
  if (byOrigin) return byOrigin;

  if (!execute) return null;
  return client.addCompany(buildCompanyFields(customer, companyOriginId, args.assignedById));
}

class CustomerResolver {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly cache = new Map<string, AnnounceCustomer | null>();

  constructor(private readonly delayMs: number) {}

  async resolve(announceUrl: string): Promise<AnnounceCustomer | null> {
    if (!isHttpUrl(announceUrl)) return null;
    if (this.cache.has(announceUrl)) return this.cache.get(announceUrl) ?? null;

    const page = await this.ensurePage();
    let result: AnnounceCustomer | null = null;
    try {
      await page.goto(announceUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      await page.waitForTimeout(this.delayMs);
      result = parseAnnounceCustomer(await page.content());
    } catch (error) {
      console.warn(`customer resolve failed for ${announceUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.cache.set(announceUrl, result);
    return result;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext({ locale: "ru-RU", viewport: { width: 1400, height: 900 } });
    this.page = await context.newPage();
    return this.page;
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async findDeal(originatorId: string, dealOriginId: string): Promise<ExistingDeal | null> {
    const result = await this.call("crm.deal.list", {
      filter: { ORIGINATOR_ID: originatorId, ORIGIN_ID: dealOriginId },
      select: ["ID", "COMPANY_ID"]
    });
    const rows = Array.isArray(result) ? result as Array<{ ID?: string | number; COMPANY_ID?: string | number | null }> : [];
    const first = rows[0];
    if (!first?.ID) return null;
    return { ID: String(first.ID), COMPANY_ID: first.COMPANY_ID != null ? String(first.COMPANY_ID) : null };
  }

  async findCompanyByBin(bin: string): Promise<string | null> {
    const normalized = normalizeBin(bin);
    if (!normalized) return null;
    const result = await this.call("crm.company.list", {
      filter: { [COMPANY_BIN_FIELD]: normalized },
      select: ["ID"]
    });
    const rows = Array.isArray(result) ? result as Array<{ ID?: string | number }> : [];
    return rows[0]?.ID ? String(rows[0].ID) : null;
  }

  async findCompanyByOrigin(companyOriginId: string): Promise<string | null> {
    const result = await this.call("crm.company.list", {
      filter: { ORIGINATOR_ID, ORIGIN_ID: companyOriginId },
      select: ["ID"]
    });
    const rows = Array.isArray(result) ? result as Array<{ ID?: string | number }> : [];
    return rows[0]?.ID ? String(rows[0].ID) : null;
  }

  async addCompany(fields: Record<string, unknown>): Promise<string> {
    const result = await this.call("crm.company.add", { fields, params: { REGISTER_SONET_EVENT: "Y" } });
    return String(result);
  }

  async addDeal(fields: Record<string, unknown>): Promise<string> {
    const result = await this.call("crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "Y" } });
    return String(result);
  }

  async updateDeal(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.call("crm.deal.update", { id, fields });
  }

  private async call(method: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as { result: unknown; error?: string; error_description?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    }
    return payload.result;
  }
}

async function readGzLotRows(inputPath: string): Promise<GzLotRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error(`No worksheet found in ${inputPath}`);

  const rows: GzLotRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cell = (i: number) => cellText(row.getCell(i));
    const lotNumber = cell(3);
    if (!lotNumber) return;
    rows.push({
      rowNumber,
      query: cell(1),
      month: cell(2),
      lotNumber,
      lotName: cell(4),
      announceNumber: cell(5),
      announceName: cell(6),
      customer: cell(7),
      quantity: cell(8),
      amount: cell(9),
      method: cell(10),
      status: cell(11),
      lotUrl: cell(12),
      announceUrl: cell(13),
      customerUrl: cell(14)
    });
  });
  return rows;
}

function buildCompanyFields(customer: AnnounceCustomer, companyOriginId: string, assignedById: number | null): Record<string, unknown> {
  return stripUndefined({
    TITLE: customer.name || customer.bin,
    ASSIGNED_BY_ID: assignedById ?? undefined,
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: "scrape2lead gz lots search",
    ORIGINATOR_ID,
    ORIGIN_ID: companyOriginId,
    COMMENTS: `БИН: ${customer.bin}\nЮр. адрес: ${customer.legalAddress || "-"}`,
    [COMPANY_BIN_FIELD]: customer.bin,
    [COMPANY_NAME_FIELD]: customer.name || undefined
  });
}

function buildDealFields(row: GzLotRow, args: CliArgs, companyId: string | null): Record<string, unknown> {
  return stripUndefined({
    TITLE: buildTitle(row),
    TYPE_ID: "SALE",
    CATEGORY_ID: args.categoryId,
    STAGE_ID: args.stageId,
    ASSIGNED_BY_ID: args.assignedById ?? undefined,
    COMPANY_ID: companyId ?? undefined,
    CURRENCY_ID: "KZT",
    OPPORTUNITY: parseMoney(row.amount),
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: "scrape2lead gz lots search (Опубликован)",
    ORIGINATOR_ID,
    ORIGIN_ID: originId(row),
    COMMENTS: buildComments(row),
    UF_CRM_6627AEBD4503E: row.method,
    UF_CRM_6627AEBD54B8D: row.lotName,
    UF_CRM_6627AEBD67FFF: row.quantity,
    UF_CRM_6627AEBD72587: row.customer,
    UF_CRM_6627AEBD85B4D: row.status
  });
}

function buildComments(row: GzLotRow): string {
  return [
    `GZ лот: ${row.lotNumber} (${row.lotName})`,
    `Объявление: ${row.announceNumber} — ${row.announceName}`,
    `Заказчик: ${row.customer}`,
    `Способ закупки: ${row.method}`,
    `Статус: ${row.status}`,
    `Количество: ${row.quantity}`,
    `Сумма: ${row.amount} KZT`,
    `Месяц поставки: ${row.month}`,
    `Поисковый запрос: ${row.query}`,
    `Лот: ${row.lotUrl}`,
    `Объявление: ${row.announceUrl}`,
    `Заказчик (реестр): ${row.customerUrl}`
  ].join("\n");
}

function buildTitle(row: GzLotRow): string {
  return `[GZ лот ${row.lotNumber}] ${row.customer} — ${row.lotName}`.slice(0, 250);
}

function originId(row: GzLotRow): string {
  return `gz-lot:${row.lotNumber}`;
}

function hasCompany(deal: ExistingDeal): boolean {
  return Boolean(deal.COMPANY_ID) && deal.COMPANY_ID !== "0";
}

function validateRequired(row: GzLotRow): string[] {
  const issues: string[] = [];
  if (!row.lotNumber) issues.push("missing lot number");
  if (!row.customer) issues.push("missing customer");
  if (parseMoney(row.amount) <= 0) issues.push("missing or invalid amount");
  return issues;
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

function normalizeBin(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length === 12 ? digits : null;
}

function parseMoney(value: string): number {
  const parsed = Number(value.replace(/[\s ]+/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
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
