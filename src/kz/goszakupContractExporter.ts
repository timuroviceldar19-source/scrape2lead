import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { chromium, type Browser, type Page } from "playwright";
import { sleep } from "./csv.js";
import { parseGoszakupLotsHtml } from "./goszakupHtmlParser.js";
import { buildLotsNstruSearchUrl } from "./goszakupLotsNstruExporter.js";
import {
  type ContractSearchItem,
  parseContractGeneralHtml,
  parseContractPartiesHtml,
  parseContractSearchHtml,
  parseContractUnitsHtml
} from "./goszakupContractParser.js";

const BASE_URL = "https://www.goszakup.gov.kz";
const DEFAULT_RECORDS_PER_PAGE = 50;

export type ContractPageLoader = (url: string) => Promise<string>;

export interface GoszakupContractExportOptions {
  codes: string[];
  from: string;
  to: string;
  outPath: string;
  maxPages?: number;
  limit?: number;
  delayMs?: number;
  recordsPerPage?: number;
  headless?: boolean;
  slowMoMs?: number;
  pageLoadTimeoutMs?: number;
  retries?: number;
  pageLoader?: ContractPageLoader;
  onProgress?: (message: string) => void;
}

export interface GoszakupContractExportResult {
  xlsxPath: string;
  rows: number;
  codes: number;
  missingIdentifiers: number;
  skippedOutOfRange: number;
  skippedCodeMismatch: number;
  warnings: string[];
}

interface ExportRow {
  contractId: string;
  customerBin: string;
  customerName: string;
  supplierBinIin: string;
  supplierName: string;
  searchCode: string;
}

export function buildContractSearchUrl(options: {
  code: string;
  from: string;
  to: string;
  page?: number;
  recordsPerPage?: number;
}): string {
  const params = new URLSearchParams();
  params.set("filter[start_date_from]", options.from);
  params.set("filter[start_date_to]", options.to);
  params.set("filter[enstru]", options.code);
  params.set("count_record", String(options.recordsPerPage ?? DEFAULT_RECORDS_PER_PAGE));
  if (options.page && options.page > 1) params.set("page", String(options.page));
  return `${BASE_URL}/ru/registry/contract?${params.toString()}`;
}

