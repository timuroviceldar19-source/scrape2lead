import type { ProcurementRecord } from "./types.js";

export function parseTizilimTender(input: unknown, collectedAt = new Date().toISOString()): ProcurementRecord {
  const row = object(input);
  const customer = object(row.customer);
  const externalId = text(row.number);
  return {
    source: "tizilim", recordKind: "tender", sourceRecordId: nullableText(row.id), externalId,
    parentExternalId: nullableText(row.plan_number ?? row.parent_number),
    status: nullableText(object(row.status).name_ru ?? row.status_name),
    productName: text(row.name_ru), description: text(row.description_ru),
    truCode: nullableText(row.tru_code ?? row.enstru_code),
    customerName: nullableText(customer.name_ru ?? row.customer_name), customerBin: normalizeBin(customer.bin ?? row.customer_bin),
    amount: number(row.amount), currency: "KZT", startDate: nullableText(row.start_date), endDate: nullableText(row.end_date),
    url: externalId ? `https://public.tizilim.gov.kz/ru/common/tender?search=${encodeURIComponent(externalId)}` : "",
    purchaseMethod: nullableText(object(row.type).name_ru ?? row.type_name), collectedAt
  };
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return value === null || value === undefined ? "" : String(value).trim(); }
function nullableText(value: unknown): string | null { return text(value) || null; }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function normalizeBin(value: unknown): string | null { const digits = text(value).replace(/\D/g, ""); return digits.length === 12 ? digits : null; }
