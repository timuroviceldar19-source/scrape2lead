/**
 * Postgres-backed implementation of {@link IStorage}.
 *
 * Wired against the `pg` driver's connection pool. The pool is created in
 * the constructor and released by `close()`. Every method is async because
 * the `pg` driver is async; the public `IStorage` contract has only void
 * return values for writes, so callers see no surface difference from the
 * SQLite `Storage` class. `enqueueCompanyTask`, `saveCaptchaEvent`, and
 * `saveRawSnapshot` use `INSERT ... RETURNING id` (the Postgres replacement
 * for SQLite's `lastInsertRowid`).
 *
 * The queue / state lifecycle matches the SQLite default byte-for-byte
 * where it matters: `claimNextTask` runs inside a transaction that combines
 * a `SELECT ... FOR UPDATE SKIP LOCKED` and a guarded `UPDATE`, so two
 * concurrent claimants on separate connections can never double-flip the
 * same row. `enqueueCompanyTask` uses `ON CONFLICT DO NOTHING RETURNING id`
 * and falls back to a plain `SELECT id` so duplicate
 * `(source, external_id, parse_job_id)` calls return the existing task id
 * — the same idempotency contract the SQLite default documents.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type {
  CaptchaEventInput,
  CompanyTaskRow,
  CompanyTaskStatus,
  Lead,
  ParseAttempt,
  ParseJobRow,
  ParseJobStatus,
  ProxyRotationInput,
  SaveRawSnapshotInput
} from "../../types.js";
import type { JobTelemetry } from "../../core/telemetry.js";
import type {
  ClaimTaskInput,
  CreateParseJobInput,
  EnqueueCompanyTaskInput,
  IStorage
} from "../interface.js";
import { dropAllTables, runPostgresMigrations } from "./migrations.js";
import { POSTGRES_SQL } from "./sql.js";

export interface PostgresStorageOptions {
  /** Pool config to pass through to `pg.Pool`. Use this for ssl, max, etc. */
  pool?: PoolConfig;
  /** Optional raw-snapshot directory. When set, `saveRawSnapshot` mirrors the
   *  SQLite behaviour: the inline payload is also written to a file under
   *  this directory and the absolute path is stored in `payload_path`. */
  rawSnapshotDir?: string;
}

export class PostgresStorage implements IStorage {
  private readonly pool: Pool;
  private readonly rawSnapshotDir: string | null;
  private closed = false;
  /** Memoised migration guard. Holds the in-flight/settled `ensureMigrated`
   *  promise so concurrent first queries trigger the migration exactly once.
   *  Reset to `null` on failure so a later call can retry. */
  private migrationPromise: Promise<void> | null = null;

