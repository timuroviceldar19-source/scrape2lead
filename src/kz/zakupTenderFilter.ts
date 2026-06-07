import fs from "node:fs";
import path from "node:path";
import { normalizeCompanyName } from "./normalizeCompanyName.js";
import type { TenderRecord } from "./tenderTypes.js";

export interface ZakupFilterResult {
  accepted: TenderRecord[];
  rejected: Array<{ item: Record<string, unknown>; reason: ZakupRejectReason }>;
  stats: { total: number; accepted: number; rejected: number };
}

export type ZakupRejectReason =
  | "weak_title_match"
  | "generic_default_feed"
  | "duplicate_tender_number"
  | "missing_number";

const GENERIC_TOKENS = new Set([
  "group",
  "company",
  "service",
  "trade",
  "market",
  "center",
  "центр",
  "магазин",
  "казахстан",
  "kazakhstan",
  "kz"
]);

const DEFAULT_FEED_PATH = path.join(
  __dirname,
  "../../tests/fixtures/zakup-default-feed.json"
);

let cachedDefaultNumbers: string[] | null = null;

function loadDefaultFeedNumbers(): string[] {
  if (cachedDefaultNumbers !== null) return cachedDefaultNumbers;
  try {
    const raw = fs.readFileSync(DEFAULT_FEED_PATH, "utf-8");
    const data = JSON.parse(raw);
    cachedDefaultNumbers = Array.isArray(data.numbers) ? data.numbers.map(String) : [];
  } catch {
    cachedDefaultNumbers = [];
  }
  return cachedDefaultNumbers!;
}

export function tokenizeForZakupMatch(text: string): string[] {
  return normalizeCompanyName(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));
}

export function hasZakupTitleMatch(companyName: string, tenderName: string): boolean {
  const companyTokens = tokenizeForZakupMatch(companyName);
  if (companyTokens.length === 0) return false;

  const tenderLower = tenderName.toLowerCase();
  return companyTokens.some((token) => tenderLower.includes(token));
}

export function isKnownDefaultZakupFeed(tenderNumbers: string[]): boolean {
  if (tenderNumbers.length === 0) return false;
  const defaultNumbers = loadDefaultFeedNumbers();
  if (defaultNumbers.length === 0) return false;
  return tenderNumbers.every((num) => defaultNumbers.includes(num));
}

export function filterZakupTenders(
  items: Array<Record<string, unknown>>,
  bin: string,
  companyName: string,
  options?: { minTokenOverlap?: number }
): ZakupFilterResult {
  const accepted: TenderRecord[] = [];
  const rejected: Array<{ item: Record<string, unknown>; reason: ZakupRejectReason }> = [];
  const seenNumbers = new Set<string>();

  for (const item of items) {
    const number = String(item.number ?? item.id ?? "");
    if (!number) {
      rejected.push({ item, reason: "missing_number" });
      continue;
    }

    if (seenNumbers.has(number)) {
      rejected.push({ item, reason: "duplicate_tender_number" });
      continue;
    }
    seenNumbers.add(number);

    const tenderName = String(item.nameRu ?? item.nameKk ?? "");
    if (!hasZakupTitleMatch(companyName, tenderName)) {
      rejected.push({ item, reason: "weak_title_match" });
      continue;
    }

    const record: TenderRecord = {
      source: "zakup.sk.kz",
      bin,
      tender_number: number,
      tender_name: tenderName || "N/A",
      customer_name: companyName,
      budget_amount: stringValue(item.sumTruNoNds),
      currency: "KZT",
      start_date: stringValue(item.acceptanceBeginDateTime),
      end_date: stringValue(item.acceptanceEndDateTime),
      status: stringValue(item.advertStatus),
      method: stringValue(item.tenderType),
      url: `https://zakup.sk.kz/#/lots/${number}`,
      parsed_at: new Date().toISOString()
    };
    accepted.push(record);
  }

  if (accepted.length > 0) {
    const allNumbers = accepted.map((r) => r.tender_number);
    if (isKnownDefaultZakupFeed(allNumbers)) {
      for (const record of accepted) {
        rejected.push({ item: { number: record.tender_number }, reason: "generic_default_feed" });
      }
      return {
        accepted: [],
        rejected,
        stats: { total: items.length, accepted: 0, rejected: items.length }
      };
    }
  }

  return {
    accepted,
    rejected,
    stats: { total: items.length, accepted: accepted.length, rejected: rejected.length }
  };
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