export async function exportGoszakupContracts(
  options: GoszakupContractExportOptions
): Promise<GoszakupContractExportResult> {
  const codes = unique(options.codes.map((code) => code.trim()).filter(Boolean));
  if (codes.length === 0) throw new Error("At least one ENSTRU code is required");
  assertIsoDate(options.from, "from");
  assertIsoDate(options.to, "to");
  if (options.from > options.to) throw new Error("from date must not be after to date");
  const maxPages = options.maxPages ?? 500;
  const recordsPerPage = options.recordsPerPage ?? DEFAULT_RECORDS_PER_PAGE;
  const delayMs = options.delayMs ?? 750;
  const rows: ExportRow[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let missingIdentifiers = 0;
  let skippedOutOfRange = 0;
  let skippedCodeMismatch = 0;

  const browserLoader = options.pageLoader ? null : await createBrowserPageLoader(options);
  const pageLoader = options.pageLoader ?? browserLoader!.load;
  try {
    for (const code of codes) {
      try {
        const discovered = await discoverContractsByCode(pageLoader, {
          code,
          from: options.from,
          to: options.to,
          maxPages,
          recordsPerPage,
          onProgress: options.onProgress
        });
        if (discovered.usedLotsFallback) {
          warnings.push(`${code}: contract ENSTRU filter returned no rows; fallback via lots and purchase numbers used`);
        }
        for (const item of discovered.items) {
            if (options.limit !== undefined && rows.length >= options.limit) break;
            const key = `${item.contractId}:${code}`;
            if (seen.has(key)) continue;
            const generalUrl = `${BASE_URL}/ru/egzcontract/cpublic/show/${item.contractId}`;
            const unitsUrl = `${BASE_URL}/ru/egzcontract/cpublic/units/${item.contractId}`;
            const partiesUrl = `${BASE_URL}/ru/egzcontract/cpublic/customer_n_supplier/${item.contractId}`;
            const general = parseContractGeneralHtml(await pageLoader(generalUrl));
            const signedDate = general.signedAt?.slice(0, 10) ?? null;
            if (!signedDate || signedDate < options.from || signedDate > options.to) {
              skippedOutOfRange++;
              warnings.push(`${item.contractId}: signing date is missing or outside requested range`);
              seen.add(key);
              continue;
            }
            const unitCodes = parseContractUnitsHtml(await pageLoader(unitsUrl));
            if (!unitCodes.includes(code)) {
              skippedCodeMismatch++;
              warnings.push(`${item.contractId}: requested ENSTRU code ${code} not found in contract units`);
              seen.add(key);
              continue;
            }
            const parties = parseContractPartiesHtml(await pageLoader(partiesUrl));
            if (!parties.customerBin || !parties.supplierBinIin) {
              missingIdentifiers++;
              warnings.push(`${item.contractId}: customer or supplier identifier is missing`);
            }
            rows.push({ contractId: item.contractId, ...parties, searchCode: code });
            seen.add(key);
            if (delayMs > 0) await sleep(delayMs);
        }
      } catch (error) {
        throw new Error(`Incomplete contract crawl for ${code}: ${messageOf(error)}`, { cause: error });
      }
      if (options.limit !== undefined && rows.length >= options.limit) break;
    }
  } finally {
    await browserLoader?.close();
  }

  await writeContractWorkbook(options.outPath, rows);
  return {
    xlsxPath: options.outPath,
    rows: rows.length,
    codes: codes.length,
    missingIdentifiers,
    skippedOutOfRange,
    skippedCodeMismatch,
    warnings
  };
}

async function discoverContractsByCode(
  pageLoader: ContractPageLoader,
  options: {
    code: string;
    from: string;
    to: string;
    maxPages: number;
    recordsPerPage: number;
    onProgress?: (message: string) => void;
  }
): Promise<{ items: ContractSearchItem[]; usedLotsFallback: boolean }> {
  const primary: ContractSearchItem[] = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    assertPageWithinLimit(page, options.maxPages);
    options.onProgress?.(`search code=${options.code} page=${page}/${totalPages}`);
    const url = buildContractSearchUrl({ ...options, page });
    const search = parseContractSearchHtml(await pageLoader(url), options.recordsPerPage);
    if (page === 1) totalPages = search.pagination.totalPages;
    primary.push(...search.items);
  }
  if (primary.length > 0) return { items: uniqueContracts(primary), usedLotsFallback: false };

  options.onProgress?.(`contract filter empty for code=${options.code}; discovering purchases via lots`);
  const purchaseNumbers = new Set<string>();
  for (const period of monthsInRange(options.from, options.to)) {
    let lotPages = 1;
    for (let page = 1; page <= lotPages; page++) {
      assertPageWithinLimit(page, options.maxPages);
      options.onProgress?.(`lots fallback code=${options.code} year=${period.year} month=${period.month} page=${page}/${lotPages}`);
      const url = buildLotsNstruSearchUrl({
        nstruCode: options.code,
        year: period.year,
        month: period.month,
        pageNum: page - 1,
        recordsPerPage: options.recordsPerPage
      });
      const html = await pageLoader(url);
      if (page === 1) lotPages = parseTotalPages(html, options.recordsPerPage);
      for (const lot of parseGoszakupLotsHtml(html)) {
        if (lot.announce_number) purchaseNumbers.add(lot.announce_number);
      }
    }
  }

  const fallback: ContractSearchItem[] = [];
  for (const purchaseNumber of purchaseNumbers) {
    let contractPages = 1;
    for (let page = 1; page <= contractPages; page++) {
      assertPageWithinLimit(page, options.maxPages);
      options.onProgress?.(`contract fallback purchase=${purchaseNumber} page=${page}/${contractPages}`);
      const url = buildContractPurchaseSearchUrl({
        purchaseNumber,
        from: options.from,
        to: options.to,
        page,
        recordsPerPage: options.recordsPerPage
      });
      const search = parseContractSearchHtml(await pageLoader(url), options.recordsPerPage);
      if (page === 1) contractPages = search.pagination.totalPages;
      fallback.push(...search.items);
    }
  }
  return { items: uniqueContracts(fallback), usedLotsFallback: true };
}

