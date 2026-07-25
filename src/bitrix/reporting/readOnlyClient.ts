export interface BitrixTransport { call(method: string, body?: unknown): Promise<unknown> }

export const READ_ONLY_METHODS = [
  "batch", "crm.category.list", "crm.status.list", "crm.deal.fields", "crm.deal.userfield.list",
  "crm.deal.list", "crm.stagehistory.list", "crm.company.list", "crm.activity.list"
] as const;

const allowed = new Set<string>(READ_ONLY_METHODS);

function pushFlat(target: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => pushFlat(target, `${key}[${index}]`, item));
  } else if (typeof value === "object") {
    for (const [child, item] of Object.entries(value as Record<string, unknown>)) pushFlat(target, `${key}[${child}]`, item);
  } else target.append(key, String(value));
}

export function flattenBitrixParams(params: Record<string, unknown>): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) pushFlat(result, key, value);
  return result.toString();
}

export class ReadOnlyBitrixClient {
  constructor(private readonly transport: BitrixTransport) {}

  async call(method: string, body: unknown = {}): Promise<unknown> {
    if (!allowed.has(method)) throw new Error(`Bitrix reporting client is read-only; method ${method} is not allowed`);
    if (method === "batch") {
      const commands = (body as { cmd?: Record<string, string> })?.cmd ?? {};
      for (const command of Object.values(commands)) {
        const subMethod = command.split("?", 1)[0];
        if (!allowed.has(subMethod) || subMethod === "batch") throw new Error(`Bitrix reporting batch is read-only; method ${subMethod} is not allowed`);
      }
    }
    return this.transport.call(method, body);
  }

  async listAllBatched<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    nestedKey?: string,
    maxBatches = 100
  ): Promise<T[]> {
    if (!allowed.has(method) || method === "batch") throw new Error(`Bitrix reporting client is read-only; method ${method} is not allowed`);
    const rows: T[] = [];
    const pageSize = 50;
    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
      const cmd: Record<string, string> = {};
      for (let page = 0; page < 50; page++) {
        const key = `p${page}`;
        cmd[key] = `${method}?${flattenBitrixParams({ ...params, start: (batchIndex * 50 + page) * pageSize })}`;
      }
      const raw = await this.call("batch", { halt: 0, cmd }) as { result?: Record<string, unknown>; result_error?: Record<string, unknown> };
      const errors = raw.result_error ?? {};
      if (Object.keys(errors).length) throw new Error(`${method}: batch returned ${JSON.stringify(errors)}`);
      const result = raw.result ?? {};
      for (let page = 0; page < 50; page++) {
        const value = result[`p${page}`];
        const items = nestedKey && value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)[nestedKey]
          : value;
        const pageRows = Array.isArray(items) ? items as T[] : [];
        rows.push(...pageRows);
        if (pageRows.length < pageSize) return rows;
      }
    }
    throw new Error(`${method}: exceeded ${maxBatches * 50 * pageSize} records`);
  }
}
