/**
 * Открытый API Единой платформы закупок (zakup.gov.kz): адреса, с которых берёт данные сам сайт.
 * Токен не нужен. Документации и лимитов нет, поэтому ходим бережно: пауза между запросами и повтор при сбоях.
 */
export const ZAKUP_API_URL = "https://zakup.gov.kz/api/core/api";
/** Больше 100 записей на страницу API не отдаёт, даже если попросить. */
export const ZAKUP_PAGE_SIZE = 100;

export class ZakupRecordNotFoundError extends Error {}
export class ZakupIncompleteDataError extends Error {}

/** Только безопасные HTTP/сетевые причины: без URL, токенов и тел ответов. */
export function zakupErrorReason(error: unknown): string {
  const reasons = new Set<string>();
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    const e = current as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    const message = typeof e.message === "string" ? e.message : "";
    for (const match of message.matchAll(/\bHTTP [1-5]\d{2}\b/g)) reasons.add(match[0]);
    if (typeof e.code === "string" && /^[A-Z0-9_]+$/.test(e.code)) reasons.add(e.code);
    if (message.includes("invalid JSON")) reasons.add("invalid JSON");
    for (const name of ["TimeoutError", "AbortError", "TypeError", "SyntaxError"]) {
      if (e.name === name || new RegExp(`\\b${name}\\b`).test(message)) reasons.add(name);
    }
    current = e.cause;
  }
  return [...reasons].join(", ") || (error instanceof ZakupIncompleteDataError ? "неполные данные" : "Error");
}

/** Сохраняем безопасный код в cause, не перенося туда исходный текст или тело ответа. */
export function zakupSafeCause(error: unknown): Error {
  const reason = zakupErrorReason(error);
  const code = reason.split(", ").find(item => /^[A-Z0-9_]+$/.test(item));
  return Object.assign(new Error(reason), { code });
}

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
      lastError = new Error(`zakup ${path}: ${zakupErrorReason(error)}`, { cause: error });
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
    } catch (error) {
      lastError = new Error(`zakup ${path}: invalid JSON`, { cause: error });
    }
  }

  throw lastError ?? new Error(`zakup ${path}: request failed`);
}

/** Walks `limit`/`offset` pages until `count` records are read or a page comes back short. */
export async function zakupListAll<T>(path: string, params: ZakupParams = {}, options: ZakupApiOptions = {}): Promise<T[]> {
  const items: T[] = [];
  let expectedCount = 0;
  for (let offset = 0; ; offset += ZAKUP_PAGE_SIZE) {
    const pageParams = { ...params, limit: ZAKUP_PAGE_SIZE, offset };
    let page = await zakupGet<ZakupPage<T>>(path, pageParams, options);
    if (!Array.isArray(page?.results) || !Number.isSafeInteger(page.count) || page.count < 0) {
      throw new ZakupIncompleteDataError("zakup: неполные данные страницы списка");
    }
    // The live API rejects offset >= 10000. Partition inclusive signing dates
    // before crossing that ceiling; never return a truncated month as complete.
    if (offset === 0 && page.count > 10000) {
      const from = String(params.sign_date__gte ?? "");
      const to = String(params.sign_date__lte ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from >= to) {
        throw new Error(`zakup ${path}: ${page.count} records exceed the 10000-record window; use a smaller signing-date range`);
      }
      const first = Date.parse(`${from}T00:00:00Z`), last = Date.parse(`${to}T00:00:00Z`);
      const middle = first + Math.floor((last - first) / 86400000 / 2) * 86400000;
      const left = await zakupListAll<T>(path, { ...params, sign_date__lte: new Date(middle).toISOString().slice(0, 10) }, options);
      const right = await zakupListAll<T>(path, { ...params, sign_date__gte: new Date(middle + 86400000).toISOString().slice(0, 10) }, options);
      return [...left, ...right];
    }
    expectedCount = Math.max(expectedCount, page.count);
    if (page.results.length < ZAKUP_PAGE_SIZE && items.length + page.results.length < expectedCount) {
      const delay = options.retryDelayMs ?? 2000;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        page = await zakupGet<ZakupPage<T>>(path, pageParams, options);
      } catch (cause) {
        throw new ZakupIncompleteDataError("zakup: повторное чтение неполной страницы не удалось", { cause: zakupSafeCause(cause) });
      }
      if (!Array.isArray(page?.results) || !Number.isSafeInteger(page.count) || page.count < 0) {
        throw new ZakupIncompleteDataError("zakup: неполная страница списка");
      }
      expectedCount = Math.max(expectedCount, page.count);
      if (page.results.length < ZAKUP_PAGE_SIZE && items.length + page.results.length < expectedCount) {
        throw new ZakupIncompleteDataError(`zakup: неполный список, получено ${items.length + page.results.length} из ${expectedCount}`);
      }
    }
    items.push(...page.results);
    if (items.length >= expectedCount) return items;
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
