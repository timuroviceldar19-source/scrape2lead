import type { Lead, RawCardDetail, RawCompanyCard, RawContacts } from "../../types.js";
import { finalizeLead } from "../../normalizer/normalize.js";

const ID_KEYS = ["id", "firm_id", "branch_id", "external_id"];
const NAME_KEYS = ["name", "company_name", "title", "caption"];

/**
 * 2GIS firm / branch ids are long numeric strings (e.g. "70000001000000123").
 * Style layers, map records and UI assets carry slug / string ids, so an id
 * that isn't a long run of digits is never a firm.
 */
const FIRM_ID_RE = /^\d{6,}$/;

/**
 * Names that belong to map style layers, global map records and 2GIS business
 * promos — never to a real firm card. Matched case-insensitively against the
 * record name. Examples observed in captured payloads:
 *   "[light] Фон со статичной текстурой" (map style layer)
 *   "Глобальная карта"                   (global map record)
 *   "Данные и технологии 2ГИС для бизнеса" (2GIS business promo)
 */
const JUNK_NAME_PATTERNS: RegExp[] = [
  /^\s*\[[^\]]+\]/, // bracketed style / layer label, e.g. "[light] …"
  /статичн\w*\s+текстур/i,
  /\bтекстур[аыуео]?\b/i,
  /глобальн\w*\s+карт/i,
  /данн\w*\s+и\s+технолог\w*.*бизнес/i,
  /2\s?гис.*для\s+бизнеса/i
];

/**
 * 2GIS catalog records expose a `type`. Only firm-bearing types are leads;
 * everything else (streets, buildings, admin divisions, ad blocks, map styles…)
 * is rejected. A missing `type` is left undecided — the id / context heuristics
 * still apply.
 */
const FIRM_TYPES = new Set(["branch", "filial", "firm", "org", "company", "business"]);

/**
 * Keys whose presence signals an actual firm/branch record (address, rubric,
 * contact or geo metadata). At least one must be present and truthy.
 */
const FIRM_CONTEXT_KEYS = [
  "address_name",
  "address",
  "full_address",
  "building_name",
  "purpose_name",
  "rubric",
  "rubrics",
  "org",
  "contact",
  "contact_groups",
  "contacts",
  "city_name",
  "schedule",
  "reviews",
  "point"
];

function typeIsFirm(item: Record<string, unknown>): boolean | undefined {
  const type = getString(item, ["type", "subtype"]);
  if (!type) return undefined;
  return FIRM_TYPES.has(type.toLowerCase());
}

function hasFirmContext(item: Record<string, unknown>): boolean {
  return FIRM_CONTEXT_KEYS.some((key) => {
    const value = item[key];
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (isRecord(value)) return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

/**
 * True only for records that look like a real 2GIS firm/branch result card.
 * Rejects UI assets, map style layers / static textures, global map records
 * and 2GIS business promo entries. Exported for direct unit testing.
 */
export function looksLikeFirm(item: Record<string, unknown>): boolean {
  const id = getString(item, ID_KEYS);
  const name = getString(item, NAME_KEYS);
  if (!id || !name) return false;
  if (!FIRM_ID_RE.test(id)) return false;
  if (JUNK_NAME_PATTERNS.some((re) => re.test(name))) return false;
  if (typeIsFirm(item) === false) return false;
  return hasFirmContext(item);
}

/**
 * Count firm records reachable in a captured payload. Used by the API-capture
 * gate to decide whether a response carries firm/search data worth keeping.
 */
export function countFirmRecords(payload: unknown): number {
  return flattenRecords(payload).length;
}

export function mapRawCard(item: Record<string, unknown>, fallbackCategory: string, fallbackCity: string): RawCompanyCard | null {
  if (!looksLikeFirm(item)) return null;
  const id = getString(item, ID_KEYS) as string;
  const name = getString(item, NAME_KEYS) as string;

  return {
    source: "2gis",
    externalId: id,
    name,
    category: extractCategory(item) ?? fallbackCategory,
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
  const own = looksLikeFirm(value) ? [value] : [];
  return [
    ...own,
    ...Object.values(value).flatMap((child) => flattenRecords(child))
  ];
}

function extractCategory(item: Record<string, unknown>): string | null {
  const direct = getString(item, ["rubric", "category", "primary_rubric"]);
  if (direct) return direct;
  // 2GIS firm records expose rubrics as an array of { name }.
  for (const key of ["rubrics", "categories"]) {
    const value = item[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const name = isRecord(entry) ? getString(entry, ["name", "title"]) : typeof entry === "string" ? entry : null;
        if (name) return name;
      }
    }
  }
  return null;
}

function extractAddress(item: Record<string, unknown>): string {
  const direct = getString(item, ["address", "address_name", "full_address"]);
  if (direct) return direct;
  const address = asRecord(item.address);
  return getString(address, ["name", "comment", "full_name"]) ?? "";
}

function extractWebsite(item: Record<string, unknown>): string | null {
  const typed = typedContacts(item, "website");
  if (typed[0]) return typed[0];
  const direct = getString(item, ["website", "site", "url"]);
  if (direct) return direct;
  const nested = collectValuesByKey(item, /website|site|url/i).find((value) => value.includes("."));
  if (nested) return nested;
  const links = extractLinks(item, ["links", "contact_links"]);
  return links.find((link) => /^https?:\/\//i.test(link) || /\./.test(link)) ?? null;
}

function extractEmail(item: Record<string, unknown>): string | null {
  const typed = typedContacts(item, "email").find((value) => value.includes("@"));
  if (typed) return typed;
  return collectValuesByKey(item, /email/i).find((value) => value.includes("@")) ?? null;
}

function extractPhones(item: Record<string, unknown>): string[] {
  const typed = typedContacts(item, "phone");
  const values = collectValuesByKey(item, /phone|phones|number/i);
  return [...typed, ...values].filter((value) => /\d/.test(value));
}

/**
 * Extract contact values from 2GIS' typed contact shape
 * (`contact_groups[].contacts[]` with `{ type, value, url }`). Returns the
 * `value` (or `url` for websites) of every entry whose `type` matches.
 */
function typedContacts(item: Record<string, unknown>, type: "phone" | "email" | "website"): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.type === "string" && value.type.toLowerCase() === type) {
      const picked = type === "website" ? value.url ?? value.value : value.value ?? value.url;
      if (typeof picked === "string" && picked.trim()) out.push(picked.trim());
    }
    Object.values(value).forEach(walk);
  };
  walk(item);
  return out;
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
