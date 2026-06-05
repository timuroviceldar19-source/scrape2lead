export type SourceId = "2gis" | "kaspi" | string;

export interface SearchQuery {
  source: SourceId;
  geo: string;
  category: string;
  limit: number;
}

export interface Lead {
  source: SourceId;
  external_id: string;
  company_name: string;
  category: string;
  city: string;
  address: string;
  phones: string[];
  email: string | null;
  website: string | null;
  social_links: string[];
  messenger_links: string[];
  parsed_at: string;
  incomplete: boolean;
  
  // Kaspi-specific enrichment fields
  rating?: number;
  review_count?: number;
  product_count?: number;
  shop_categories?: string[];

  // CRM-ready enrichment fields
  lead_id?: string;
  source_search_city?: string;
  merchant_city_guess?: string;
  city_status?: "ok" | "mismatch" | "needs_check";
  address_raw?: string;
  address_clean?: string;
  address_status?: "valid" | "invalid" | "empty";
  phone_raw?: string;
  phone_normalized?: string;
  phone_status?: "valid" | "invalid" | "empty";
  email_raw?: string;
  email_status?: "valid" | "invalid" | "empty";
  kaspi_profile_url?: string;
  real_website?: string;
  website_status?: "valid" | "invalid" | "empty";
  messenger_flags?: string;
  lead_score?: number;
  priority?: "A" | "B" | "C" | "D";
  contactability?: "Phone ready" | "No usable contact";
  crm_status?: "Ready to call" | "Needs enrichment" | "Ready to contact" | "Needs manual review" | "Not enough data";
  next_action?: string;
  parser_note?: string;

  // Enrichment tracking fields
  enrichment_source?: "2gis" | "google" | "none";
  enrichment_url?: string;
  confidence_score?: number;
  enrichment_status?: "pending" | "enriched" | "manual_review" | "not_found" | "failed";
  enrichment_attempted_at?: string;
  enrichment_error?: string;
}

export interface RawCompanyCard {
  source: SourceId;
  externalId: string;
  name: string;
  category?: string;
  city?: string;
  address?: string;
  url?: string;
  payload: unknown;
}

export type RawDetailStage = "fixture" | "dom" | "captured_fallback";

export type RawDetailDegradationReason =
  | "timeout"
  | "tunnel_failure"
  | "proxy_failure"
  | "network_failure"
  | "browser_error"
  | "unknown";

export interface RawDetailDiagnostics {
  stage: RawDetailStage;
  degraded: boolean;
  fallbackUsed: boolean;
  sparseFallback: boolean;
  attempts: number;
  reason?: RawDetailDegradationReason;
  message?: string;
}

export interface RawCardDetail extends RawCompanyCard {
  email?: string | null;
  website?: string | null;
  phones?: string[];
  socialLinks?: string[];
  messengerLinks?: string[];
  detailDiagnostics?: RawDetailDiagnostics;
}

export interface RawContacts {
  externalId: string;
  phones: string[];
  email?: string | null;
  website?: string | null;
  socialLinks: string[];
  messengerLinks: string[];
  payload: unknown;
}

export interface SourceCapabilities {
  needsBrowser: boolean;
  needsProxy: boolean;
  handlesCaptcha: boolean;
  supportsApiCapture: boolean;
  supportsDomFallback: boolean;
}

export interface ISourceAdapter {
  source: SourceId;
  capabilities(): SourceCapabilities;
  searchCompanies(query: SearchQuery): Promise<RawCompanyCard[]>;
  listCards(query: SearchQuery): Promise<RawCompanyCard[]>;
  getCardDetail(card: RawCompanyCard): Promise<RawCardDetail>;
  getContacts(detail: RawCardDetail): Promise<RawContacts>;
  normalize(detail: RawCardDetail, contacts: RawContacts): Lead;
  close(): Promise<void>;
}

/**
 * Optional rate-limit policy. Every field is opt-in: when the whole block is
 * absent (or individual fields are unset) the JobManager behaves exactly as
 * before — only the existing `delayRangeMs` jitter is enforced.
 */
export interface RateLimitPolicy {
  /** Hard cap on completed card attempts per JobManager.run() invocation. */
  maxCardsPerSession?: number;
  /** Sliding 60s cap on card-start events. */
  maxCardsPerMinute?: number;
  /** Wall-clock cap (ms) measured from JobManager.run() start. */
  maxSessionDurationMs?: number;
  /** When the current proxy's `cardsOnIp` reaches this, rotate before the next card. */
  maxCardsPerProxy?: number;
  /** Sliding 60s cap on requests, bucketed by current proxy id (`proxyChannel ?? proxy ?? "direct"`). */
  maxRequestsPerMinutePerProxy?: number;
}

