import type { Lead, RawCardDetail, RawCompanyCard, RawContacts } from "../../types.js";
import { finalizeLead } from "../../normalizer/normalize.js";

export function mapRawCard(item: Record<string, unknown>, fallbackCategory: string, fallbackCity: string): RawCompanyCard | null {
  const id = getString(item, ["id", "firm_id", "branch_id", "external_id"]);
  const name = getString(item, ["name", "company_name", "title"]);
  if (!id || !name) return null;

  return {
    source: "2gis",
    externalId: id,
    name,
    category: getString(item, ["rubric", "category"]) ?? fallbackCategory,
    city: getString(item, ["city_name", "city"]) ?? fallbackCity,
    address: extractAddress(item),
    url: getString(item, ["url", "link"]) ?? undefined,
    payload: item
  };
}

export function mapDetail(card: RawCompanyCard, item: Record<string, unknown>): RawCardDetail {
  return {
    ...card,
    email: extractEmail(item),
    website: extractWebsite(item),
    phones: extractPhones(item),
    socialLinks: extractLinks(item, ["social", "socials", "social_links"]),
    messengerLinks: extractLinks(item, ["messengers", "messenger_links"]),
    payload: item
  };
}

export function mapContacts(detail: RawCardDetail, payload: unknown): RawContacts {
  const item = asRecord(payload);
  return {
    externalId: detail.externalId,
    phones: [...(detail.phones ?? []), ...extractPhones(item)],
    email: detail.email ?? extractEmail(item),
    website: detail.website ?? extractWebsite(item),
    socialLinks: [...(detail.socialLinks ?? []), ...extractLinks(item, ["social", "socials", "social_links"])],
    messengerLinks: [...(detail.messengerLinks ?? []), ...extractLinks(item, ["messengers", "messenger_links"])],
    payload
  };
}

export function toLead(detail: RawCardDetail, contacts: RawContacts): Lead {
  return finalizeLead({
    source: "2gis",
    external_id: detail.externalId,
    company_name: detail.name,
    category: detail.category ?? "",
    city: detail.city ?? "",
    address: detail.address ?? "",
    phones: contacts.phones,
    email: contacts.email ?? null,
    website: contacts.website ?? null,
    social_links: contacts.socialLinks,
    messenger_links: contacts.messengerLinks,
    parsed_at: new Date().toISOString(),
    incomplete: false
  });
}

export function extractCardsFromPayload(payload: unknown, category: string, city: string): RawCompanyCard[] {
  const records = flattenRecords(payload);
  const cards = records
    .map((record) => mapRawCard(record, category, city))
    .filter((card): card is RawCompanyCard => Boolean(card));
  return dedupeCards(cards);
}

export function findDetailPayload(payloads: unknown[], externalId: string): Record<string, unknown> | null {
  for (const record of payloads.flatMap(flattenRecords)) {
    const id = getString(record, ["id", "firm_id", "branch_id", "external_id"]);
    if (id === externalId) return record;
  }
  return null;
}

function flattenRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(flattenRecords);
  if (!isRecord(value)) return [];
  const own = looksLikeCompany(value) ? [value] : [];
  return [
    ...own,
    ...Object.values(value).flatMap((child) => flattenRecords(child))
  ];
}

function looksLikeCompany(item: Record<string, unknown>): boolean {
  return Boolean(getString(item, ["id", "firm_id", "branch_id", "external_id"]) && getString(item, ["name", "company_name", "title"]));
}

function extractAddress(item: Record<string, unknown>): string {
  const direct = getString(item, ["address", "address_name", "full_address"]);
  if (direct) return direct;
  const address = asRecord(item.address);
  return getString(address, ["name", "comment", "full_name"]) ?? "";
}

function extractWebsite(item: Record<string, unknown>): string | null {
  const direct = getString(item, ["website", "site", "url"]);
  if (direct) return direct;
  const nested = collectValuesByKey(item, /website|site|url/i).find((value) => value.includes("."));
  if (nested) return nested;
  const links = extractLinks(item, ["links", "contact_links"]);
  return links.find((link) => /^https?:\/\//i.test(link) || /\./.test(link)) ?? null;
}

function extractEmail(item: Record<string, unknown>): string | null {
  return collectValuesByKey(item, /email/i).find((value) => value.includes("@")) ?? null;
}

function extractPhones(item: Record<string, unknown>): string[] {
  const values = collectValuesByKey(item, /phone|phones|number/i);
  return values.filter((value) => /\d/.test(value));
}

function extractLinks(item: Record<string, unknown>, keys: string[]): string[] {
  return keys.flatMap((key) => collectValuesByKey(item, new RegExp(`^${key}$`, "i"))).filter((value) => value.includes(".") || value.includes("://"));
}

function collectValuesByKey(value: unknown, keyPattern: RegExp): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectValuesByKey(item, keyPattern));
  if (!isRecord(value)) return [];
  const own = Object.entries(value).flatMap(([key, child]) => {
    if (keyPattern.test(key)) return collectStrings(child);
    return [];
  });
  return [...own, ...Object.values(value).flatMap((child) => collectValuesByKey(child, keyPattern))];
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

function getString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dedupeCards(cards: RawCompanyCard[]): RawCompanyCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (seen.has(card.externalId)) return false;
    seen.add(card.externalId);
    return true;
  });
}
