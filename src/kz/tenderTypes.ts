export type LegalStatus =
  | "active"
  | "inactive"
  | "liquidated"
  | "reorganizing"
  | "unknown";

export interface StatGovRecord {
  bin: string;
  name: string;
  registration_date: string | null;
  oked: string | null;
  oked_name: string | null;
  address: string | null;
  director: string | null;
  legal_status: LegalStatus;
  krp_code: string | null;
  krp_name: string | null;
  kfs_code: string | null;
  kfs_name: string | null;
  sector_code: string | null;
  sector_name: string | null;
  updated_at?: string;
  raw_snapshot_path?: string | null;
}

export type TenderSource = "zakup.sk.kz" | "goszakup.gov.kz";

export interface TenderRecord {
  source: TenderSource;
  bin: string;
  tender_number: string;
  tender_name: string;
  customer_name: string | null;
  budget_amount: string | null;
  currency: string;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  method: string | null;
  url: string | null;
  parsed_at: string;
}

export interface CompanyCard extends StatGovRecord {
  tender_count_total: number;
  tender_count_active: number;
  tender_budget_sum: number | null;
  tender_sources: string;
  last_tender_end_date: string | null;
}

export interface EnrichError {
  id: number;
  bin: string;
  stage: "stat_gov" | "zakup" | "goszakup" | string;
  message: string;
  created_at: string;
}

export const ACTIVE_TENDER_STATUSES = new Set([
  "PUBLISHED",
  "ACTIVE",
  "OPEN",
  "PUBLISHED_SUPPLIER_SELECTION"
]);
