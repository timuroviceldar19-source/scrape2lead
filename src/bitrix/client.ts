export type BitrixEntity = "lead" | "deal" | "company" | "contact";

export interface BitrixClientOptions {
  /** Minimum interval between REST calls; Bitrix24 allows ~2 requests/second. */
  requestDelayMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export class BitrixApiError extends Error {
  readonly code: string | null;
  readonly status: number | null;

  constructor(message: string, code: string | null, status: number | null) {
    super(message);
    this.name = "BitrixApiError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_REQUEST_DELAY_MS = 500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const RETRIABLE_ERROR_CODES = new Set(["QUERY_LIMIT_EXCEEDED", "OPERATION_TIME_LIMIT"]);

interface BitrixResponsePayload {
  result?: unknown;
  error?: string;
  error_description?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BitrixClient {
  private readonly baseUrl: string;
  private readonly requestDelayMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastCallAt = 0;

  constructor(webhookUrl: string, options: BitrixClientOptions = {}) {
    const trimmed = webhookUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(trimmed)) {
      throw new Error("Bitrix webhook URL must be an http(s) URL");
    }
    this.baseUrl = trimmed;
    this.requestDelayMs = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call(method: string, body: unknown = {}): Promise<unknown> {
    let lastError: BitrixApiError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }
      await this.throttle();

      let status: number | null = null;
      let payload: BitrixResponsePayload | null = null;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/${method}.json`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        status = response.status;
        payload = await response.json() as BitrixResponsePayload;
      } catch (error) {
        lastError = new BitrixApiError(
          `${method}: network error: ${error instanceof Error ? error.message : String(error)}`,
          null,
          status
        );
        continue;
      }

      const code = payload.error ?? null;
      if (status < 400 && !code) {
        return payload.result;
      }

      lastError = new BitrixApiError(
        `${method}: ${payload.error_description || code || `HTTP ${status}`}`,
        code,
        status
      );
      const retriable = status === 429 || status >= 500 || (code !== null && RETRIABLE_ERROR_CODES.has(code));
      if (!retriable) throw lastError;
    }

    throw lastError ?? new BitrixApiError(`${method}: request failed`, null, null);
  }

  async listAll(
    entity: BitrixEntity,
    filter: Record<string, unknown>,
    select: string[] = ["ID"],
    maxPages = 200
  ): Promise<Record<string, unknown>[]> {
    const PAGE_SIZE = 50;
    const rows: Record<string, unknown>[] = [];
    for (let page = 0; page < maxPages; page++) {
      const result = await this.call(`crm.${entity}.list`, { filter, select, start: page * PAGE_SIZE });
      const batch = Array.isArray(result) ? result as Record<string, unknown>[] : [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) return rows;
    }
    throw new BitrixApiError(
      `crm.${entity}.list: result exceeds ${maxPages * PAGE_SIZE} rows; narrow the filter or raise maxPages`,
      null,
      null
    );
  }

  async findFirst(
    entity: BitrixEntity,
    filter: Record<string, unknown>,
    select: string[] = ["ID"]
  ): Promise<Record<string, unknown> | null> {
    const result = await this.call(`crm.${entity}.list`, { filter, select });
    const rows = Array.isArray(result) ? result as Record<string, unknown>[] : [];
    return rows[0] ?? null;
  }

  async findByOrigin(
    entity: BitrixEntity,
    originatorId: string,
    originId: string
  ): Promise<Record<string, unknown> | null> {
    return this.findFirst(
      entity,
      { ORIGINATOR_ID: originatorId, ORIGIN_ID: originId },
      ["ID", "TITLE", "ORIGINATOR_ID", "ORIGIN_ID", "ASSIGNED_BY_ID"]
    );
  }

  async listFields(entity: BitrixEntity): Promise<Record<string, unknown>> {
    const result = await this.call(`crm.${entity}.fields`);
    return (result ?? {}) as Record<string, unknown>;
  }

  async add(entity: BitrixEntity, fields: Record<string, unknown>): Promise<string> {
    const result = await this.call(`crm.${entity}.add`, {
      fields,
      params: { REGISTER_SONET_EVENT: "Y" }
    });
    return String(result);
  }

  async update(entity: BitrixEntity, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.call(`crm.${entity}.update`, {
      id,
      fields,
      params: { REGISTER_SONET_EVENT: "Y" }
    });
  }

  private async throttle(): Promise<void> {
    const waitMs = this.lastCallAt + this.requestDelayMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    this.lastCallAt = Date.now();
  }
}
