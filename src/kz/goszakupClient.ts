import { isValidBin } from "./csv.js";

const BASE_URL = "https://ows.goszakup.gov.kz";

export interface GoszakupClientOptions {
  token: string;
  maxPages?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

export interface GoszakupRawItem {
  id: number | null;
  number_anno: string | null;
  name_ru: string | null;
  name_kz: string | null;
  customer_name_ru: string | null;
  customer_name_kz: string | null;
  org_name_ru: string | null;
  org_name_kz: string | null;
  org_bin: string | null;
  total_sum: number | string | null;
  ref_buy_status_id: number | null;
  start_date: string | null;
  end_date: string | null;
  ref_trade_methods_id: number | null;
  [key: string]: unknown;
}

interface V3PageResponse {
  total: number;
  limit: number;
  next_page: string;
  items: Array<Record<string, unknown>>;
}

const DEFAULT_MAX_PAGES = 20;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class GoszakupAuthError extends Error {
  constructor(status: number) {
    super(`goszakup.gov.kz: HTTP ${status} — invalid or expired token`);
    this.name = "GoszakupAuthError";
  }
}

export async function goszakupGetJson(
  path: string,
  options: GoszakupClientOptions
): Promise<unknown> {
  const { token, fetchFn = fetch } = options;
  const maxRetries = options.maxRetries ?? 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    const response = await fetchFn(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (response.status === 401 || response.status === 403) {
      throw new GoszakupAuthError(response.status);
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      const delay = response.status === 429
        ? Math.min(2000 * Math.pow(2, attempt), 30_000)
        : 1000 * (attempt + 1);
      console.warn(`goszakup.gov.kz: HTTP ${response.status} on attempt ${attempt + 1}, retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!response.ok) {
      throw new Error(`goszakup.gov.kz: HTTP ${response.status} for ${path}`);
    }

    return response.json() as Promise<unknown>;
  }

  throw lastError ?? new Error(`goszakup.gov.kz: max retries exceeded for ${path}`);
}

export async function fetchAllTrdBuyByBin(
  bin: string,
  options: GoszakupClientOptions
): Promise<{ items: GoszakupRawItem[]; pages: number }> {
  if (!isValidBin(bin)) {
    console.warn(`goszakup.gov.kz: skip invalid BIN ${bin}`);
    return { items: [], pages: 0 };
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const allItems: GoszakupRawItem[] = [];
  let currentPage = 0;
  let nextPath = `/v3/trd-buy/bin/${bin}`;

  while (nextPath && currentPage < maxPages) {
    currentPage++;
    const payload = await goszakupGetJson(nextPath, options) as V3PageResponse;

    if (Array.isArray(payload.items)) {
      for (const item of payload.items) {
        if (isObject(item)) {
          allItems.push(item as unknown as GoszakupRawItem);
        }
      }
    }

    nextPath = typeof payload.next_page === "string" && payload.next_page.trim() !== ""
      ? payload.next_page
      : "";
  }

  return { items: allItems, pages: currentPage };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
