import { normalizeCompanyName } from "./normalizeCompanyName.js";
import type { CompanyCard, TenderRecord } from "./tenderTypes.js";
import { hasZakupTitleMatch, tokenizeForZakupMatch } from "./zakupTenderFilter.js";

export type BatchAuditFlag =
  | "cross_bin_duplicate"
  | "high_volume"
  | "short_search_name"
  | "weak_title_match"
  | "no_tenders"
  | "stat_failed";

export interface TenderAuditRow {
  bin: string;
  company_name: string;
  source: string;
  tender_number: string;
  tender_name: string;
  flags: BatchAuditFlag[];
  review_priority: "high" | "medium" | "low";
  screenshot_path: string | null;
}

export interface CompanyAuditRow {
  bin: string;
  company_name: string;
  normalized_search_name: string;
  tender_count: number;
  zakup_count: number;
  flags: BatchAuditFlag[];
  review_priority: "high" | "medium" | "low";
}

export interface BatchAuditSummary {
  companies_total: number;
  companies_with_tenders: number;
  companies_without_tenders: number;
  tenders_total: number;
  zakup_tenders: number;
  goszakup_tenders: number;
  cross_bin_duplicate_tenders: number;
  flagged_tenders: number;
  flagged_companies: number;
  high_priority_reviews: number;
}

export interface BatchAuditReport {
  summary: BatchAuditSummary;
  companies: CompanyAuditRow[];
  tenders: TenderAuditRow[];
  generated_at: string;
}

export interface BatchAuditInput {
  companies: CompanyCard[];
  tenders: TenderRecord[];
  statFailedBins?: string[];
  highVolumeThreshold?: number;
  minSearchNameLength?: number;
}

export function tokenizeForMatch(text: string): string[] {
  return tokenizeForZakupMatch(text);
}

export function hasWeakTitleMatch(companyName: string, tenderName: string): boolean {
  return !hasZakupTitleMatch(companyName, tenderName);
}

export function buildBatchAuditReport(input: BatchAuditInput): BatchAuditReport {
  const highVolumeThreshold = input.highVolumeThreshold ?? 10;
  const minSearchNameLength = input.minSearchNameLength ?? 5;
  const statFailed = new Set(input.statFailedBins ?? []);

  const tendersByKey = new Map<string, TenderRecord[]>();
  for (const tender of input.tenders) {
    const key = `${tender.source}::${tender.tender_number}`;
    const bucket = tendersByKey.get(key) ?? [];
    bucket.push(tender);
    tendersByKey.set(key, bucket);
  }

  const crossBinKeys = new Set(
    [...tendersByKey.entries()].filter(([, rows]) => new Set(rows.map((r) => r.bin)).size > 1).map(([key]) => key)
  );

  const tendersByBin = new Map<string, TenderRecord[]>();
  for (const tender of input.tenders) {
    const bucket = tendersByBin.get(tender.bin) ?? [];
    bucket.push(tender);
    tendersByBin.set(tender.bin, bucket);
  }

  const companyRows: CompanyAuditRow[] = input.companies.map((company) => {
    const normalized = normalizeCompanyName(company.name);
    const binTenders = tendersByBin.get(company.bin) ?? [];
    const zakupCount = binTenders.filter((t) => t.source === "zakup.sk.kz").length;
    const flags: BatchAuditFlag[] = [];

    if (statFailed.has(company.bin)) flags.push("stat_failed");
    if (binTenders.length === 0) flags.push("no_tenders");
    if (normalized.length < minSearchNameLength) flags.push("short_search_name");
    if (zakupCount > highVolumeThreshold) flags.push("high_volume");

    return {
      bin: company.bin,
      company_name: company.name,
      normalized_search_name: normalized,
      tender_count: binTenders.length,
      zakup_count: zakupCount,
      flags,
      review_priority: pickCompanyPriority(flags)
    };
  });

  const tenderRows: TenderAuditRow[] = input.tenders.map((tender) => {
    const company = input.companies.find((c) => c.bin === tender.bin);
    const companyName = company?.name ?? tender.customer_name ?? "";
    const key = `${tender.source}::${tender.tender_number}`;
    const flags: BatchAuditFlag[] = [];

    if (crossBinKeys.has(key)) flags.push("cross_bin_duplicate");
    if (tender.source === "zakup.sk.kz" && companyName && hasWeakTitleMatch(companyName, tender.tender_name)) {
      flags.push("weak_title_match");
    }

    return {
      bin: tender.bin,
      company_name: companyName,
      source: tender.source,
      tender_number: tender.tender_number,
      tender_name: tender.tender_name,
      flags,
      review_priority: pickTenderPriority(flags),
      screenshot_path: tender.source === "zakup.sk.kz" ? `data/debug/zakup-search-${tender.bin}.png` : null
    };
  });

  const flaggedCompanies = companyRows.filter((row) => row.flags.length > 0).length;
  const flaggedTenders = tenderRows.filter((row) => row.flags.length > 0).length;
  const highPriority =
    companyRows.filter((row) => row.review_priority === "high").length +
    tenderRows.filter((row) => row.review_priority === "high").length;

  return {
    summary: {
      companies_total: input.companies.length,
      companies_with_tenders: companyRows.filter((row) => row.tender_count > 0).length,
      companies_without_tenders: companyRows.filter((row) => row.tender_count === 0).length,
      tenders_total: input.tenders.length,
      zakup_tenders: input.tenders.filter((t) => t.source === "zakup.sk.kz").length,
      goszakup_tenders: input.tenders.filter((t) => t.source === "goszakup.gov.kz").length,
      cross_bin_duplicate_tenders: crossBinKeys.size,
      flagged_tenders: flaggedTenders,
      flagged_companies: flaggedCompanies,
      high_priority_reviews: highPriority
    },
    companies: companyRows,
    tenders: tenderRows,
    generated_at: new Date().toISOString()
  };
}

function pickCompanyPriority(flags: BatchAuditFlag[]): "high" | "medium" | "low" {
  if (flags.includes("high_volume") || flags.includes("short_search_name")) return "high";
  if (flags.includes("no_tenders") || flags.includes("stat_failed")) return "medium";
  return "low";
}

function pickTenderPriority(flags: BatchAuditFlag[]): "high" | "medium" | "low" {
  if (flags.includes("cross_bin_duplicate")) return "high";
  if (flags.includes("weak_title_match")) return "medium";
  return "low";
}
