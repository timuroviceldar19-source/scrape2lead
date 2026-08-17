import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { sleep } from "./csv.js";
import { buildGoszakupHtmlPageUrl } from "./goszakupHtmlCollector.js";
import { isExcludedByName } from "./gzItemFilter.js";
import { KzStorage } from "./kzStorage.js";
import {
  fetchPlanDetailFromApi,
  loadAbpRefs,
  resolveAbpName
} from "./goszakupPlanClient.js";
import { resolvePlanStatusIds, resolvePlanStatusNames } from "./gzPlansConfig.js";
import {
  buildPlanSearchUrl,
  matchesPlanStatus,
  parseGoszakupPagination,
  parseGoszakupPlanDetailHtml,
  parseGoszakupPlanSearchHtml
} from "./goszakupPlanHtmlParser.js";
import type {
  GoszakupPlanDetail,
  GoszakupPlanListItem,
  GzPlanCollectOptions,
  GzPlanCollectResult,
  GoszakupPlanKatoLocation,
  PlanDetailCacheStats
} from "./goszakupPlanTypes.js";
import { DEFAULT_GZ_PLAN_KEYWORDS as DEFAULT_KEYWORDS } from "./goszakupPlanTypes.js";

const DEFAULT_DEBUG_DIR = "data/debug";
const MAX_PAGES_DEFAULT = 50;
const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 90_000;
const SEARCH_PAGE_RETRIES = 2;
const DETAIL_RETRIES = 2;
const DEFAULT_DETAIL_CACHE_TTL_DAYS = 3;

export interface PlanSearchPage {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForTimeout(timeout: number): Promise<unknown>;
  content(): Promise<string>;
}

