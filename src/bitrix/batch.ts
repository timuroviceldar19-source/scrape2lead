/**
 * Bitrix24 batch.json client: packs up to 50 REST commands into one request.
 * Commands are serialized as "method?query" strings with PHP-style nested
 * keys (filter[ORIGIN_ID]=...&select[0]=...), which is the official format.
 */

export const BITRIX_BATCH_LIMIT = 50;

export interface BitrixBatchCommand {
  /** Unique key inside one batch call; results are mapped back by this key. */
  key: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface BitrixBatchCommandError {
  error: string;
  error_description?: string;
}

export interface BitrixBatchCommandResult {
  result?: unknown;
  error?: BitrixBatchCommandError;
}

export interface CallBitrixBatchOptions {
  fetchImpl?: typeof fetch;
  /** Extra attempts for retriable failures (HTTP 5xx, rate limits). Default 2. */
  retries?: number;
  /** Base backoff between attempts; multiplied by the attempt number. Default 1000. */
  backoffMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

const RETRIABLE_ERROR_CODES = new Set([
  "QUERY_LIMIT_EXCEEDED",
  "OPERATION_TIME_LIMIT",
  "INTERNAL_SERVER_ERROR"
]);

export function serializeBatchParams(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  appendParams(pairs, params, "");
  return pairs.join("&");
}

function appendParams(pairs: string[], value: unknown, prefix: string): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendParams(pairs, entry, `${prefix}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      appendParams(pairs, entry, prefix ? `${prefix}[${key}]` : key);
    }
    return;
  }
  pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
}

export function serializeBatchCommand(command: BitrixBatchCommand): string {
  const query = command.params ? serializeBatchParams(command.params) : "";
  return query ? `${command.method}?${query}` : command.method;
}

export function chunkBatchCommands<T>(commands: readonly T[], size = BITRIX_BATCH_LIMIT): T[][] {
  if (size < 1) throw new Error(`batch chunk size must be >= 1, got ${size}`);
  const chunks: T[][] = [];
  for (let start = 0; start < commands.length; start += size) {
    chunks.push(commands.slice(start, start + size));
  }
  return chunks;
}

/**
 * Executes one batch of commands (max 50). Retriable failures — top-level
 * HTTP/network errors and per-command rate-limit errors — are retried with
 * linear backoff; other command errors are returned to the caller, who is
 * expected to fall back to the sequential single-call path.
 */
export async function callBitrixBatch(
  webhookBaseUrl: string,
  commands: readonly BitrixBatchCommand[],
  options: CallBitrixBatchOptions = {}
): Promise<Map<string, BitrixBatchCommandResult>> {
  if (commands.length === 0) return new Map();
  if (commands.length > BITRIX_BATCH_LIMIT) {
    throw new Error(`batch supports at most ${BITRIX_BATCH_LIMIT} commands, got ${commands.length}`);
  }
  const keys = new Set(commands.map((command) => command.key));
  if (keys.size !== commands.length) {
    throw new Error("batch command keys must be unique");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 1000;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const baseUrl = webhookBaseUrl.replace(/\/+$/, "");

  const results = new Map<string, BitrixBatchCommandResult>();
  let pending = [...commands];

  for (let attempt = 0; pending.length > 0; attempt++) {
    let response: BatchResponse;
    try {
      response = await executeBatchRequest(fetchImpl, baseUrl, pending);
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleepImpl(backoffMs * (attempt + 1));
      continue;
    }

    const retryNext: BitrixBatchCommand[] = [];
    for (const command of pending) {
      // A command counts as successful only when its own key is present in
      // result.result. A key missing from BOTH result and result_error is a
      // truncated/partial response — surface it as a synthetic error so the
      // caller falls back to a sequential lookup instead of silently reading
      // it as an empty result set.
      if (Object.prototype.hasOwnProperty.call(response.results, command.key)) {
        results.set(command.key, { result: response.results[command.key] });
        continue;
      }
      const commandError = response.errors[command.key] ?? {
        error: "MISSING_BATCH_RESULT",
        error_description: `batch response contained no result or error for command ${command.key}`
      };
      if (attempt < retries && RETRIABLE_ERROR_CODES.has(commandError.error)) {
        retryNext.push(command);
      } else {
        results.set(command.key, { error: commandError });
      }
    }

    pending = retryNext;
    if (pending.length > 0) await sleepImpl(backoffMs * (attempt + 1));
  }

  return results;
}

interface BatchResponse {
  results: Record<string, unknown>;
  errors: Record<string, BitrixBatchCommandError>;
}

async function executeBatchRequest(
  fetchImpl: typeof fetch,
  baseUrl: string,
  commands: readonly BitrixBatchCommand[]
): Promise<BatchResponse> {
  const cmd: Record<string, string> = {};
  for (const command of commands) {
    cmd[command.key] = serializeBatchCommand(command);
  }

  const response = await fetchImpl(`${baseUrl}/batch.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ halt: 0, cmd })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`batch.json HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json() as {
    error?: string;
    error_description?: string;
    result?: {
      result?: Record<string, unknown> | unknown[];
      result_error?: Record<string, BitrixBatchCommandError> | unknown[];
    };
  };
  if (payload.error) {
    throw new Error(`batch.json error ${payload.error}: ${payload.error_description ?? ""}`);
  }

  return {
    results: toRecord(payload.result?.result),
    errors: toRecord(payload.result?.result_error)
  };
}

/** Bitrix serializes empty maps as [] — normalize both shapes to a record. */
function toRecord<T>(value: Record<string, T> | unknown[] | undefined): Record<string, T> {
  if (!value || Array.isArray(value)) return {};
  return value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
