import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { isValidBin, sleep } from "./csv.js";
import { normalizeCompanyName } from "./normalizeCompanyName.js";
import type { TenderRecord } from "./tenderTypes.js";
import { filterZakupTenders, type ZakupRejectReason } from "./zakupTenderFilter.js";

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
  filtered: number;
  accepted: number;
  errors: Array<{ bin: string; message: string }>;
}

const DEFAULT_DEBUG_DIR = "data/debug";

export async function collectZakupTendersForBatch(
  companies: ZakupCompanyInput[],
  options: ZakupCollectOptions = {}
): Promise<ZakupBatchResult> {
  const browser = await chromium.launch({ headless: options.headless ?? false });
  const delayMs = options.delayMs ?? 2000;
  const result: ZakupBatchResult = {
    tenders: [],
    processed: 0,
    skipped: 0,
    failed: 0,
    filtered: 0,
    accepted: 0,
    errors: []
  };

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
        const { tenders, rawCount, rejectedReasons } = await fetchZakupTenders(
          browser,
          company.bin,
          company.companyName,
          searchName,
          options.debugDir ?? DEFAULT_DEBUG_DIR
        );
        result.tenders.push(...tenders);
        result.accepted += tenders.length;
        result.filtered += rawCount - tenders.length;

        const reasonCounts: Partial<Record<ZakupRejectReason, number>> = {};
        for (const r of rejectedReasons) {
          reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
        }
        console.log(
          `zakup.sk.kz: bin=${company.bin} search="${searchName}" raw=${rawCount} accepted=${tenders.length} rejected=${rawCount - tenders.length} reasons=${JSON.stringify(reasonCounts)}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`zakup.sk.kz: ${company.bin} failed: ${message}`);
        result.failed++;
        result.errors.push({ bin: company.bin, message });
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
): Promise<{ tenders: TenderRecord[]; rawCount: number; rejectedReasons: ZakupRejectReason[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();

  let searchSubmittedAt = 0;
  let capturedData: unknown = null;

  page.on("response", async (response) => {
    if (!searchSubmittedAt) return;
    const url = response.url();
    if (!url.includes("4dv3rts")) return;
    if (capturedData) return;
    try {
      capturedData = await response.json();
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

    const responsePromise = page.waitForResponse(
      (res) => {
        const url = res.url();
        return res.ok() && url.includes("4dv3rts");
      },
      { timeout: 15_000 }
    ).catch(() => null);

    searchSubmittedAt = Date.now();
    await searchInput.press("Enter");
    await responsePromise;
    await page.waitForTimeout(2_000);

    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, `zakup-search-${bin}.png`) });

    const rawItems = extractZakupItems(capturedData);
    const filterResult = filterZakupTenders(rawItems, bin, companyName);

    return {
      tenders: filterResult.accepted,
      rawCount: rawItems.length,
      rejectedReasons: filterResult.rejected.map((r) => r.reason)
    };
  } finally {
    await page.close();
    await context.close();
  }
}

async function findSearchInput(page: Page) {
  const selectors = [
    'input[placeholder*="Слово"]',
    'input[placeholder*="поиска"]',
    'input[type="search"]'
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
