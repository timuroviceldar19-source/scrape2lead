import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { chromium, type Page } from "playwright";
import { sleep } from "./csv.js";
import { parseGoszakupLotsHtml, parseGoszakupPagination, type GoszakupLotItem } from "./goszakupHtmlParser.js";

const BASE_URL = "https://goszakup.gov.kz";
const DEFAULT_INPUT_PATH = "Nstru.txt";
const DEFAULT_DEBUG_DIR = "data/debug";
const DEFAULT_MONTHS = [6, 7, 8];
const DEFAULT_YEAR = 2026;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_DELAY_MS = 2000;
const MONTH_NAMES_RU: Record<number, string> = {
  1: "Январь",
  2: "Февраль",
  3: "Март",
  4: "Апрель",
  5: "Май",
  6: "Июнь",
  7: "Июль",
  8: "Август",
  9: "Сентябрь",
  10: "Октябрь",
  11: "Ноябрь",
  12: "Декабрь"
};

export interface GoszakupLotsNstruOptions {
  inputPath?: string;
  nstruCodes?: string[];
  year?: number;
  months?: number[];
  statusIds?: number[];
  maxPages?: number;
  delayMs?: number;
  outPath?: string;
  headless?: boolean;
  slowMoMs?: number;
  debugDir?: string;
  pageLoadTimeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface GoszakupLotsNstruRow {
  nstru_code: string;
  month: string;
  lot_number: string;
  lot_name: string;
  announce_number: string;
  announce_name: string;
  customer: string;
  quantity: string;
  amount: string;
  method: string;
  status: string;
  lot_url: string;
  announce_url: string;
  customer_url: string;
}

export interface GoszakupLotsNstruResult {
  xlsxPath: string;
  rows: number;
  codes: number;
  months: number[];
}

const EXPORT_COLUMNS: Array<{ header: string; key: keyof GoszakupLotsNstruRow; width: number }> = [
  { header: "НСТРУ", key: "nstru_code", width: 20 },
  { header: "Месяц", key: "month", width: 10 },
  { header: "№ лота", key: "lot_number", width: 18 },
  { header: "Наименование лота", key: "lot_name", width: 42 },
  { header: "№ объявления", key: "announce_number", width: 18 },
  { header: "Наименование объявления", key: "announce_name", width: 46 },
  { header: "Заказчик", key: "customer", width: 46 },
  { header: "Количество", key: "quantity", width: 14 },
  { header: "Сумма, тг.", key: "amount", width: 18 },
  { header: "Способ закупки", key: "method", width: 30 },
  { header: "Статус", key: "status", width: 24 },
  { header: "Ссылка на лот", key: "lot_url", width: 52 },
  { header: "Ссылка на объявление", key: "announce_url", width: 52 },
  { header: "Ссылка на заказчика", key: "customer_url", width: 52 }
];

const HYPERLINK_KEYS = new Set<keyof GoszakupLotsNstruRow>(["lot_url", "announce_url", "customer_url"]);

export function readNstruCodes(inputPath = DEFAULT_INPUT_PATH): string[] {
  const contents = fs.readFileSync(inputPath, "utf8");
  const seen = new Set<string>();
  const codes: string[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const code = rawLine.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  return codes;
}

export function buildLotsNstruSearchUrl(options: {
  nstruCode: string;
  year: number;
  month: number;
  statusIds?: number[];
  pageNum?: number;
  recordsPerPage?: number;
}): string {
  const params = new URLSearchParams();
  params.set("filter[enstru]", options.nstruCode);
  params.set("filter[year]", String(options.year));
  params.set("filter[month]", String(options.month));
  for (const statusId of options.statusIds ?? []) {
    params.append("filter[status][]", String(statusId));
  }
  params.set("count_record", String(options.recordsPerPage ?? 50));
  if (options.pageNum && options.pageNum > 0) {
    params.set("page", String(options.pageNum + 1));
  }
  return `${BASE_URL}/ru/search/lots?${params.toString()}`;
}

export async function exportGoszakupLotsByNstru(
  options: GoszakupLotsNstruOptions = {}
): Promise<GoszakupLotsNstruResult> {
  const inputPath = options.inputPath ?? DEFAULT_INPUT_PATH;
  const codes = options.nstruCodes ? unique(options.nstruCodes) : readNstruCodes(inputPath);
  const year = options.year ?? DEFAULT_YEAR;
  const months = options.months?.length ? options.months : DEFAULT_MONTHS;
  const statusIds = options.statusIds ?? [];
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
  const pageLoadTimeoutMs = options.pageLoadTimeoutMs ?? 30_000;

  const browser = await chromium.launch({
    headless: options.headless ?? true,
    slowMo: options.slowMoMs ?? 0
  });
  const context = await browser.newContext({
    locale: "ru-RU",
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();
  const rows: GoszakupLotsNstruRow[] = [];

  try {
    for (const code of codes) {
      for (const month of months) {
        options.onProgress?.(`search nstru=${code} year=${year} month=${month}`);
        const items = await collectLotsPageSet(page, {
          code,
          year,
          month,
          statusIds,
          debugDir,
          maxPages,
          pageLoadTimeoutMs
        });

        rows.push(...items.map((item) => buildExportRow(code, month, item)));
        options.onProgress?.(`found nstru=${code} month=${month} rows=${items.length}`);
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const dedupedRows = dedupeRows(rows).sort(compareRows);
  const xlsxPath = options.outPath ?? defaultOutputPath();
  await writeLotsWorkbook(xlsxPath, dedupedRows);

  return {
    xlsxPath,
    rows: dedupedRows.length,
    codes: codes.length,
    months
  };
}

export async function writeLotsWorkbook(xlsxPath: string, rows: GoszakupLotsNstruRow[]): Promise<void> {
  fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Scrape2Lead";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Лоты НСТРУ");
  sheet.columns = EXPORT_COLUMNS;
  sheet.addRows(rows);
  sheet.getRow(1).font = { bold: true };
  applyHyperlinks(sheet, rows);

  await workbook.xlsx.writeFile(xlsxPath);
}

async function collectLotsPageSet(
  page: Page,
  options: {
    code: string;
    year: number;
    month: number;
    statusIds: number[];
    debugDir: string;
    maxPages: number;
    pageLoadTimeoutMs: number;
  }
): Promise<GoszakupLotItem[]> {
  const allItems: GoszakupLotItem[] = [];
  let pageNum = 0;

  while (pageNum < options.maxPages) {
    const url = buildLotsNstruSearchUrl({
      nstruCode: options.code,
      year: options.year,
      month: options.month,
      statusIds: options.statusIds,
      pageNum
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.pageLoadTimeoutMs });
    await page.waitForTimeout(1500);

    const html = await page.content();
    fs.mkdirSync(options.debugDir, { recursive: true });
    fs.writeFileSync(
      path.join(options.debugDir, `goszakup-lots-nstru-${sanitizeCode(options.code)}-month${options.month}-page${pageNum}.html`),
      html,
      "utf8"
    );

    const items = parseGoszakupLotsHtml(html);
    if (items.length === 0) break;

    allItems.push(...items);

    const pagination = parseGoszakupPagination(html);
    const totalPages = Math.min(pagination.totalPages > 0 ? pagination.totalPages : 1, options.maxPages);
    if (pageNum + 1 >= totalPages) break;

    pageNum++;
  }

  return allItems;
}

function buildExportRow(code: string, month: number, item: GoszakupLotItem): GoszakupLotsNstruRow {
  return {
    nstru_code: code,
    month: MONTH_NAMES_RU[month] ?? String(month),
    lot_number: item.lot_number,
    lot_name: item.lot_name ?? "",
    announce_number: item.announce_number ?? "",
    announce_name: item.announce_name ?? "",
    customer: item.customer ?? "",
    quantity: item.quantity ?? "",
    amount: item.amount ?? "",
    method: item.method ?? "",
    status: item.status ?? "",
    lot_url: item.lot_url ?? "",
    announce_url: item.announce_url ?? "",
    customer_url: item.customer_url ?? ""
  };
}

function applyHyperlinks(sheet: ExcelJS.Worksheet, rows: GoszakupLotsNstruRow[]): void {
  const columnIndexByKey = new Map<keyof GoszakupLotsNstruRow, number>();
  EXPORT_COLUMNS.forEach((column, index) => columnIndexByKey.set(column.key, index + 1));

  rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(rowIndex + 2);
    for (const key of HYPERLINK_KEYS) {
      const url = row[key];
      const colIndex = columnIndexByKey.get(key);
      if (typeof url !== "string" || !url || !colIndex) continue;
      excelRow.getCell(colIndex).value = { text: url, hyperlink: url };
    }
  });
}

function dedupeRows(rows: GoszakupLotsNstruRow[]): GoszakupLotsNstruRow[] {
  const byKey = new Map<string, GoszakupLotsNstruRow>();
  for (const row of rows) {
    const key = `${row.nstru_code}:${row.lot_number}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function compareRows(a: GoszakupLotsNstruRow, b: GoszakupLotsNstruRow): number {
  const codeCmp = a.nstru_code.localeCompare(b.nstru_code);
  if (codeCmp !== 0) return codeCmp;
  const monthCmp = monthIndex(a.month) - monthIndex(b.month);
  if (monthCmp !== 0) return monthCmp;
  return parseAmount(b.amount) - parseAmount(a.amount);
}

function monthIndex(month: string): number {
  for (const [index, name] of Object.entries(MONTH_NAMES_RU)) {
    if (name === month) return Number(index);
  }
  return 99;
}

function parseAmount(value: string): number {
  const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function sanitizeCode(code: string): string {
  return code.replace(/[^0-9A-Za-z.-]+/g, "-");
}

function defaultOutputPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join("exports", `goszakup-lots-nstru-${date}.xlsx`);
}
