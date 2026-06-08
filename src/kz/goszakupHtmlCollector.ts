import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { isValidBin, sleep } from "./csv.js";
import {
  parseGoszakupAnnounceHtml,
  parseGoszakupLotsHtml,
  parseGoszakupContractHtml,
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
const MAX_PAGES_DEFAULT = 10;

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
    for (const bin of bins) {
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
    const url = pageNum === 0
      ? baseUrl
      : `${baseUrl}&count_record=50&page=${pageNum}`;

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

    const hasNextPage = html.includes(`page=${pageNum + 1}`) && !html.includes(`page=${pageNum + 2}`);
    const hasMorePages = html.includes(`page=${pageNum + 1}`);

    if (!hasMorePages) break;
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
