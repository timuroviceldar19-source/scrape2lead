/** Пропуск означает неполную выдачу, а не отсутствие закупок. Номера страниц — с 1. */
export interface GzSkippedQuery {
  stage: "plans" | "lots" | "registry";
  query: string;
  year: number;
  months: number[];
  failedPage: number | null;
  totalPages: number | null;
  keptRows: number;
  attempts: number;
  reason: string;
  planPointIds?: string[];
}

export interface GzCollectionReport {
  /** Запросы, в которых прочитана хотя бы одна страница, включая корректную пустую выдачу. */
  successfulQueries?: number;
  skippedQueries?: GzSkippedQuery[];
}
export type GzQueryContext = Pick<GzSkippedQuery, "stage" | "query" | "year" | "months">;

/** Согласовано с NETWORK_PATTERN в run-automation-with-retry.sh. Проверяем также cause/code Node fetch. */
export function isTransientNetworkError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error != null && !seen.has(error)) {
    seen.add(error);
    const item = typeof error === "object" ? error as { name?: string; message?: string; code?: string; cause?: unknown } : null;
    if (item?.name === "TimeoutError") return true;
    const message = typeof error === "string" ? error : `${item?.message ?? ""} ${item?.code ?? ""}`;
    if (/net::ERR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|page\.goto: Timeout|fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) return true;
    error = item?.cause;
  }
  return false;
}

export function collectionErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
}

/** Один экземпляр на период/вызов. Успешная пустая выдача также сбрасывает цепочку сбоев. */
export class GzCollectionState {
  readonly skippedQueries: GzSkippedQuery[] = [];
  successfulQueries = 0;
  private consecutiveFailures = 0;

  constructor(private readonly maxConsecutiveNetworkFailures = 3) {
    if (!Number.isInteger(maxConsecutiveNetworkFailures) || maxConsecutiveNetworkFailures < 1) {
      throw new Error("maxConsecutiveNetworkFailures must be a positive integer");
    }
  }

  skipIfOpen(query: GzQueryContext): boolean {
    if (this.consecutiveFailures < this.maxConsecutiveNetworkFailures) return false;
    this.skippedQueries.push({ ...query, failedPage: 1, totalPages: null, keptRows: 0, attempts: 0,
      reason: "circuit_breaker: portal unreachable" });
    return true;
  }

  complete(): void { this.successfulQueries++; this.consecutiveFailures = 0; }

  fail(query: GzQueryContext, failedPage: number, totalPages: number | null, keptRows: number, attempts: number, error: unknown): void {
    this.skippedQueries.push({ ...query, failedPage, totalPages, keptRows, attempts, reason: collectionErrorMessage(error) });
    if (failedPage > 1) this.complete();
    else this.consecutiveFailures++;
  }

  report(): Required<GzCollectionReport> {
    return { successfulQueries: this.successfulQueries, skippedQueries: this.skippedQueries };
  }
}

export class GzSourceUnavailableError extends Error {
  readonly sourceUnreachable = true;
  constructor(readonly skippedQueries: GzSkippedQuery[]) {
    super("fetch failed: источник полностью недоступен; ни один поисковый запрос не прочитан");
    this.name = "GzSourceUnavailableError";
  }
}

/** HTTP 429/5xx и техработы нельзя принимать за штатный ответ «Найдено 0». */
export function assertPortalResponse(response: unknown): void {
  const status = (response as { status?: () => number } | null)?.status?.();
  if (status === 429 || (status !== undefined && status >= 500)) throw new Error(`fetch failed: portal HTTP ${status}`);
  if (status !== undefined && status >= 400) throw new Error(`portal HTTP ${status}`);
}

export function assertPortalHtmlAvailable(html: string): void {
  if (/технические работы/i.test(html) && !/id=["']search-result["']/i.test(html)) {
    throw new Error("fetch failed: portal maintenance page");
  }
}
