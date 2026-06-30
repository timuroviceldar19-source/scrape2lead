import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { isValidBin, sleep } from "./csv.js";
import { normalizeCompanyName } from "./normalizeCompanyName.js";
import type { TenderRecord } from "./tenderTypes.js";
import { filterZakupTenders, type ZakupRejectReason } from "./zakupTenderFilter.js";
import {
  ZAKUP_LOTS_URL,
  dismissZakupOverlays,
  isRetriableZakupError,
  waitForZakupSearchInput
} from "./zakupPageHelpers.js";

interface ZakupCompanyInput {
  bin: string;
  companyName: string | null;
}

export interface ZakupCollectOptions {
  delayMs?: number;
  headless?: boolean;
  debugDir?: string;
  maxRetries?: number;
  pageLoadTimeoutMs?: number;
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
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
  const maxRetries = options.maxRetries ?? Number(process.env.ZAKUP_MAX_RETRIES ?? 3);
  const pageLoadTimeoutMs = options.pageLoadTimeoutMs ?? Number(process.env.ZAKUP_PAGE_TIMEOUT_MS ?? 30000);

  const result: ZakupBatchResult = {
    tenders: [],
    processed: 0,
    skipped: 0,
    failed: 0,
    filtered: 0,
    accepted: 0,
    errors: []
  };

  const context = await browser.newContext({
    locale: "ru-RU",
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();

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
        const { tenders, rawCount, rejectedReasons } = await fetchZakupTendersWithRetry(
          page,
          company.bin,
          company.companyName,
          searchName,
          debugDir,
          maxRetries,
          pageLoadTimeoutMs
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
    await context.close();
    await browser.close();
  }

  return result;
}

async function fetchZakupTendersWithRetry(
  page: Page,
  bin: string,
  companyName: string,
  searchName: string,
  debugDir: string,
  maxRetries: number,
  pageLoadTimeoutMs: number
): Promise<{ tenders: TenderRecord[]; rawCount: number; rejectedReasons: ZakupRejectReason[] }> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchZakupTendersOnce(page, bin, companyName, searchName, debugDir, pageLoadTimeoutMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retriable = isRetriableZakupError(lastError);
      if (!retriable || attempt === maxRetries) break;
      const backoff = 1000 * attempt;
      console.warn(`zakup.sk.kz: bin=${bin} attempt ${attempt}/${maxRetries} failed: ${lastError.message}; retry in ${backoff}ms`);
      await sleep(backoff);
      await page.reload({ waitUntil: "domcontentloaded", timeout: pageLoadTimeoutMs }).catch(() => {});
    }
  }

  fs.mkdirSync(debugDir, { recursive: true });
  await page.screenshot({ path: path.join(debugDir, `zakup-fail-${bin}.png`) }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) {
    fs.writeFileSync(path.join(debugDir, `zakup-fail-${bin}.html`), html, "utf8");
  }

  throw lastError!;
}

async function fetchZakupTendersOnce(
  page: Page,
  bin: string,
  companyName: string,
  searchName: string,
  debugDir: string,
  pageLoadTimeoutMs: number
): Promise<{ tenders: TenderRecord[]; rawCount: number; rejectedReasons: ZakupRejectReason[] }> {
  let capturedData: unknown = null;

  await page.goto(ZAKUP_LOTS_URL, { waitUntil: "domcontentloaded", timeout: pageLoadTimeoutMs });
  await dismissZakupOverlays(page);
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(1500);

  const searchInput = await waitForZakupSearchInput(page, { timeoutMs: 15000 });
  if (!searchInput) {
    throw new Error("search input not found; not saving default lots");
  }

  await searchInput.fill("");
  await searchInput.fill(searchName);
  await page.waitForTimeout(500);

  const responsePromise = page.waitForResponse(
    (res) => res.ok() && res.url().includes("4dv3rts"),
    { timeout: 15_000 }
  ).catch(() => null);

  await searchInput.press("Enter");
  const response = await responsePromise;
  if (response) {
    capturedData = await response.json().catch(() => null);
  }
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
