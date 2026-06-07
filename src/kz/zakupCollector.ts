import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { isValidBin, sleep } from "./csv.js";
import { normalizeCompanyName } from "./normalizeCompanyName.js";
import type { TenderRecord } from "./tenderTypes.js";

interface ZakupCompanyInput {
  bin: string;
  companyName: string | null;
}

export interface ZakupCollectOptions {
  delayMs?: number;
  headless?: boolean;
  debugDir?: string;
}

export interface ZakupBatchResult {
  tenders: TenderRecord[];
  processed: number;
  skipped: number;
  failed: number;
}

const DEFAULT_DEBUG_DIR = "data/debug";

export async function collectZakupTendersForBatch(
  companies: ZakupCompanyInput[],
  options: ZakupCollectOptions = {}
): Promise<ZakupBatchResult> {
  const browser = await chromium.launch({ headless: options.headless ?? false });
  const delayMs = options.delayMs ?? 2000;
  const result: ZakupBatchResult = { tenders: [], processed: 0, skipped: 0, failed: 0 };

  try {
    for (const company of companies) {
      if (!isValidBin(company.bin)) {
        console.warn(`zakup.sk.kz: skip invalid BIN ${company.bin}`);
        result.skipped++;
        continue;
      }
      if (!company.companyName) {
        console.warn(`zakup.sk.kz: skip ${company.bin}; company name missing in stat_gov_data`);
        result.skipped++;
        continue;
      }

      const searchName = normalizeCompanyName(company.companyName);
      if (searchName.length < 3) {
        console.warn(`zakup.sk.kz: skip ${company.bin}; normalized name is too short`);
        result.skipped++;
        continue;
      }

      result.processed++;
      try {
        const tenders = await fetchZakupTenders(browser, company.bin, company.companyName, searchName, options.debugDir ?? DEFAULT_DEBUG_DIR);
        result.tenders.push(...tenders);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`zakup.sk.kz: ${company.bin} failed: ${message}`);
        result.failed++;
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  } finally {
    await browser.close();
  }

  return result;
}

async function fetchZakupTenders(
  browser: Browser,
  bin: string,
  companyName: string,
  searchName: string,
  debugDir: string
): Promise<TenderRecord[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  let searchSubmitted = false;
  let apiData: unknown = null;

  page.on("response", async (response) => {
    if (!searchSubmitted) return;
    const url = response.url();
    if (!url.includes("4dv3rts")) return;
    try {
      apiData = await response.json();
    } catch {
      // Non-JSON responses are irrelevant for tender capture.
    }
  });

  try {
    await page.goto("https://zakup.sk.kz/#/lots", { waitUntil: "networkidle", timeout: 30_000 });
    const searchInput = await findSearchInput(page);
    if (!searchInput) {
      throw new Error("search input not found; not saving default lots");
    }

    await searchInput.fill(searchName);
    await page.waitForTimeout(500);
    searchSubmitted = true;
    await searchInput.press("Enter");
    await page.waitForTimeout(5_000);

    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, `zakup-search-${bin}.png`) });

    return extractZakupItems(apiData).map((item) => mapZakupTender(item, bin, companyName));
  } finally {
    await page.close();
    await context.close();
  }
}

async function findSearchInput(page: Page) {
  const selectors = [
    'input[placeholder*="Слово"]',
    'input[placeholder*="поиска"]',
    'input[type="search"]',
    "input"
  ];
  for (const selector of selectors) {
    const input = await page.$(selector);
    if (input) return input;
  }
  return null;
}

function extractZakupItems(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter(isObject);
  if (!isObject(data)) return [];

  for (const key of ["content", "items", "data", "results"]) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(isObject);
  }

  return [];
}

function mapZakupTender(item: Record<string, unknown>, bin: string, companyName: string): TenderRecord {
  const number = stringValue(item.number) || stringValue(item.id) || "N/A";
  return {
    source: "zakup.sk.kz",
    bin,
    tender_number: number,
    tender_name: stringValue(item.nameRu) || stringValue(item.nameKk) || "N/A",
    customer_name: companyName,
    budget_amount: stringValue(item.sumTruNoNds),
    currency: "KZT",
    start_date: stringValue(item.acceptanceBeginDateTime),
    end_date: stringValue(item.acceptanceEndDateTime),
    status: stringValue(item.advertStatus),
    method: stringValue(item.tenderType),
    url: `https://zakup.sk.kz/#/lots/${number}`,
    parsed_at: new Date().toISOString()
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
