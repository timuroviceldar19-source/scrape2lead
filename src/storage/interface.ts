/**
 * Storage abstraction for runtime/core modules.
 *
 * This interface is the narrow contract that JobManager, ProxyRotator, and
 * CLI wiring depend on. It is intentionally a subset of the concrete SQLite
 * `Storage` class — it only covers the methods actually exercised by the
 * platform core (queue/state lifecycle, raw-snapshot capture, telemetry,
 * and proxy-history recording).
 *
 * The goal is to keep runtime modules source-database-agnostic so a future
 * Postgres implementation can be slotted in without rewiring them. The
 * contract is **async** so the same surface can be served by a synchronous
 * `better-sqlite3` driver (methods are simply declared `async`; they
 * return immediately-resolved Promises) and a real `pg` driver (the
 * `PostgresStorage` implementation in `src/storage/postgres/`).
 *
 * See `docs/storage.md` for the full migration notes (BEGIN IMMEDIATE,
 * `INSERT ... RETURNING id`, JSON/text payload handling, etc).
 *
 * The default in-tree implementation is `Storage` (SQLite via
 * `better-sqlite3`). Legacy helpers on the `Storage` class that are not
 * used by runtime/core (e.g. `saveRaw`, `listRawSnapshots`, cleanup
 * helpers) are deliberately left out of this contract; they remain
 * available on the concrete class for tests and downstream callers.
 */
import type {
  CaptchaEventInput,
  CleanupOlderOptions,
  CleanupRecentOptions,
  CompanyTaskRow,
  CompanyTaskStatus,
  Lead,
  ListRawSnapshotsFilter,
  ParseAttempt,
  ParseJobRow,
  ParseJobStatus,
  ProxyRotationInput,
  RawSnapshotRow,
  SaveRawSnapshotInput,
  SourceId
} from "../types.js";
import type { JobTelemetry } from "../core/telemetry.js";

export interface CreateParseJobInput {
  source: SourceId;
  city: string;
  category: string;
}

export interface EnqueueCompanyTaskInput {
  parseJobId: string;
  source: SourceId;
  externalId: string;
}

export interface ClaimTaskInput {
  parseJobId: string;
  workerId: string;
  leaseMs: number;
}

/**
 * Narrow storage contract used by runtime/core modules.
 *
 * Method groups:
 *  - Parse-job lifecycle: `createParseJob`, `findResumableParseJob`,
 *    `updateParseJobTotalFound`, `setParseJobStatus`, `getParseJob`,
 *    `finalizeParseJob`.
 *  - Company-task queue/state: `enqueueCompanyTask`, `claimNextTask`,
 *    `countOpenTasks`, `markTask*`, `scheduleTaskRetry`,
 *    `recoverExpiredLeases`, `listCompanyTasks`.
 *  - Lead / attempt / event writes: `upsertLead`, `listLeads`,
 *    `saveAttempt`, `countParseAttempts`, `saveCaptchaEvent`,
 *    `saveRawSnapshot`.
 *  - Telemetry: `getJobTelemetry`.
 *  - Proxy lifecycle: `saveProxyRotation`.
 *  - Lifecycle: `close`, `getRawSnapshotDir`.
 *
 * All methods return Promises so the contract is satisfied by both sync
 * (`better-sqlite3`) and async (`pg`) drivers.
 */
export interface IStorage {
  // --- Parse-job lifecycle ---
  createParseJob(input: CreateParseJobInput): Promise<string>;
  findResumableParseJob(input: CreateParseJobInput): Promise<ParseJobRow | null>;
  updateParseJobTotalFound(parseJobId: string, totalFound: number): Promise<void>;
  setParseJobStatus(parseJobId: string, status: ParseJobStatus): Promise<void>;
  getParseJob(parseJobId: string): Promise<ParseJobRow | null>;
  finalizeParseJob(parseJobId: string): Promise<ParseJobStatus>;

  // --- Company-task queue/state ---
  enqueueCompanyTask(input: EnqueueCompanyTaskInput): Promise<number>;
  claimNextTask(input: ClaimTaskInput): Promise<CompanyTaskRow | null>;
  countOpenTasks(parseJobId: string): Promise<number>;
  listCompanyTasks(parseJobId: string): Promise<CompanyTaskRow[]>;
  markTaskSuccess(taskId: number): Promise<boolean>;
  markTaskPartial(taskId: number): Promise<boolean>;
  markTaskFailed(taskId: number, error: string): Promise<boolean>;
  markTaskBlocked(taskId: number, error: string): Promise<boolean>;
  scheduleTaskRetry(taskId: number, error: string, nextRunAt: string): Promise<boolean>;
  recoverExpiredLeases(referenceTime?: Date): Promise<number>;

  // --- Lead / attempt / event writes ---
  upsertLead(lead: Lead): Promise<void>;
  listLeads(): Promise<Lead[]>;
  saveAttempt(attempt: ParseAttempt): Promise<void>;
  countParseAttempts(parseJobId: string): Promise<number>;
  saveCaptchaEvent(input: CaptchaEventInput): Promise<number>;
  saveRawSnapshot(input: SaveRawSnapshotInput): Promise<number>;

  // --- Telemetry ---
  getJobTelemetry(parseJobId: string): Promise<JobTelemetry>;

  // --- Proxy lifecycle ---
  saveProxyRotation(input: ProxyRotationInput): Promise<void>;

  // --- Lifecycle ---
  close(): void;
  getRawSnapshotDir(): string | null;
}

/**
 * Minimal set of input/row types an alternative implementation must
 * support. Re-exported here so consumers can write code that depends
 * on the abstraction without reaching into concrete storage internals.
 */
export type {
  CaptchaEventInput,
  CleanupOlderOptions,
  CleanupRecentOptions,
  CompanyTaskRow,
  CompanyTaskStatus,
  Lead,
  ListRawSnapshotsFilter,
  ParseAttempt,
  ParseJobRow,
  ParseJobStatus,
  ProxyRotationInput,
  RawSnapshotRow,
  SaveRawSnapshotInput
};