export async function collectGzPlans(options: GzPlanCollectOptions = {}): Promise<GzPlanCollectResult> {
  const keywords = options.keywords ?? (options.katoLocations?.length ? [] : [...DEFAULT_KEYWORDS]);
  const katoLocations = options.katoLocations ?? [];
  const year = options.year ?? 2026;
  const months = options.months ?? [6, 7, 8];
  const statuses = options.statuses ?? [];
  const searchQueries = buildPlanSearchQueries({ keywords, katoLocations, statuses });
  const maxPages = options.maxPages ?? MAX_PAGES_DEFAULT;
  const delayMs = options.delayMs ?? 2000;
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
  const pageLoadTimeoutMs = options.pageLoadTimeoutMs ?? DEFAULT_PAGE_LOAD_TIMEOUT_MS;
  const token = options.token ?? process.env.GOSZAKUP_TOKEN ?? null;

  const abpRefs = token
    ? await loadAbpRefs({ token }).catch((error) => {
        console.warn(`goszakup plan: failed to load ABP refs: ${error instanceof Error ? error.message : error}`);
        return new Map<string, string>();
      })
    : new Map<string, string>();

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({
    locale: "ru-RU",
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();

  const listItems: GoszakupPlanListItem[] = [];
  const listById = new Map<string, GoszakupPlanListItem>();

  try {
    for (const query of searchQueries) {
      const statusSuffix = query.allowedStatusNames.length ? ` / ${query.allowedStatusNames[0]}` : "";
      options.onProgress?.(`search: ${query.label}${statusSuffix}`);
      const baseUrl = buildPlanSearchUrl({
        keyword: query.keyword,
        katoCode: query.katoCode,
        statusId: query.statusId,
        year,
        months
      });
      const items = await collectPlanSearch(page, baseUrl, query.label, {
        debugDir,
        maxPages,
        pageLoadTimeoutMs,
        searchPageWaitMs: options.searchPageWaitMs ?? 1500,
        delayMs,
        allowedStatusNames: query.allowedStatusNames,
        pageLoadRetries: options.pageLoadRetries ?? SEARCH_PAGE_RETRIES
      });

      for (const item of items) {
        if (!matchesPlanStatus(item.status, query.allowedStatusNames)) continue;
        if (options.keepDuplicates) {
          listItems.push(item);
        } else {
          const existing = listById.get(item.plan_point_id);
          listById.set(item.plan_point_id, existing
            ? { ...existing, keyword: mergeSearchLabels(existing.keyword, item.keyword) }
            : item);
        }
      }

      console.log(`goszakup plan search: filter="${query.label}${statusSuffix}" rows=${items.length}`);
      if (delayMs > 0) await sleep(delayMs);
    }

    const dedupedItems = options.keepDuplicates ? listItems : [...listById.values()];
    const detailItems = options.prefilterDetails
      ? runDetailPrefilter(dedupedItems, options.minAmount ?? 0, options.excludeKeywords ?? [])
      : dedupedItems;

    if (options.skipDetails) {
      return {
        items: detailItems.map((item) => ({ ...item, detail: buildFallbackPlanDetail(item) })),
        cacheStats: { cacheHit: 0, cacheMiss: 0, fetched: 0, fetchFailed: 0 }
      };
    }

    const storage = new KzStorage({
      databasePath: options.databasePath ?? process.env.KZ_DATABASE_PATH ?? undefined
    });
    try {
      const detailResult = await collectPlanDetails(page, detailItems, {
        debugDir,
        pageLoadTimeoutMs,
        delayMs,
        token,
        abpRefs,
        storage,
        cacheTtlDays: resolveDetailCacheTtlDays(options.detailCacheTtlDays),
        forceRefresh: resolveDetailForceRefresh(options.forceDetailRefresh),
        onProgress: options.onProgress
      });
      return { items: detailResult.items, cacheStats: detailResult.stats };
    } finally {
      storage.close();
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

export interface PlanSearchQuery {
  label: string;
  keyword?: string;
  katoCode?: string;
  statusId?: number;
  allowedStatusNames: string[];
}

export function buildPlanSearchQueries(options: {
  keywords: readonly string[];
  katoLocations: readonly GoszakupPlanKatoLocation[];
  statuses: readonly string[];
}): PlanSearchQuery[] {
  const allowedStatusNames = resolvePlanStatusNames([...options.statuses]);
  const queries: PlanSearchQuery[] = options.keywords.map((keyword) => ({
    label: keyword,
    keyword,
    allowedStatusNames
  }));

  const statusIds = resolvePlanStatusIds([...options.statuses]);
  for (const location of options.katoLocations) {
    if (statusIds.length === 0) {
      queries.push({ label: location.name, katoCode: location.kato, allowedStatusNames: [] });
      continue;
    }
    for (const statusId of statusIds) {
      queries.push({
        label: location.name,
        katoCode: location.kato,
        statusId,
        allowedStatusNames: resolvePlanStatusNames([String(statusId)])
      });
    }
  }
  return queries;
}

function mergeSearchLabels(left: string, right: string): string {
  return [...new Set([...left.split("; "), ...right.split("; ")].filter(Boolean))].join("; ");
}

function runDetailPrefilter(
  items: GoszakupPlanListItem[],
  minAmount: number,
  excludeKeywords: readonly string[]
): GoszakupPlanListItem[] {
  const prefilter = prefilterPlanListItems(items, minAmount, excludeKeywords);
  console.log(
    `goszakup plan prefilter: prefiltered=${items.length - prefilter.items.length}`
    + ` total=${items.length}`
    + ` below_min=${prefilter.droppedBelowMinAmount}`
    + ` stop_list=${prefilter.droppedByName}`
  );
  return prefilter.items;
}

export interface PlanPrefilterResult {
  items: GoszakupPlanListItem[];
  droppedBelowMinAmount: number;
  droppedByName: number;
}

/**
 * Conservative pre-detail filter: drops only rows the post-detail filters
 * would drop anyway. Amounts that are missing, zero or unparseable are kept
 * for the detail fetch; empty names are never treated as stop-list matches.
 */
export function prefilterPlanListItems(
  items: readonly GoszakupPlanListItem[],
  minAmount: number,
  excludeKeywords: readonly string[]
): PlanPrefilterResult {
  const kept: GoszakupPlanListItem[] = [];
  let droppedBelowMinAmount = 0;
  let droppedByName = 0;

  for (const item of items) {
    const amount = parseListAmount(item.planned_amount);
    if (minAmount > 0 && amount !== null && amount > 0 && amount < minAmount) {
      droppedBelowMinAmount++;
      continue;
    }
    if (item.item_name && isExcludedByName(item.item_name, excludeKeywords)) {
      droppedByName++;
      continue;
    }
    kept.push(item);
  }

  return { items: kept, droppedBelowMinAmount, droppedByName };
}

function parseListAmount(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.replace(/[\s ]/g, "").replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface PlanDetailCollectOptions {
  debugDir: string;
  pageLoadTimeoutMs: number;
  delayMs: number;
  token?: string | null;
  abpRefs?: Map<string, string>;
  storage?: KzStorage | null;
  cacheTtlDays?: number;
  forceRefresh?: boolean;
  /** Per-item delay after a real goszakup request. Injectable for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/**
 * Resolves details for list items: fresh cache -> API (when token) -> HTML.
 * Only successfully parsed details are cached; the synthetic fallback is not.
 * delayMs applies after every real goszakup request (API or HTML) but never
 * after a cache hit.
 */
export interface PlanDetailCollectOutput {
  items: GzPlanCollectResult["items"];
  stats: PlanDetailCacheStats;
}

export async function collectPlanDetails(
  page: PlanSearchPage,
  items: readonly GoszakupPlanListItem[],
  options: PlanDetailCollectOptions
): Promise<PlanDetailCollectOutput> {
  const token = options.token ?? null;
  const abpRefs = options.abpRefs ?? new Map<string, string>();
  const storage = options.storage ?? null;
  const cacheTtlDays = options.cacheTtlDays ?? DEFAULT_DETAIL_CACHE_TTL_DAYS;
  const forceRefresh = options.forceRefresh ?? false;
  const doSleep = options.sleepImpl ?? sleep;

  const results: GzPlanCollectResult["items"] = [];
  const stats: PlanDetailCacheStats = { cacheHit: 0, cacheMiss: 0, fetched: 0, fetchFailed: 0 };
  let index = 0;

  for (const listItem of items) {
    index++;
    options.onProgress?.(`detail ${index}/${items.length}: ${listItem.plan_point_id}`);

    let detail = forceRefresh
      ? null
      : storage?.getFreshGoszakupPlanDetail(listItem.plan_point_id, cacheTtlDays) ?? null;
    let fetchedFromNetwork = false;

    if (detail) {
      stats.cacheHit++;
    } else {
      stats.cacheMiss++;
      if (token) {
        detail = await fetchPlanDetailFromApi(listItem.plan_point_id, { token });
        fetchedFromNetwork = true;
        if (detail) {
          detail.abp_name = resolveAbpName(detail, abpRefs);
        }
      }
      if (!detail) {
        detail = await fetchPlanDetailHtml(page, listItem, {
          debugDir: options.debugDir,
          pageLoadTimeoutMs: options.pageLoadTimeoutMs,
          delayMs: options.delayMs
        });
        fetchedFromNetwork = true;
      }
      if (detail) {
        stats.fetched++;
        storage?.upsertGoszakupPlanDetail(detail);
      } else {
        stats.fetchFailed++;
        detail = buildFallbackPlanDetail(listItem);
      }
    }

    if (!detail.name_ru) {
      detail.name_ru = listItem.item_name;
    }
    if (!detail.customer_name) {
      detail.customer_name = listItem.customer_name;
    }

    results.push({ ...listItem, detail });
    if (fetchedFromNetwork && options.delayMs > 0) await doSleep(options.delayMs);
  }

  console.log(
    `goszakup plan detail: cache_hit=${stats.cacheHit} cache_miss=${stats.cacheMiss}`
    + ` fetched=${stats.fetched} fetch_failed=${stats.fetchFailed}`
  );
  return { items: results, stats };
}

/** Placeholder detail used when the plan page could not be fetched or parsed. Never cached. */
export function buildFallbackPlanDetail(listItem: GoszakupPlanListItem): GoszakupPlanDetail {
  return {
    plan_point_id: listItem.plan_point_id,
    customer_bin: null,
    customer_name: listItem.customer_name,
    name_ru: listItem.item_name,
    ref_enstru_code: null,
    desc_ru: null,
    extra_desc_ru: null,
    date_approved: null,
    ref_abp_code: null,
    abp_name: null,
    delivery_address: null,
    plan_act_number: null
  };
}

function resolveDetailCacheTtlDays(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const fromEnv = Number(process.env.GOSZAKUP_PLAN_DETAIL_CACHE_TTL_DAYS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_DETAIL_CACHE_TTL_DAYS;
}

function resolveDetailForceRefresh(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.GOSZAKUP_PLAN_DETAIL_FORCE_REFRESH === "1";
}

export async function collectPlanSearch(
  page: PlanSearchPage,
  baseUrl: string,
  keyword: string,
  options: {
    debugDir: string;
    maxPages: number;
    pageLoadTimeoutMs: number;
    searchPageWaitMs?: number;
    delayMs: number;
    allowedStatusNames: string[];
    pageLoadRetries?: number;
  }
): Promise<GoszakupPlanListItem[]> {
  const allItems: GoszakupPlanListItem[] = [];
  let pageNum = 0;
  let expectedTotalPages = 1;

  while (pageNum < options.maxPages) {
    const url = buildGoszakupHtmlPageUrl(baseUrl, pageNum);
    await gotoPlanSearchPage(page, url, keyword, pageNum, options);
    await page.waitForTimeout(options.searchPageWaitMs ?? 1500);

    const html = await page.content();
    if (/технические работы/i.test(html) && !/id="search-result"/i.test(html)) {
      console.warn(`goszakup plan search: maintenance page for keyword="${keyword}"`);
    }
    fs.mkdirSync(options.debugDir, { recursive: true });
    fs.writeFileSync(
      path.join(options.debugDir, `goszakup-plan-search-${slug(keyword)}-page${pageNum}.html`),
      html,
      "utf8"
    );

    const parsed = parseGoszakupPlanSearchHtml(html, keyword);
    const items = parsed.filter((item) => matchesPlanStatus(item.status, options.allowedStatusNames));
    const pagination = parseGoszakupPagination(html);
    const availablePages = pagination.totalPages > 0 ? pagination.totalPages : 1;
    if (pageNum === 0) expectedTotalPages = availablePages;
    if (availablePages > options.maxPages) {
      throw new Error(
        `Plan search maxPages=${options.maxPages} could truncate ${availablePages} available pages for "${keyword}"`
      );
    }
    const totalPages = expectedTotalPages;
    if (parsed.length === 0) {
      if (pageNum > 0 && pageNum < totalPages) {
        throw new Error(
          `Plan search returned empty page ${pageNum + 1} while ${totalPages} expected pages were reported for "${keyword}"`
        );
      }
      break;
    }

    allItems.push(...items);
    if (pageNum === 0 && pagination.totalCount > 0) {
      console.log(
        `goszakup plan search: keyword="${keyword}" page=1 parsed=${parsed.length} matched=${items.length} total=${pagination.totalCount} pages=${totalPages}`
      );
    }
    if (pageNum + 1 >= totalPages) break;

    pageNum++;
    if (options.delayMs > 0) await sleep(options.delayMs);
  }

  return allItems;
}

async function gotoPlanSearchPage(
  page: PlanSearchPage,
  url: string,
  keyword: string,
  pageNum: number,
  options: {
    pageLoadTimeoutMs: number;
    delayMs: number;
    pageLoadRetries?: number;
  }
): Promise<void> {
  const retries = options.pageLoadRetries ?? SEARCH_PAGE_RETRIES;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.pageLoadTimeoutMs });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= retries) {
        console.error(
          `goszakup plan search: keyword="${keyword}" page=${pageNum + 1} failed after ${attempt + 1} attempts: ${message}`
        );
        throw error;
      }
      console.warn(
        `goszakup plan search: keyword="${keyword}" page=${pageNum + 1} retry ${attempt + 1}/${retries}: ${message}`
      );
      if (options.delayMs > 0) await sleep(options.delayMs);
    }
  }
}

async function fetchPlanDetailHtml(
  page: PlanSearchPage,
  listItem: GoszakupPlanListItem,
  options: {
    debugDir: string;
    pageLoadTimeoutMs: number;
    delayMs: number;
  }
): Promise<GoszakupPlanDetail | null> {
  const url = listItem.detail_url
    ?? (listItem.plan_list_number
      ? `https://goszakup.gov.kz/ru/registry/show_plan/${listItem.plan_list_number}/${listItem.plan_point_id}`
      : `https://goszakup.gov.kz/ru/registry/show_plan/${listItem.plan_point_id}`);

  for (let attempt = 0; attempt <= DETAIL_RETRIES; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.pageLoadTimeoutMs });
      await page.waitForTimeout(1500);

      const html = await page.content();
      fs.mkdirSync(options.debugDir, { recursive: true });
      fs.writeFileSync(
        path.join(options.debugDir, `goszakup-plan-detail-${listItem.plan_point_id}.html`),
        html,
        "utf8"
      );

      const detail = parseGoszakupPlanDetailHtml(html, listItem.plan_point_id);
      if (detail) return detail;

      if (attempt < DETAIL_RETRIES) {
        console.warn(`goszakup plan detail: retry ${listItem.plan_point_id} attempt ${attempt + 1}`);
        if (options.delayMs > 0) await sleep(options.delayMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`goszakup plan detail: ${listItem.plan_point_id} failed: ${message}`);
      if (attempt < DETAIL_RETRIES && options.delayMs > 0) await sleep(options.delayMs);
    }
  }

  return null;
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
