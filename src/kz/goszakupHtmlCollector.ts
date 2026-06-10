import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { isValidBin, sleep } from "./csv.js";
import {
  parseGoszakupAnnounceHtml,
  parseGoszakupLotsHtml,
  parseGoszakupContractHtml,
  parseGoszakupPagination,
  type GoszakupAnnounceItem,
  type GoszakupLotItem,
  type GoszakupContractItem
} from "./goszakupHtmlParser.js";
import type { TenderRecord } from "./tenderTypes.js";

export interface GoszakupHtmlOptions {
  headless?: boolean;
  debugDir?: string;
  delayMs?: number;
  maxPages?: number;
  pageLoadTimeoutMs?: number;
  onProgress?: (index: number, total: number, bin: string) => void;
}

export interface GoszakupHtmlResult {
  announces: GoszakupAnnounceItem[];
  lots: GoszakupLotItem[];
  contracts: GoszakupContractItem[];
  tenders: TenderRecord[];
  pages: number;
}

const DEFAULT_DEBUG_DIR = "data/debug";
const BASE_URL = "https://goszakup.gov.kz";
const RECORDS_PER_PAGE = 50;
const MAX_PAGES_DEFAULT = Number(process.env.GOSZAKUP_HTML_MAX_PAGES ?? 50);

export async function collectGoszakupHtmlForBins(
  bins: string[],
  options: GoszakupHtmlOptions = {}
): Promise<GoszakupHtmlResult> {
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({
    locale: "ru-RU",
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();
  const delayMs = options.delayMs ?? 2000;
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
  const maxPages = options.maxPages ?? MAX_PAGES_DEFAULT;
  const pageLoadTimeoutMs = options.pageLoadTimeoutMs ?? 30000;

  const result: GoszakupHtmlResult = {
    announces: [],
    lots: [],
    contracts: [],
    tenders: [],
    pages: 0
  };

  try {
    let index = 0;
    for (const bin of bins) {
      index++;
      options.onProgress?.(index, bins.length, bin);
      if (!isValidBin(bin)) {
        console.warn(`goszakup html: skip invalid BIN ${bin}`);
        continue;
      }

      try {
        const announceItems = await collectPaginated(
          page,
          `${BASE_URL}/ru/search/announce?filter[customer]=${bin}`,
          debugDir,
          `announce-${bin}`,
          maxPages,
          pageLoadTimeoutMs,
          (html) => parseGoszakupAnnounceHtml(html)
        );

        const lotItems = await collectPaginated(
          page,
          `${BASE_URL}/ru/search/lots?filter[customer]=${bin}`,
          debugDir,
          `lots-${bin}`,
          maxPages,
          pageLoadTimeoutMs,
          (html) => parseGoszakupLotsHtml(html)
        );

        const contractItems = await collectPaginated(
          page,
          `${BASE_URL}/ru/registry/contract?filter[supplier]=${bin}`,
          debugDir,
          `contracts-${bin}`,
          maxPages,
          pageLoadTimeoutMs,
          (html) => parseGoszakupContractHtml(html)
        );

        result.announces.push(...announceItems);
        result.lots.push(...lotItems);
        result.contracts.push(...contractItems);

        for (const announce of announceItems) {
          result.tenders.push(mapAnnounceToTender(announce, bin));
        }

        for (const contract of contractItems) {
          result.tenders.push(mapContractToTender(contract, bin));
        }

        console.log(
          `goszakup html: bin=${bin} announces=${announceItems.length} lots=${lotItems.length} contracts=${contractItems.length}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`goszakup html: bin=${bin} failed: ${message}`);
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return result;
}

export function buildGoszakupHtmlPageUrl(baseUrl: string, pageNum = 0, recordsPerPage = RECORDS_PER_PAGE): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  const params = `count_record=${recordsPerPage}`;
  if (pageNum <= 0) return `${baseUrl}${separator}${params}`;
  return `${baseUrl}${separator}${params}&page=${pageNum}`;
}

async function collectPaginated<T>(
  page: Page,
  baseUrl: string,
  debugDir: string,
  debugPrefix: string,
  maxPages: number,
  pageLoadTimeoutMs: number,
  parser: (html: string) => T[]
): Promise<T[]> {
  const allItems: T[] = [];
  let pageNum = 0;

  while (pageNum < maxPages) {
    const url = buildGoszakupHtmlPageUrl(baseUrl, pageNum);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: pageLoadTimeoutMs });
    await page.waitForTimeout(1500);

    const html = await page.content();

    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(
      path.join(debugDir, `goszakup-${debugPrefix}-page${pageNum}.html`),
      html,
      "utf8"
    );

    const items = parser(html);
    if (items.length === 0) break;

    allItems.push(...items);

    const pagination = parseGoszakupPagination(html);
    const totalPages = Math.min(
      pagination.totalPages > 0 ? pagination.totalPages : 1,
      maxPages
    );
    if (pageNum + 1 >= totalPages) break;
    if (items.length < RECORDS_PER_PAGE) break;

    pageNum++;
  }

  return allItems;
}

function mapAnnounceToTender(announce: GoszakupAnnounceItem, bin: string): TenderRecord {
  return {
    source: "goszakup.gov.kz",
    bin,
    tender_number: announce.number,
    tender_name: announce.name,
    customer_name: announce.organizer,
    budget_amount: announce.amount,
    currency: "KZT",
    start_date: announce.application_start,
    end_date: announce.application_end,
    status: announce.status,
    method: announce.method,
    url: announce.announce_id
      ? `${BASE_URL}/ru/announce/index/${announce.announce_id}`
      : null,
    parsed_at: new Date().toISOString()
  };
}

function mapContractToTender(contract: GoszakupContractItem, bin: string): TenderRecord {
  const tenderName = contract.purchase_number
    ? `Договор ${contract.contract_number} (закупка ${contract.purchase_number})`
    : `Договор ${contract.contract_number}`;

  return {
    source: "goszakup.gov.kz",
    bin,
    tender_number: contract.contract_number,
    tender_name: tenderName,
    customer_name: contract.customer,
    budget_amount: contract.amount,
    currency: "KZT",
    start_date: contract.created_at,
    end_date: null,
    status: contract.status,
    method: contract.method,
    url: contract.url,
    parsed_at: new Date().toISOString()
  };
}