  constructor(connectionString: string, options: PostgresStorageOptions = {}) {
    this.pool = new Pool({ connectionString, ...(options.pool ?? {}) });
    this.rawSnapshotDir = options.rawSnapshotDir
      ? path.resolve(options.rawSnapshotDir)
      : options.rawSnapshotDir === ""
        ? null
        : (options.rawSnapshotDir ?? null);
    // The optional `rawSnapshotDir` from the public surface is always a
    // string or undefined. Normalise to either a resolved string or null
    // (the latter means "inline-only mode" — matches SQLite semantics).
    void this.rawSnapshotDir;
  }

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  /**
   * Apply pending schema migrations. Called automatically on first use so
   * the CLI can `new PostgresStorage(...)` followed by `getParseJob(...)`
   * without an explicit setup step. Tests can also call this directly when
   * they need to assert that schema is present.
   */
  async ensureMigrated(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await runPostgresMigrations(client);
    } finally {
      client.release();
    }
  }

  /**
   * Idempotent migration guard run before the first real query on any path.
   * The CLI awaits {@link ensureMigrated} explicitly before constructing the
   * JobManager, but this lazy guard makes the storage correct regardless of
   * caller wiring: every `withClient`/`withTransaction` awaits it first, so a
   * runtime query can never reach an un-migrated schema. The result is
   * memoised so migrations run at most once per instance.
   */
  private async ensureMigratedOnce(): Promise<void> {
    if (!this.migrationPromise) {
      this.migrationPromise = this.ensureMigrated().catch((error) => {
        this.migrationPromise = null;
        throw error;
      });
    }
    return this.migrationPromise;
  }

  /** Drop every application-owned table. Live-integration test helper. */
  async dropAllTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await dropAllTables(client);
    } finally {
      client.release();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // `Pool.end()` is async; we don't await because `IStorage.close()` is
    // synchronous. The detached promise drains outstanding queries and
    // releases the underlying sockets before the process exits. Errors
    // are swallowed because close() must not throw.
    this.pool.end().catch(() => undefined);
  }

  /**
   * Async counterpart of {@link close}. Awaits the pool drain so callers
   * who can tolerate awaiting (e.g. tests) get a clean shutdown. Optional
   * — the IStorage contract is satisfied by the sync {@link close} above.
   */
  async closeAsync(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end().catch(() => undefined);
  }

  getRawSnapshotDir(): string | null {
    return this.rawSnapshotDir;
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureMigratedOnce();
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    // `withClient` already awaits the migration guard before handing us a
    // client, so the transaction body always runs against a migrated schema.
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  // ----------------------------------------------------------------
  // Parse-job lifecycle
  // ----------------------------------------------------------------

  async createParseJob(input: CreateParseJobInput): Promise<string> {
    // SQLite default returns the same `${source}-${ms}-${rand}` id so the
    // CLI's jobId output and the on-disk `exports/` filenames stay identical.
    const id = `${input.source}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await this.withClient((client) =>
      client.query(POSTGRES_SQL.CREATE_PARSE_JOB, [
        id,
        input.source,
        input.city,
        input.category,
        now,
        now
      ])
    );
    return id;
  }

  async updateParseJobTotalFound(parseJobId: string, totalFound: number): Promise<void> {
    await this.withClient((client) =>
      client.query(POSTGRES_SQL.UPDATE_PARSE_JOB_TOTAL_FOUND, [
        totalFound,
        new Date().toISOString(),
        parseJobId
      ])
    );
  }

  async setParseJobStatus(parseJobId: string, status: ParseJobStatus): Promise<void> {
    const now = new Date().toISOString();
    const finishedAt = status === "completed" || status === "failed" ? now : null;
    await this.withClient((client) =>
      client.query(POSTGRES_SQL.SET_PARSE_JOB_STATUS, [status, now, finishedAt, parseJobId])
    );
  }

  async getParseJob(parseJobId: string): Promise<ParseJobRow | null> {
    return this.withClient(async (client) => {
      const result = await client.query<ParseJobRow>(POSTGRES_SQL.GET_PARSE_JOB, [parseJobId]);
      return result.rows[0] ? this.hydrateParseJob(result.rows[0]) : null;
    });
  }

  async findResumableParseJob(input: CreateParseJobInput): Promise<ParseJobRow | null> {
    return this.withClient(async (client) => {
      const result = await client.query<ParseJobRow>(POSTGRES_SQL.FIND_RESUMABLE_PARSE_JOB, [
        input.source,
        input.city,
        input.category
      ]);
      return result.rows[0] ? this.hydrateParseJob(result.rows[0]) : null;
    });
  }

  async finalizeParseJob(parseJobId: string): Promise<ParseJobStatus> {
    const counts = await this.withClient(async (client) => {
      const result = await client.query<{
        done: number | null;
        failed: number | null;
        open: number | null;
      }>(
        `SELECT
           SUM(CASE WHEN status IN ('success','partial') THEN 1 ELSE 0 END)::int AS done,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failed,
           SUM(CASE WHEN status NOT IN ('success','partial','failed') THEN 1 ELSE 0 END)::int AS open
         FROM company_tasks
         WHERE parse_job_id = $1`,
        [parseJobId]
      );
      return result.rows[0] ?? { done: 0, failed: 0, open: 0 };
    });
    const done = counts.done ?? 0;
    const failed = counts.failed ?? 0;
    const open = counts.open ?? 0;
    let status: ParseJobStatus;
    if (open > 0) status = "running";
    else if (done > 0) status = "completed";
    else if (failed > 0) status = "failed";
    else status = "completed";
    await this.setParseJobStatus(parseJobId, status);
    return status;
  }

  // ----------------------------------------------------------------
  // Company-task queue / state
  // ----------------------------------------------------------------

  async enqueueCompanyTask(input: EnqueueCompanyTaskInput): Promise<number> {
    const now = new Date().toISOString();
    return this.withClient(async (client) => {
      const inserted = await client.query<{ id: string | number }>(
        POSTGRES_SQL.ENQUEUE_COMPANY_TASK,
        [input.parseJobId, input.source, input.externalId, now, now]
      );
      if (inserted.rows.length > 0) {
        return Number(inserted.rows[0].id);
      }
      const existing = await client.query<{ id: string | number }>(
        POSTGRES_SQL.ENQUEUE_COMPANY_TASK_FALLBACK_SELECT,
        [input.source, input.externalId, input.parseJobId]
      );
      if (existing.rows.length === 0) {
        // Should be unreachable: the unique constraint guarantees either
        // INSERT returned a row or the row was already there.
        throw new Error("enqueueCompanyTask: missing row after conflict");
      }
      return Number(existing.rows[0].id);
    });
  }

  async claimNextTask(input: ClaimTaskInput): Promise<CompanyTaskRow | null> {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + input.leaseMs).toISOString();
    return this.withTransaction(async (client) => {
      const selected = await client.query<CompanyTaskRow>(POSTGRES_SQL.CLAIM_NEXT_TASK_SELECT, [
        input.parseJobId,
        now
      ]);
      const row = selected.rows[0];
      if (!row) return null;
      const updated = await client.query(POSTGRES_SQL.CLAIM_NEXT_TASK_UPDATE, [
        input.workerId,
        leaseUntil,
        now,
        Number(row.id)
      ]);
      if (updated.rowCount === 0) return null;
      return {
        ...row,
        status: "processing",
        worker_id: input.workerId,
        lease_until: leaseUntil,
        attempts: row.attempts + 1,
        updated_at: now
      };
    });
  }

  async countOpenTasks(parseJobId: string): Promise<number> {
    return this.withClient(async (client) => {
      const result = await client.query<{ n: number }>(POSTGRES_SQL.COUNT_OPEN_TASKS, [parseJobId]);
      return result.rows[0]?.n ?? 0;
    });
  }

  async listCompanyTasks(parseJobId: string): Promise<CompanyTaskRow[]> {
    return this.withClient(async (client) => {
      const result = await client.query<CompanyTaskRow>(POSTGRES_SQL.LIST_COMPANY_TASKS, [parseJobId]);
      return result.rows.map((row) => this.hydrateCompanyTask(row));
    });
  }

  async markTaskSuccess(taskId: number): Promise<boolean> {
    return this.transitionFromProcessing(taskId, "success", null);
  }
  async markTaskPartial(taskId: number): Promise<boolean> {
    return this.transitionFromProcessing(taskId, "partial", null);
  }
  async markTaskFailed(taskId: number, error: string): Promise<boolean> {
    return this.transitionFromProcessing(taskId, "failed", error);
  }

  async markTaskBlocked(taskId: number, error: string): Promise<boolean> {
    return this.withClient(async (client) => {
      const result = await client.query(POSTGRES_SQL.MARK_TASK_BLOCKED, [
        error,
        new Date().toISOString(),
        taskId
      ]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async scheduleTaskRetry(taskId: number, error: string, nextRunAt: string): Promise<boolean> {
    return this.withClient(async (client) => {
      const result = await client.query(POSTGRES_SQL.SCHEDULE_TASK_RETRY, [
        nextRunAt,
        error,
        new Date().toISOString(),
        taskId
      ]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async recoverExpiredLeases(referenceTime: Date = new Date()): Promise<number> {
    const now = referenceTime.toISOString();
    return this.withClient(async (client) => {
      const result = await client.query(POSTGRES_SQL.RECOVER_EXPIRED_LEASES, [now, now, now]);
      return result.rowCount ?? 0;
    });
  }

  private async transitionFromProcessing(
    taskId: number,
    status: CompanyTaskStatus,
    error: string | null
  ): Promise<boolean> {
    return this.withClient(async (client) => {
      const result = await client.query(POSTGRES_SQL.TRANSITION_FROM_PROCESSING, [
        status,
        error,
        new Date().toISOString(),
        taskId
      ]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  // ----------------------------------------------------------------
  // Lead / attempt / event writes
  // ----------------------------------------------------------------

  async upsertLead(lead: Lead): Promise<void> {
    await this.withClient((client) =>
      client.query(POSTGRES_SQL.UPSERT_LEAD, [
        lead.source,
        lead.external_id,
        lead.company_name,
        lead.category,
        lead.city,
        lead.address,
        JSON.stringify(lead.phones),
        lead.email,
        lead.website,
        JSON.stringify(lead.social_links),
        JSON.stringify(lead.messenger_links),
        lead.parsed_at,
        lead.incomplete
      ])
    );
  }

  async listLeads(): Promise<Lead[]> {
    return this.withClient(async (client) => {
      const result = await client.query<Record<string, unknown>>(POSTGRES_SQL.LIST_LEADS);
      return result.rows.map((row) => this.hydrateLead(row));
    });
  }

  async saveAttempt(attempt: ParseAttempt): Promise<void> {
    await this.withClient((client) =>
      client.query(POSTGRES_SQL.SAVE_ATTEMPT, [
        attempt.companyTaskId ?? null,
        attempt.jobId ?? null,
        attempt.source,
        attempt.externalId ?? null,
        attempt.attemptNo ?? null,
        attempt.status,
        attempt.errorType ?? null,
        attempt.message ?? null,
        attempt.proxyId ?? null,
        attempt.durationMs ?? null,
        new Date().toISOString()
      ])
    );
  }

  async countParseAttempts(parseJobId: string): Promise<number> {
    return this.withClient(async (client) => {
      const result = await client.query<{ n: number }>(POSTGRES_SQL.COUNT_PARSE_ATTEMPTS, [parseJobId]);
      return result.rows[0]?.n ?? 0;
    });
  }

  async saveCaptchaEvent(input: CaptchaEventInput): Promise<number> {
    return this.withClient(async (client) => {
      const result = await client.query<{ id: string | number }>(POSTGRES_SQL.SAVE_CAPTCHA_EVENT, [
        input.source,
        input.url ?? null,
        input.screenshotPath ?? null,
        input.action,
        new Date().toISOString(),
        input.companyTaskId ?? null,
        input.proxyId ?? null,
        input.snapshotId ?? null
      ]);
      return Number(result.rows[0].id);
    });
  }

  async saveRawSnapshot(input: SaveRawSnapshotInput): Promise<number> {
    const now = new Date().toISOString();
    const payload =
      input.payload === undefined
        ? null
        : typeof input.payload === "string"
          ? input.payload
          : JSON.stringify(input.payload);
    const diskPath = input.payloadPath ?? null;

    const snapshotId = await this.withClient(async (client) => {
      const result = await client.query<{ snapshot_id: string | number }>(
        POSTGRES_SQL.SAVE_RAW_SNAPSHOT,
        [
          input.companyTaskId ?? null,
          input.source,
          input.externalId ?? null,
          input.kind,
          input.purpose,
          payload,
          diskPath,
          now,
          now
        ]
      );
      return Number(result.rows[0].snapshot_id);
    });

    if (this.rawSnapshotDir !== null && payload !== null && diskPath === null) {
      const written = this.writeSnapshotToDisk(snapshotId, input, payload, now);
      if (written !== null) {
        await this.withClient((client) =>
          client.query(POSTGRES_SQL.UPDATE_RAW_SNAPSHOT_PATH, [written, snapshotId])
        );
      }
    }

    return snapshotId;
  }

  private writeSnapshotToDisk(
    snapshotId: number,
    input: SaveRawSnapshotInput,
    payload: string,
    createdAt: string
  ): string | null {
    if (this.rawSnapshotDir === null) return null;
    try {
      fs.mkdirSync(this.rawSnapshotDir, { recursive: true });
    } catch {
      return null;
    }
    const ext = this.fileExtensionForKind(input.kind);
    const externalPart = input.externalId ?? "anon";
    const stamp = createdAt.replace(/[:.]/g, "-");
    const fileName = `snapshot-${snapshotId}-${sanitizeSegment(input.purpose)}-${sanitizeSegment(externalPart)}-${stamp}.${ext}`;
    const filePath = path.join(this.rawSnapshotDir, fileName);
    try {
      fs.writeFileSync(filePath, payload, "utf8");
      return filePath;
    } catch {
      return null;
    }
  }

  private fileExtensionForKind(kind: string): string {
    const k = kind.toLowerCase();
    if (k === "html") return "html";
    if (k === "json") return "json";
    return "txt";
  }

  // ----------------------------------------------------------------
  // Telemetry
  // ----------------------------------------------------------------

  async getJobTelemetry(parseJobId: string): Promise<JobTelemetry> {
    // Mirrors `computeJobTelemetry` from `src/core/telemetry.ts` exactly so
    // the SQLite and Postgres implementations produce identical metrics.
    // Inlined (rather than reusing the SQLite function) because the SQLite
    // helper is typed against `better-sqlite3.Database`, which the pg
    // driver does not satisfy.
    return this.withClient(async (client) => {
      const countsResult = await client.query<{
        success_n: number | null;
        partial_n: number | null;
        failed_n: number | null;
        terminal_n: number | null;
      }>(
        `SELECT
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::int AS success_n,
           SUM(CASE WHEN status = 'partial'  THEN 1 ELSE 0 END)::int AS partial_n,
           SUM(CASE WHEN status IN ('failed','blocked') THEN 1 ELSE 0 END)::int AS failed_n,
           COUNT(*)::int AS terminal_n
         FROM company_tasks
         WHERE parse_job_id = $1
           AND status IN ('success','partial','failed','blocked')`,
        [parseJobId]
      );
      const counts = countsResult.rows[0] ?? {
        success_n: 0,
        partial_n: 0,
        failed_n: 0,
        terminal_n: 0
      };
      const terminal = counts.terminal_n ?? 0;
      const successN = counts.success_n ?? 0;
      const partialN = counts.partial_n ?? 0;
      const failedN = counts.failed_n ?? 0;

      const captchaResult = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM captcha_events
         WHERE company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = $1)`,
        [parseJobId]
      );
      const captchaCount = captchaResult.rows[0]?.n ?? 0;

      const banResult = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM parse_attempts
         WHERE (result = 'blocked' OR error_type = 'blocked')
           AND company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = $1)`,
        [parseJobId]
      );
      const banCount = banResult.rows[0]?.n ?? 0;

      const jobTimeResult = await client.query<{ created_at: Date; finished_at: Date | null }>(
        `SELECT created_at, finished_at FROM parse_jobs WHERE id = $1`,
        [parseJobId]
      );
      const jobStart = jobTimeResult.rows[0]?.created_at ?? null;
      const jobEnd = jobTimeResult.rows[0]?.finished_at ?? new Date();

      let proxyN = 0;
      if (jobStart) {
        const proxyResult = await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM proxy_history
            WHERE created_at >= $1 AND created_at <= $2`,
          [jobStart, jobEnd]
        );
        proxyN = proxyResult.rows[0]?.n ?? 0;
      }

      const avgResult = await client.query<{ avg_ms: number | null }>(
        `SELECT AVG(duration_ms)::float8 AS avg_ms FROM parse_attempts
         WHERE duration_ms IS NOT NULL
           AND company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = $1)`,
        [parseJobId]
      );
      const avgMs = avgResult.rows[0]?.avg_ms ?? null;

      let cardsPerHour: number | null = null;
      if (jobStart) {
        const totalResult = await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM company_tasks WHERE parse_job_id = $1`,
          [parseJobId]
        );
        const totalN = totalResult.rows[0]?.n ?? 0;
        const elapsedHours = (jobEnd.getTime() - jobStart.getTime()) / 3_600_000;
        cardsPerHour = elapsedHours > 0 ? totalN / elapsedHours : null;
      }

      return {
        parseJobId,
        success_rate: terminal > 0 ? successN / terminal : 0,
        partial_rate: terminal > 0 ? partialN / terminal : 0,
        failed_rate: terminal > 0 ? failedN / terminal : 0,
        terminal_count: terminal,
        captcha_count: captchaCount,
        ban_count: banCount,
        proxy_rotation_count: proxyN,
        average_parse_time: avgMs,
        cards_per_hour: cardsPerHour
      };
    });
  }

  // ----------------------------------------------------------------
  // Proxy lifecycle
  // ----------------------------------------------------------------

  async saveProxyRotation(input: ProxyRotationInput): Promise<void> {
    const now = new Date().toISOString();
    await this.withClient((client) =>
      client.query(POSTGRES_SQL.SAVE_PROXY_ROTATION, [
        input.proxy ?? null,
        input.reason,
        now,
        input.proxyChannel ?? null,
        input.ip ?? null,
        input.rotatedAt ?? now,
        input.cardsOnIp ?? null
      ])
    );
  }

  // ----------------------------------------------------------------
  // Row hydration (TIMESTAMPTZ → ISO string, JSONB → typed value)
  // ----------------------------------------------------------------

  private hydrateParseJob(row: ParseJobRow): ParseJobRow {
    return {
      ...row,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      finished_at: row.finished_at ? toIso(row.finished_at) : null
    };
  }

  private hydrateCompanyTask(row: CompanyTaskRow): CompanyTaskRow {
    return {
      ...row,
      id: Number(row.id),
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      next_run_at: row.next_run_at ? toIso(row.next_run_at) : null,
      lease_until: row.lease_until ? toIso(row.lease_until) : null
    };
  }

  private hydrateLead(row: Record<string, unknown>): Lead {
    return {
      source: String(row["source"]),
      external_id: String(row["external_id"]),
      company_name: String(row["company_name"]),
      category: String(row["category"]),
      city: String(row["city"]),
      address: String(row["address"]),
      phones: normaliseJsonArray(row["phones"]),
      email: row["email"] == null ? null : String(row["email"]),
      website: row["website"] == null ? null : String(row["website"]),
      social_links: normaliseJsonArray(row["social_links"]),
      messenger_links: normaliseJsonArray(row["messenger_links"]),
      parsed_at: toIso(row["parsed_at"]),
      incomplete: Boolean(row["incomplete"])
    };
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(String(value)).toISOString();
}

function normaliseJsonArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Replace filesystem-unsafe characters in a path segment with `_`. Matches
 * the SQLite helper byte-for-byte so on-disk snapshot filenames produced
 * by either backend look identical.
 */
function sanitizeSegment(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}