export interface RuntimeConfig extends Omit<SearchQuery, "category"> {
  /**
   * Single target category. Kept for backward compatibility with configs that
   * only need one niche. Mutually exclusive with {@link categories} — when both
   * are set, {@link categories} wins.
   */
  category?: string;
  /**
   * Multiple target categories. When provided, JobManager runs one parse job
   * per category (resumable per-niche) and the adapter is invoked once with
   * each category. Last matching category wins on the lead's `category`
   * column — use `shop_categories` JSON for the full match set.
   */
  categories?: string[];
  databasePath: string;
  exportDir: string;
  delayRangeMs: [number, number];
  rotateEveryN: number;
  maxRetries: number;
  concurrency: number;
  headless: boolean;
  proxyApiUrl?: string;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
  rawSnapshotDir: string;
  fixturePath?: string;
  /**
   * Rate-limit policy. Each individual field is optional and, when unset,
   * preserves the pre-policy behaviour (no additional gating, only the
   * `delayRangeMs` jitter from {@link RateLimiter.wait}).
   */
  rateLimit?: RateLimitPolicy;
  /**
   * Optional bounded post-detail crawl of company websites. Runs only for
   * leads that already have a website but no email.
   */
  websiteCrawl?: WebsiteCrawlPolicy;
  /**
   * Optional bounded search-engine discovery of official company websites.
   * Runs only for leads that still have neither website nor email.
   */
  websiteDiscovery?: WebsiteDiscoveryPolicy;
  /**
   * Optional bounded search-engine discovery of directory pages (zoon, yell,
   * etc.) to extract contacts. Runs only for leads without email.
   */
  directoryContactDiscovery?: DirectoryContactDiscoveryPolicy;
  /**
   * Storage backend selector. Defaults to `"sqlite"` (preserves the
   * pre-Postgres behaviour). `"postgres"` switches the CLI to
   * `PostgresStorage`, which requires `postgresConnectionString`.
   */
  storageBackend?: "sqlite" | "postgres";
  /**
   * Postgres connection string. Ignored unless `storageBackend` is
   * `"postgres"`. Kept separate from `databasePath` so the SQLite path is
   * never silently mis-used.
   */
  postgresConnectionString?: string;
  /**
   * Base URL for 2GIS. Defaults to "https://2gis.ru".
   * Use "https://2gis.kz" for Kazakhstan targets.
   */
  twoGisBaseUrl?: string;
  /**
   * Base URL for Kaspi. Defaults to "https://kaspi.kz".
   */
  kaspiBaseUrl?: string;
  /**
   * Optional lead quality filters. Leads not meeting these thresholds will be
   * excluded from the final export (but may still be logged in the database).
   */
  minRating?: number;
  minReviewCount?: number;
}

export interface WebsiteCrawlPolicy {
  enabled?: boolean;
  maxPages?: number;
  timeoutMs?: number;
}

export interface WebsiteDiscoveryPolicy {
  enabled?: boolean;
  maxSearches?: number;
  maxCandidates?: number;
  timeoutMs?: number;
}

export interface DirectoryContactDiscoveryPolicy {
  enabled?: boolean;
  maxSearches?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  allowlist?: string[];
}

export interface ParseAttempt {
  /** Legacy parse-session identifier. Optional — `companyTaskId` is the canonical FK. */
  jobId?: string | null;
  source: SourceId;
  externalId?: string;
  /** Mapped onto the `result` column. */
  status: "success" | "partial" | "failed" | "blocked" | "error" | "captcha" | "selector_error";
  message?: string;
  companyTaskId?: number;
  attemptNo?: number;
  errorType?: string;
  proxyId?: string;
  durationMs?: number;
}

export type SnapshotKind = "json" | "html" | string;
export type SnapshotPurpose = "recent" | "error" | "captcha" | "fixture" | string;

export interface RawSnapshotRow {
  snapshot_id: number;
  company_task_id: number | null;
  source: SourceId;
  external_id: string | null;
  kind: SnapshotKind;
  purpose: SnapshotPurpose;
  payload: string | null;
  payload_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveRawSnapshotInput {
  companyTaskId?: number | null;
  source: SourceId;
  externalId?: string | null;
  kind: SnapshotKind;
  purpose: SnapshotPurpose;
  /** Inline body. Serialised to JSON if not a string. */
  payload?: unknown;
  /** Path to on-disk payload when the body is too large for the row. */
  payloadPath?: string | null;
}

export interface ListRawSnapshotsFilter {
  purpose?: SnapshotPurpose;
  source?: SourceId;
  externalId?: string;
  companyTaskId?: number | null;
}

export interface CleanupRecentOptions {
  maxEntries: number;
}

export interface CleanupOlderOptions {
  olderThanMs: number;
  purpose?: SnapshotPurpose;
  now?: Date;
}

export interface CaptchaEventInput {
  source: SourceId;
  action: string;
  url?: string | null;
  screenshotPath?: string | null;
  companyTaskId?: number | null;
  proxyId?: string | null;
  snapshotId?: number | null;
}

export interface ProxyRotationInput {
  reason: string;
  proxy?: string | null;
  proxyChannel?: string | null;
  ip?: string | null;
  cardsOnIp?: number | null;
  rotatedAt?: string;
}

export type CompanyTaskStatus =
  | "pending"
  | "processing"
  | "success"
  | "partial"
  | "failed"
  | "blocked"
  | "retry_scheduled";

export type ParseJobStatus = "pending" | "running" | "completed" | "failed";

export interface CompanyTaskRow {
  id: number;
  parse_job_id: string;
  source: SourceId;
  external_id: string;
  status: CompanyTaskStatus;
  attempts: number;
  next_run_at: string | null;
  worker_id: string | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParseJobRow {
  id: string;
  source: SourceId;
  city: string;
  category: string;
  status: ParseJobStatus;
  total_found: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
