const USER_AGENT = "scrape2lead/1.7";

export type ProcurementJsonFetcher = (url: string) => Promise<unknown>;

/** Ошибка HTTP с сохранённым статусом — без него 404 неотличим от сбоя сети. */
export class ProcurementHttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`procurement request failed: HTTP ${status} for ${url}`);
    this.name = "ProcurementHttpError";
  }
}

/**
 * 404 — это ответ источника «такой записи нет», а не сбой: повторять его бессмысленно.
 * Остальные ошибки (сеть, 429, 5xx) считаем временными.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ProcurementHttpError) return error.status !== 404 && error.status !== 410;
  return true;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ProcurementHttpError && (error.status === 404 || error.status === 410);
}

export async function fetchProcurementJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
  if (!response.ok) throw new ProcurementHttpError(response.status, url);
  return await response.json();
}

export async function withRetry<T>(
  action: () => Promise<T>,
  options: { maxAttempts: number; delayMs: number; shouldRetry?: (error: unknown) => boolean }
): Promise<T> {
  const shouldRetry = options.shouldRetry ?? isRetryableError;
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, options.maxAttempts); attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
      if (attempt < options.maxAttempts && options.delayMs > 0) {
        await wait(options.delayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
