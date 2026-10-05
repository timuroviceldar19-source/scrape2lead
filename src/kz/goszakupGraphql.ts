import { GoszakupAuthError } from "./goszakupClient.js";

const GRAPHQL_URL = "https://ows.goszakup.gov.kz/v3/graphql";
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GoszakupGraphqlOptions {
  token: string;
  maxRetries?: number;
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
  /** Per request; a hung connection counts as a retryable failure. */
  timeoutMs?: number;
}

export interface GoszakupGraphqlPage<T> {
  items: T[];
  hasNextPage: boolean;
  lastId: number | null;
}

interface GraphqlPayload {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message?: string }>;
  extensions?: { pageInfo?: { hasNextPage?: boolean; lastId?: number | null } };
}

/**
 * One page of a v3 GraphQL list query. The API returns `null` instead of an
 * empty list, and paginates with `after: pageInfo.lastId`.
 */
export async function goszakupGraphqlPage<T>(
  query: string,
  variables: Record<string, unknown>,
  field: string,
  options: GoszakupGraphqlOptions
): Promise<GoszakupGraphqlPage<T>> {
  const payload = await postWithRetry(query, variables, options);
  if (payload.errors?.length) {
    throw new Error(`goszakup GraphQL: ${payload.errors.map((error) => error.message ?? "?").join("; ")}`);
  }
  const items = payload.data?.[field];
  const pageInfo = payload.extensions?.pageInfo;
  return {
    items: Array.isArray(items) ? items as T[] : [],
    hasNextPage: Boolean(pageInfo?.hasNextPage),
    lastId: pageInfo?.lastId ?? null
  };
}

/** Follows `after` until the last page. The query must declare `$after: Int`. */
export async function goszakupGraphqlAll<T>(
  query: string,
  variables: Record<string, unknown>,
  field: string,
  options: GoszakupGraphqlOptions
): Promise<T[]> {
  const items: T[] = [];
  let after = 0;
  for (;;) {
    const page = await goszakupGraphqlPage<T>(query, { ...variables, after }, field, options);
    items.push(...page.items);
    if (!page.hasNextPage) return items;
    // A half list would read as "no contract yet"; better to fail the lookup.
    if (page.lastId === null || page.lastId === after) {
      throw new Error(`goszakup GraphQL: ${field} says there is a next page but gives no cursor after ${after}`);
    }
    after = page.lastId;
  }
}

async function postWithRetry(
  query: string,
  variables: Record<string, unknown>,
  options: GoszakupGraphqlOptions
): Promise<GraphqlPayload> {
  const { token, fetchFn = fetch } = options;
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    let response: Response;
    try {
      response = await fetchFn(GRAPHQL_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    if (response.status === 401 || response.status === 403) throw new GoszakupAuthError(response.status);
    if (RETRYABLE_STATUSES.has(response.status)) {
      lastError = new Error(`goszakup GraphQL: HTTP ${response.status}`);
      continue;
    }
    if (!response.ok) throw new Error(`goszakup GraphQL: HTTP ${response.status}`);

    const text = await response.text();
    try {
      return JSON.parse(text) as GraphqlPayload;
    } catch {
      lastError = new Error(`goszakup GraphQL: invalid JSON (${text.slice(0, 80)})`);
    }
  }

  throw lastError ?? new Error("goszakup GraphQL: request failed");
}
