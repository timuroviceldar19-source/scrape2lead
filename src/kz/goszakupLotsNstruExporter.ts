import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { chromium, type Page } from "playwright";
import { sleep } from "./csv.js";
import { filterGzItems } from "./gzItemFilter.js";
import { parseGoszakupLotsHtml, parseGoszakupPagination, type GoszakupLotItem } from "./goszakupHtmlParser.js";
import { GZ_PORTAL_ORIGIN } from "./goszakupOrigin.js";

const BASE_URL = GZ_PORTAL_ORIGIN;
const DEFAULT_INPUT_PATH = "Nstru.txt";
const DEFAULT_DEBUG_DIR = "data/debug";
const DEFAULT_MONTHS = [6, 7, 8];
const DEFAULT_YEAR = 2026;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_DELAY_MS = 2000;
const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_LOAD_ATTEMPTS = 4;
const DEFAULT_PAGE_LOAD_RETRY_DELAY_MS = 2_000;
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
  keywords?: string[];
  year?: number;
  months?: number[];
  statusIds?: number[];
  /** Drop lots with planned amount below this value (KZT). */
  minAmount?: number;
  /** Stop-list: drop lots whose name matches any of these. */
  excludeKeywords?: string[];
  maxPages?: number;
  delayMs?: number;
  outPath?: string;
  headless?: boolean;
  slowMoMs?: number;
  debugDir?: string;
  pageLoadTimeoutMs?: number;
  pageLoadAttempts?: number;
  pageLoadRetryDelayMs?: number;
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
  { header: "Запрос (НСТРУ/слово)", key: "nstru_code", width: 24 },
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

/** Status IDs from goszakup lots search form filter[status][] */
export const GZ_LOT_STATUS_BY_NAME: Record<string, number> = {
  "Закупка не состоялась": 370,
  "Закупка состоялась": 360,
  "Заполнение условных скидок": 270,
  "Изменена документация": 190,
  "На обжаловании": 440,
  "Ожидание камерального контроля": 444,
  "Ожидание проведения контроля качества": 445,
  "Опубликован": 210,
  "Опубликован (дополнение заявок)": 230,
  "Опубликован (прием заявок)": 220,
  "Опубликован (прием ценовых предложений)": 240,
  "Отказ от лота": 410,
  "Отменен": 430,
  "Пересмотр итогов": 510,
  "Принятие решение о пересмотре итогов": 550,
  "Принятие решение об исполнении уведомления": 540,
  "Приостановлен": 420,
  "Пройдено контроль качества": 460,
  "Рассмотрение дополнений заявок": 260,
  "Рассмотрение заявок": 250,
  "Формирование протокола допуска": 320,
  "Формирование протокола итогов": 330,
  "Формирование протокола преддопуска": 310,
  "Формирование протокола промежуточных итогов": 325
};

/**
 * Goszakup silently drops filter[enstru] when the code is missing from its
 * dictionary and returns the full unfiltered lot list. A real code maps to a
 * single dictionary item name, so mixed lot names on one page mean the filter
 * was ignored.
 */
export function looksLikeIgnoredEnstruFilter(items: Array<{ lot_name: string | null }>): boolean {
  const names = new Set(items.map((item) => (item.lot_name ?? "").trim().toLocaleLowerCase("ru")).filter(Boolean));
  return names.size > 3;
}

