import { isValidBin } from "./csv.js";
import type { TenderRecord } from "./tenderTypes.js";

export interface GoszakupCollectOptions {
  token?: string;
}

export function isGoszakupAvailable(options: GoszakupCollectOptions = {}): boolean {
  return Boolean(options.token ?? process.env.GOSZAKUP_TOKEN);
}

export async function fetchGoszakupTenders(
  bin: string,
  options: GoszakupCollectOptions = {}
): Promise<TenderRecord[]> {
  const token = options.token ?? process.env.GOSZAKUP_TOKEN ?? "";
  if (!token) {
    console.warn("goszakup.gov.kz: skipped, GOSZAKUP_TOKEN is not set");
    return [];
  }
  if (!isValidBin(bin)) {
    console.warn(`goszakup.gov.kz: skip invalid BIN ${bin}`);
    return [];
  }

  const response = await fetch(`https://ows.goszakup.gov.kz/trd-buy/biin/${bin}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });

  if (!response.ok) {
    console.warn(`goszakup.gov.kz: HTTP ${response.status} for ${bin}`);
    return [];
  }

  const payload = await response.json() as unknown;
  return extractItems(payload).map((item) => mapGoszakupTender(item, bin));
}

function extractItems(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  for (const key of ["items", "data", "results", "content"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isObject);
  }
  return [];
}

function mapGoszakupTender(item: Record<string, unknown>, bin: string): TenderRecord {
  const id = stringValue(item.id);
  const number = stringValue(item.number) || id || "N/A";
  return {
    source: "goszakup.gov.kz",
    bin,
    tender_number: number,
    tender_name: stringValue(item.nameRu) || stringValue(item.nameKz) || stringValue(item.name_ru) || "N/A",
    customer_name: stringValue(item.customerName) || stringValue(item.customer_name_ru),
    budget_amount: stringValue(item.sum) || stringValue(item.price),
    currency: "KZT",
    start_date: stringValue(item.startDate) || stringValue(item.start_date),
    end_date: stringValue(item.endDate) || stringValue(item.end_date),
    status: stringValue(item.status) || stringValue(item.status_name),
    method: stringValue(item.method) || stringValue(item.method_name),
    url: `https://goszakup.gov.kz/ru/trd-buy/${id || number}`,
    parsed_at: new Date().toISOString()
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
