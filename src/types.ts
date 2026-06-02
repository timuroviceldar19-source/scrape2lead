export type SourceId = "2gis" | string;

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

export interface RawCardDetail extends RawCompanyCard {
  email?: string | null;
  website?: string | null;
  phones?: string[];
  socialLinks?: string[];
  messengerLinks?: string[];
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
}

export interface RuntimeConfig extends SearchQuery {
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