export function resolveLotStatusIds(statuses: string[]): number[] {
  const ids: number[] = [];
  const unknown: string[] = [];

  for (const raw of statuses) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (/^\d+$/.test(trimmed)) {
      ids.push(Number(trimmed));
      continue;
    }

    const normalized = trimmed.toLocaleLowerCase("ru");
    const match = Object.entries(GZ_LOT_STATUS_BY_NAME).find(
      ([label]) => label.toLocaleLowerCase("ru") === normalized
    );
    if (match) {
      ids.push(match[1]);
    } else {
      unknown.push(trimmed);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown lot status(es): ${unknown.join(", ")}. Known: ${Object.keys(GZ_LOT_STATUS_BY_NAME).join(", ")}`
    );
  }

  return [...new Set(ids)];
}

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
  nstruCode?: string;
  nameQuery?: string;
  year: number;
  month: number;
  statusIds?: number[];
  pageNum?: number;
  recordsPerPage?: number;
}): string {
  if (Boolean(options.nstruCode) === Boolean(options.nameQuery)) {
    throw new Error("buildLotsNstruSearchUrl requires exactly one of nstruCode or nameQuery");
  }
  const params = new URLSearchParams();
  if (options.nstruCode) params.set("filter[enstru]", options.nstruCode);
  if (options.nameQuery) params.set("filter[name]", options.nameQuery);
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

interface LotSearchQuery {
  type: "enstru" | "name";
  value: string;
}

export async function exportGoszakupLotsByNstru(
  options: GoszakupLotsNstruOptions = {}
): Promise<GoszakupLotsNstruResult> {
  const inputPath = options.inputPath ?? DEFAULT_INPUT_PATH;
  const keywords = unique(options.keywords ?? []);
  const codes = options.nstruCodes
    ? unique(options.nstruCodes)
    : keywords.length > 0
      ? []
      : readNstruCodes(inputPath);
  const queries: LotSearchQuery[] = [
    ...codes.map((value): LotSearchQuery => ({ type: "enstru", value })),
    ...keywords.map((value): LotSearchQuery => ({ type: "name", value }))
  ];
  if (queries.length === 0) {
    throw new Error("No search queries: provide nstruCodes, keywords or a non-empty input file");
  }
  const year = options.year ?? DEFAULT_YEAR;
  const months = options.months?.length ? options.months : DEFAULT_MONTHS;
  const statusIds = options.statusIds ?? [];
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
  const pageLoadTimeoutMs = options.pageLoadTimeoutMs ?? DEFAULT_PAGE_LOAD_TIMEOUT_MS;
  const pageLoadAttempts = options.pageLoadAttempts ?? DEFAULT_PAGE_LOAD_ATTEMPTS;
  const pageLoadRetryDelayMs = options.pageLoadRetryDelayMs ?? DEFAULT_PAGE_LOAD_RETRY_DELAY_MS;

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
    for (const query of queries) {
      for (const month of months) {
        options.onProgress?.(`search ${query.type}=${query.value} year=${year} month=${month}`);
        const items = await collectLotsPageSet(page, {
          query,
          year,
          month,
          statusIds,
          debugDir,
          maxPages,
          pageLoadTimeoutMs,
          pageLoadAttempts,
          pageLoadRetryDelayMs,
          onRetry: options.onProgress
        });

        rows.push(...items.map((item) => buildExportRow(query.value, month, item)));
        options.onProgress?.(`found ${query.type}=${query.value} month=${month} rows=${items.length}`);
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const filterResult = filterLotRowsWithStats(rows, options.minAmount ?? 0, options.excludeKeywords ?? []);
  const filteredRows = filterResult.items;
  if (filterResult.droppedBelowMinAmount > 0 || filterResult.droppedByName > 0) {
    options.onProgress?.(`filter dropped below_min=${filterResult.droppedBelowMinAmount} stop_list=${filterResult.droppedByName}`);
  }
  const dedupedRows = dedupeRows(filteredRows).sort(compareRows);
  const xlsxPath = options.outPath ?? defaultOutputPath();
  await writeLotsWorkbook(xlsxPath, dedupedRows);

  return {
    xlsxPath,
    rows: dedupedRows.length,
    codes: queries.length,
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
    query: LotSearchQuery;
    year: number;
    month: number;
    statusIds: number[];
    debugDir: string;
    maxPages: number;
    pageLoadTimeoutMs: number;
    pageLoadAttempts: number;
    pageLoadRetryDelayMs: number;
    onRetry?: (message: string) => void;
  }
): Promise<GoszakupLotItem[]> {
  const allItems: GoszakupLotItem[] = [];
  let pageNum = 0;

  while (pageNum < options.maxPages) {
    const url = buildLotsNstruSearchUrl({
      nstruCode: options.query.type === "enstru" ? options.query.value : undefined,
      nameQuery: options.query.type === "name" ? options.query.value : undefined,
      year: options.year,
      month: options.month,
      statusIds: options.statusIds,
      pageNum
    });
    await gotoLotsPageWithRetry(page, url, {
      timeoutMs: options.pageLoadTimeoutMs,
      maxAttempts: options.pageLoadAttempts,
      retryDelayMs: options.pageLoadRetryDelayMs,
      onRetry: options.onRetry
    });
    await page.waitForTimeout(1500);

    const html = await page.content();
    fs.mkdirSync(options.debugDir, { recursive: true });
    fs.writeFileSync(
      path.join(options.debugDir, `goszakup-lots-nstru-${sanitizeCode(options.query.value)}-month${options.month}-page${pageNum}.html`),
      html,
      "utf8"
    );

    const items = parseGoszakupLotsHtml(html);
    if (items.length === 0) break;

    if (pageNum === 0 && options.query.type === "enstru" && looksLikeIgnoredEnstruFilter(items)) {
      console.warn(
        `goszakup lots: filter[enstru]=${options.query.value} ignored by site (mixed lot names, code likely missing from dictionary) — skipping month ${options.month}`
      );
      return [];
    }

    allItems.push(...items);

    const pagination = parseGoszakupPagination(html);
    const totalPages = Math.min(pagination.totalPages > 0 ? pagination.totalPages : 1, options.maxPages);
    if (pageNum + 1 >= totalPages) break;

    pageNum++;
  }

  return allItems;
}

export interface LotsPageNavigator {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForTimeout(timeoutMs: number): Promise<void>;
}

export async function gotoLotsPageWithRetry(
  page: LotsPageNavigator,
  url: string,
  options: {
    timeoutMs: number;
    maxAttempts: number;
    retryDelayMs: number;
    onRetry?: (message: string) => void;
  }
): Promise<void> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
      return;
    } catch (error) {
      if (attempt >= maxAttempts) throw error;

      const message = error instanceof Error ? error.message : String(error);
      options.onRetry?.(`goszakup lots navigation retry ${attempt}/${maxAttempts - 1}: ${message}`);
      const delayMs = Math.max(0, options.retryDelayMs) * 2 ** (attempt - 1);
      if (delayMs > 0) await page.waitForTimeout(delayMs);
    }
  }
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
    if (!byKey.has(row.lot_number)) byKey.set(row.lot_number, row);
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

/**
 * Drops lots whose amount is below `minAmount` (when > 0) or whose name matches
 * the stop-list. Applied at export time so junk never reaches the xlsx / Bitrix.
 */
export function filterLotRows(
  rows: GoszakupLotsNstruRow[],
  minAmount: number,
  excludeKeywords: string[]
): GoszakupLotsNstruRow[] {
  return filterLotRowsWithStats(rows, minAmount, excludeKeywords).items;
}

function filterLotRowsWithStats(rows: GoszakupLotsNstruRow[], minAmount: number, excludeKeywords: string[]) {
  return filterGzItems(rows, {
    minAmount, excludeKeywords,
    getAmount: (row) => parseAmount(row.amount),
    getName: (row) => row.lot_name
  });
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
  return code.replace(/[^0-9A-Za-zа-яё.-]+/gi, "-");
}

function defaultOutputPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join("exports", `goszakup-lots-nstru-${date}.xlsx`);
}
