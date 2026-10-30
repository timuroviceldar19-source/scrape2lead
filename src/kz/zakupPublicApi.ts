/**
 * Открытый API Единой платформы закупок (zakup.gov.kz): адреса, с которых берёт данные сам сайт.
 * Токен не нужен. Документации и лимитов нет, поэтому ходим бережно: пауза между запросами и повтор при сбоях.
 */
export const ZAKUP_API_URL = "https://zakup.gov.kz/api/core/api";
/** Больше 100 записей на страницу API не отдаёт, даже если попросить. */
export const ZAKUP_PAGE_SIZE = 100;

export class ZakupRecordNotFoundError extends Error {}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAUSE_MS = 100;

export interface ZakupApiOptions {
  fetchFn?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Per request; a hung connection counts as a retryable failure. */
  timeoutMs?: number;
  /** Pause before every request, so a long run does not hammer the site. */
  pauseMs?: number;
}

export interface ZakupPage<T> {
  count: number;
  next: string | null;
  results: T[];
}

export type ZakupParams = Record<string, string | number | boolean | null | undefined>;

export function buildZakupUrl(path: string, params: ZakupParams = {}): string {
  const url = new URL(`${ZAKUP_API_URL}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function zakupGet<T>(path: string, params: ZakupParams = {}, options: ZakupApiOptions = {}): Promise<T> {
  const { fetchFn = fetch } = options;
  const maxRetries = options.maxRetries ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const url = buildZakupUrl(path, params);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const delay = attempt > 0 ? retryDelayMs * attempt : pauseMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } })?.cause?.code;
      lastError = new Error(`zakup ${path}: ${cause ?? (error instanceof Error ? error.message : String(error))}`);
      continue;
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      lastError = new Error(`zakup ${path}: HTTP ${response.status}`);
      continue;
    }
    const text = await response.text();
    // 400 приходит, например, на незнакомый параметр: повтор не поможет.
    if (response.status === 404 && /^\/public\/(?:plan-items\/\d+\/|contracts\/\d+\/subjects\/)$/.test(path)) {
      throw new ZakupRecordNotFoundError(`zakup ${path}: HTTP 404`);
    }
    if (!response.ok) throw new Error(`zakup ${path}: HTTP ${response.status} ${text.slice(0, 120)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      lastError = new Error(`zakup ${path}: invalid JSON (${text.slice(0, 80)})`);
    }
  }

  throw lastError ?? new Error(`zakup ${path}: request failed`);
}

/** Walks `limit`/`offset` pages until `count` records are read or a page comes back short. */
export async function zakupListAll<T>(path: string, params: ZakupParams = {}, options: ZakupApiOptions = {}): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += ZAKUP_PAGE_SIZE) {
    const page = await zakupGet<ZakupPage<T>>(path, { ...params, limit: ZAKUP_PAGE_SIZE, offset }, options);
    if (!Array.isArray(page?.results)) throw new Error(`zakup ${path}: response without results`);
    items.push(...page.results);
    if (page.results.length < ZAKUP_PAGE_SIZE || items.length >= page.count) return items;
  }
}

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