function buildContractPurchaseSearchUrl(options: {
  purchaseNumber: string;
  from: string;
  to: string;
  page: number;
  recordsPerPage: number;
}): string {
  const params = new URLSearchParams();
  params.set("filter[start_date_from]", options.from);
  params.set("filter[start_date_to]", options.to);
  params.set("filter[buy_id]", options.purchaseNumber);
  params.set("count_record", String(options.recordsPerPage));
  if (options.page > 1) params.set("page", String(options.page));
  return `${BASE_URL}/ru/registry/contract?${params.toString()}`;
}

function parseTotalPages(html: string, recordsPerPage: number): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const match = text.match(/(?:Показано\s+[сc]\s+\d+\s+по\s+\d+\s+из|из)\s+([\d\s]+)\s+запис/i);
  const total = match ? Number(match[1].replace(/\s/g, "")) : 0;
  return Math.max(1, Math.ceil(total / recordsPerPage));
}

function monthsInRange(from: string, to: string): Array<{ year: number; month: number }> {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  const periods: Array<{ year: number; month: number }> = [];
  let year = fromYear;
  let month = fromMonth;
  while (year < toYear || (year === toYear && month <= toMonth)) {
    periods.push({ year, month });
    month++;
    if (month === 13) {
      year++;
      month = 1;
    }
  }
  return periods;
}

function uniqueContracts(items: ContractSearchItem[]): ContractSearchItem[] {
  const byId = new Map<string, ContractSearchItem>();
  for (const item of items) if (!byId.has(item.contractId)) byId.set(item.contractId, item);
  return [...byId.values()];
}

function assertPageWithinLimit(page: number, maxPages: number): void {
  if (page > maxPages) throw new Error(`max-pages=${maxPages} reached before crawl completed`);
}

async function writeContractWorkbook(outPath: string, rows: ExportRow[]): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Договоры");
  sheet.columns = [
    { header: "БИН Заказчика", key: "customerBin", width: 18 },
    { header: "Название Заказчика", key: "customerName", width: 55 },
    { header: "БИН/ИИН Поставщика", key: "supplierBinIin", width: 21 },
    { header: "Название Поставщика", key: "supplierName", width: 55 },
    { header: "Код ЕНС ТРУ поиска", key: "searchCode", width: 24 }
  ];
  for (const columnNumber of [1, 3, 5]) sheet.getColumn(columnNumber).numFmt = "@";
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(outPath);
}

async function createBrowserPageLoader(options: GoszakupContractExportOptions): Promise<{
  load: ContractPageLoader;
  close: () => Promise<void>;
}> {
  const browser: Browser = await chromium.launch({
    headless: options.headless ?? true,
    slowMo: options.slowMoMs ?? 0
  });
  const context = await browser.newContext({ locale: "ru-RU", viewport: { width: 1400, height: 900 } });
  const page: Page = await context.newPage();
  const timeout = options.pageLoadTimeoutMs ?? 45_000;
  const retries = options.retries ?? 3;
  return {
    load: async (url) => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
          if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? "unknown"}`);
          const html = await page.content();
          if (/технические работы|maintenance/i.test(html)) throw new Error("portal maintenance page");
          return html;
        } catch (error) {
          lastError = error;
          if (attempt < retries) await sleep(Math.min(1000 * (attempt + 1), 5000));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
    close: () => browser.close()
  };
}

function assertIsoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
