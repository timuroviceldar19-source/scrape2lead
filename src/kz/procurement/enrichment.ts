import { classifyProcurementRecords, type ProcurementFilterOptions } from "./filter.js";
import type { ProcurementRecord } from "./types.js";

const EPZ_ORGANIZATIONS = "https://zakup.gov.kz/api/core/api/public/organizations";
const EPZ_ANNOUNCEMENTS = "https://zakup.gov.kz/api/core/api/public/announcements";

export async function enrichEligibleEpzCustomers(
  records: ProcurementRecord[],
  options: { fetchJson?: (url: string) => Promise<unknown>; filter?: ProcurementFilterOptions } = {}
): Promise<ProcurementRecord[]> {
  const fetchJson = options.fetchJson ?? fetchOrganization;
  const eligible = new Set(classifyProcurementRecords(records, options.filter).review
    .filter((item) => ["missing_bin", "missing_tru_code", "ambiguous_panel"].includes(item.reason ?? "") && item.record.source !== "tizilim"
      && (item.record.customerSourceId || item.record.announcementSourceId))
    .map((item) => `${item.record.source}:${item.record.recordKind}:${item.record.externalId}`));
  const cache = new Map<string, Promise<EnrichedOrganization>>();
  return await Promise.all(records.map(async (record) => {
    const key = `${record.source}:${record.recordKind}:${record.externalId}`;
    const lookupKey = record.customerSourceId ? `organization:${record.customerSourceId}`
      : record.announcementSourceId ? `announcement:${record.announcementSourceId}` : null;
    if (!eligible.has(key) || !lookupKey) return record;
    let request = cache.get(lookupKey);
    if (!request) {
      request = (record.customerSourceId
        ? loadOrganization(record.customerSourceId, fetchJson)
        : loadAnnouncement(record.announcementSourceId as string, fetchJson))
        .catch(() => ({ bin: null, name: null }));
      cache.set(lookupKey, request);
    }
    const organization = await request;
    if (!organization.bin) return record;
    return { ...record, customerBin: organization.bin,
      customerName: organization.name ?? record.customerName,
      // Из объявления лота берём и карточку заказчика в реестре, и его адрес: у лота их нет.
      customerSourceId: record.customerSourceId ?? organization.id ?? null,
      customerAddress: organization.address ?? record.customerAddress ?? null,
      enrichment: { source: record.customerSourceId ? "epz-organization" : "epz-announcement", confidence: "exact" } };
  }));
}

interface EnrichedOrganization {
  bin: string | null;
  name: string | null;
  id?: string | null;
  address?: string | null;
}

async function loadAnnouncement(id: string, fetchJson: (url: string) => Promise<unknown>): Promise<EnrichedOrganization> {
  const raw = object(await fetchJson(`${EPZ_ANNOUNCEMENTS}/${encodeURIComponent(id)}/`));
  const customer = object(raw.customer);
  const organizer = object(raw.organizer);
  const owner = normalizeBin(customer.iin_bin) ? customer : organizer;
  return { bin: normalizeBin(customer.iin_bin ?? organizer.iin_bin),
    name: nullableText(customer.name ?? customer.name_ru ?? organizer.name ?? organizer.name_ru),
    id: nullableText(owner.id), address: formatAddress(object(owner.address)) };
}

/** `г.Астана, район Есиль, АЛИХАН БОКЕЙХАН, 12` из адреса организации в объявлении EPZ. */
function formatAddress(address: Record<string, unknown>): string | null {
  const kato = object(address.kato);
  const parts = [kato.full_name_ru ?? kato.full_name ?? address.city, address.street, address.house]
    .map(nullableText).filter((part): part is string => part !== null && part.toLowerCase() !== "none");
  return parts.length ? parts.join(", ") : null;
}

async function loadOrganization(id: string, fetchJson: (url: string) => Promise<unknown>): Promise<EnrichedOrganization> {
  const raw = object(await fetchJson(`${EPZ_ORGANIZATIONS}/${encodeURIComponent(id)}/`));
  return { bin: normalizeBin(raw.iin_bin ?? raw.bin), name: nullableText(raw.name_ru ?? raw.name) };
}
async function fetchOrganization(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "scrape2lead/1.7" } });
  if (!response.ok) throw new Error(`Organization enrichment failed: HTTP ${response.status}`);
  return await response.json();
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
function nullableText(value: unknown): string | null { const text = value === null || value === undefined ? "" : String(value).trim(); return text || null; }
function normalizeBin(value: unknown): string | null { const digits = nullableText(value)?.replace(/\D/g, "") ?? ""; return digits.length === 12 ? digits : null; }
