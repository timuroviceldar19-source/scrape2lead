import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { sleep } from "./csv.js";
import { buildGoszakupHtmlPageUrl } from "./goszakupHtmlCollector.js";
import {
  fetchPlanDetailFromApi,
  loadAbpRefs,
  resolveAbpName
} from "./goszakupPlanClient.js";
import { resolvePlanStatusNames } from "./gzPlansConfig.js";
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
  GzPlanCollectResult
} from "./goszakupPlanTypes.js";
import { DEFAULT_GZ_PLAN_KEYWORDS as DEFAULT_KEYWORDS } from "./goszakupPlanTypes.js";

const DEFAULT_DEBUG_DIR = "data/debug";
const MAX_PAGES_DEFAULT = 50;
const DETAIL_RETRIES = 2;

export async function collectGzPlans(options: GzPlanCollectOptions = {}): Promise<GzPlanCollectResult> {
  const keywords = options.keywords ?? [...DEFAULT_KEYWORDS];
  const year = options.year ?? 2026;
  const months = options.months ?? [6, 7, 8];
  const statuses = options.statuses ?? [];
  const allowedStatusNames = resolvePlanStatusNames(statuses);
  const maxPages = options.maxPages ?? MAX_PAGES_DEFAULT;
  const delayMs = options.delayMs ?? 2000;
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
  const pageLoadTimeoutMs = options.pageLoadTimeoutMs ?? 30_000;
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
    for (const keyword of keywords) {
      options.onProgress?.(`search: ${keyword}`);
      // Do not pass statusIds: goszakup returns a maintenance page when filter[status][] is in the URL.
      const baseUrl = buildPlanSearchUrl({ keyword, year, months });
      const items = await collectPlanSearch(page, baseUrl, keyword, {
        debugDir,
        maxPages,
        pageLoadTimeoutMs,
        delayMs,
        allowedStatusNames
      });

      for (const item of items) {
        if (!matchesPlanStatus(item.status, allowedStatusNames)) continue;
        if (options.keepDuplicates) {
          listItems.push(item);
        } else {
          listById.set(item.plan_point_id, item);
        }
      }

      console.log(`goszakup plan search: keyword="${keyword}" rows=${items.length}`);
      if (delayMs > 0) await sleep(delayMs);
    }

    const results: GzPlanCollectResult["items"] = [];
    let index = 0;
    const collectedItems = options.keepDuplicates ? listItems : [...listById.values()];
    const total = collectedItems.length;

    for (const listItem of collectedItems) {
      index++;
      options.onProgress?.(`detail ${index}/${total}: ${listItem.plan_point_id}`);

      let detail: GoszakupPlanDetail | null = null;

      if (token) {
        detail = await fetchPlanDetailFromApi(listItem.plan_point_id, { token });
        if (detail) {
          detail.abp_name = resolveAbpName(detail, abpRefs);
        }
      }

      if (!detail) {
        detail = await fetchPlanDetailHtml(page, listItem, {
          debugDir,
          pageLoadTimeoutMs,
          delayMs
        });
      }

      if (detail && !detail.name_ru) {
        detail.name_ru = listItem.item_name;
      }
      if (detail && !detail.customer_name) {
        detail.customer_name = listItem.customer_name;
      }

      results.push({ ...listItem, detail });
      if (delayMs > 0) await sleep(delayMs);
    }

    return { items: results };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function collectPlanSearch(
  page: Page,
  baseUrl: string,
  keyword: string,
  options: {
    debugDir: string;
    maxPages: number;
    pageLoadTimeoutMs: number;
    delayMs: number;
    allowedStatusNames: string[];
  }
): Promise<GoszakupPlanListItem[]> {
  const allItems: GoszakupPlanListItem[] = [];
  let pageNum = 0;

  while (pageNum < options.maxPages) {
    const url = buildGoszakupHtmlPageUrl(baseUrl, pageNum);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.pageLoadTimeoutMs });
    await page.waitForTimeout(1500);

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
    if (parsed.length === 0) break;

    allItems.push(...items);

    const pagination = parseGoszakupPagination(html);
    const totalPages = Math.min(pagination.totalPages > 0 ? pagination.totalPages : 1, options.maxPages);
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

async function fetchPlanDetailHtml(
  page: Page,
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

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
