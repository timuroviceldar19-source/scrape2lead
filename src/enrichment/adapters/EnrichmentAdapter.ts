import type { Lead } from "../../types.js";

export type EnrichmentStatus = "found" | "not_found" | "unsupported_city" | "failed" | "captcha_or_blocked";

export interface EnrichmentRawResult {
  status: EnrichmentStatus;
  source: "2gis" | "google" | "none";
  found_name?: string;
  phone_raw?: string;
  address_raw?: string;
  website_raw?: string;
  social_links_raw?: string[];
  enrichment_url?: string;
  raw_match_metadata?: unknown;
  error_message?: string;
}

export interface IEnrichmentAdapter {
  enrich(lead: Lead): Promise<EnrichmentRawResult>;
  close(): Promise<void>;
}
