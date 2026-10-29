import { GoszakupAuthError } from "./goszakupClient.js";
import { fetchGzPlans, type GzPlanLookupOptions } from "./zakupGzPlans.js";
import { withGzSourceFallback } from "./zakupGzRegistry.js";

export const GZ_GRAPHQL_URL = "https://ows.goszakup.gov.kz/v3/graphql";
export const PLAN_STATUS_BATCH_SIZE = 50;
export const PLAN_STATUS_QUERY_LIMIT = 200;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;

export interface PlanStatusApiOptions extends GzPlanLookupOptions {
  sleepFn?: (ms: number) => Promise<void>;
}

interface PlanRow {
  id?: unknown;
  rootrecordId?: unknown;
  RefPlnPointStatus?: { nameRu?: unknown } | null;
}

export function chunkPlanNumbers(planNumbers: readonly string[], size = PLAN_STATUS_BATCH_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < planNumbers.length; start += size) {
    chunks.push(planNumbers.slice(start, start + size));
  }
  return chunks;
}

export function buildPlanStatusQuery(planNumbers: readonly string[]): string {
  const invalid = planNumbers.find((value) => !/^\d+$/.test(value));
  if (invalid !== undefined) throw new Error(`plan number must be digits only, got "${invalid}"`);
  return `{ Plans(filter:{rootrecordId:[${planNumbers.join(",")}]}, limit:${PLAN_STATUS_QUERY_LIMIT}){ id rootrecordId RefPlnPointStatus{ nameRu } } }`;
}

export interface ParsedPlanStatuses {
  /** rootrecordId → status name of the newest version (highest id). */
  statuses: Map<string, string>;
  rowCount: number;
}

export function parsePlanStatusResponse(payload: unknown): ParsedPlanStatuses {
  const body = payload as { data?: { Plans?: unknown } | null; errors?: Array<{ message?: string }> } | null;
  if (body?.errors?.length) {
    throw new Error(`goszakup graphql: ${body.errors.map((error) => error.message ?? "unknown error").join("; ")}`);
  }
  if (!body || body.data == null) {
    throw new Error("goszakup graphql: response has no data");
  }
  const plans = body.data.Plans;
  if (plans === null) {
    return {
      statuses: new Map(),
      rowCount: 0
    };
  }
  if (!Array.isArray(plans)) throw new Error("goszakup graphql: response has no data.Plans array");

  const newest = new Map<string, { id: number; status: string }>();
  for (const row of plans as PlanRow[]) {
    const root = scalar(row.rootrecordId);
    const status = scalar(row.RefPlnPointStatus?.nameRu);
    const id = Number(row.id);
    if (!root || !status || !Number.isFinite(id)) continue;
    const known = newest.get(root);
    if (!known || id > known.id) newest.set(root, { id, status });
  }
  return {
    statuses: new Map([...newest].map(([root, entry]) => [root, entry.status])),
    rowCount: plans.length
  };
}

/**
 * Fetches the actual plan-point status per rootrecordId for ONE batch (<= 50 numbers).
 * Numbers missing from the result are absent from the returned map ("not in API").
 */
export async function fetchPlanStatusBatch(
  planNumbers: readonly string[],
  options: PlanStatusApiOptions
): Promise<Map<string, string>> {
  if (planNumbers.length > PLAN_STATUS_BATCH_SIZE) {
    throw new Error(`batch supports at most ${PLAN_STATUS_BATCH_SIZE} plan numbers, got ${planNumbers.length}`);
  }
  buildPlanStatusQuery(planNumbers);
  return withGzSourceFallback(async () => {
    const plans = await fetchGzPlans(planNumbers.map(Number), "root", { ...options, token: null });
    return new Map(plans.filter(plan => plan.RefPlnPointStatus?.nameRu && !plan.isDeleted && plan.isActive !== 0)
      .map(plan => [String(plan.rootrecordId), plan.RefPlnPointStatus!.nameRu!]));
  }, () => fetchChunk([...planNumbers], options), options.token);
}

async function fetchChunk(chunk: string[], options: PlanStatusApiOptions): Promise<Map<string, string>> {
  if (chunk.length === 0) return new Map();
  const parsed = parsePlanStatusResponse(await postQuery(buildPlanStatusQuery(chunk), options));
  // Many historic versions per plan point can hit the row limit and hide other points: split and retry.
  if (parsed.rowCount >= PLAN_STATUS_QUERY_LIMIT && chunk.length > 1) {
    const middle = Math.ceil(chunk.length / 2);
    const merged = await fetchChunk(chunk.slice(0, middle), options);
    for (const [root, status] of await fetchChunk(chunk.slice(middle), options)) merged.set(root, status);
    return merged;
  }
  return parsed.statuses;
}

async function postQuery(query: string, options: PlanStatusApiOptions): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchFn(GZ_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`
      },
      body: JSON.stringify({ query })
    });
    if (response.status === 401 || response.status === 403) throw new GoszakupAuthError(response.status);
    if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
      await sleepFn(1000 * (attempt + 1));
      continue;
    }
    if (!response.ok) throw new Error(`goszakup graphql: HTTP ${response.status}`);
    return response.json();
  }
  throw new Error("goszakup graphql: max retries exceeded");
}

function scalar(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text || null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
