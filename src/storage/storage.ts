import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
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
import { runMigrations } from "./migrations.js";
import { computeJobTelemetry, type JobTelemetry } from "../core/telemetry.js";
import type {
  ClaimTaskInput,
  CreateParseJobInput,
  EnqueueCompanyTaskInput,
  IStorage
} from "./interface.js";
export type { JobTelemetry };
export type {
  ClaimTaskInput,
  CreateParseJobInput,
  EnqueueCompanyTaskInput,
  IStorage
} from "./interface.js";

/**
 * SQLite-backed default implementation of {@link IStorage}.
 *
 * `better-sqlite3` is a synchronous driver, so the methods are declared
 * `async` purely to satisfy the contract — every body still runs to
 * completion before its (immediately-resolved) Promise is returned. The
 * Postgres implementation in `src/storage/postgres/` shares the same
 * async surface but actually awaits the network.
 */
export class Storage implements IStorage {
  private readonly db: Database.Database;
  private readonly rawSnapshotDir: string | null;

  constructor(databasePath: string, rawSnapshotDir?: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.rawSnapshotDir = rawSnapshotDir ? path.resolve(rawSnapshotDir) : null;
    runMigrations(this.db);
  }

  /**
   * Absolute path of the directory where raw snapshot payloads are persisted
   * to disk, or `null` when no directory is configured (inline-only mode).
   */
  getRawSnapshotDir(): string | null {
    return this.rawSnapshotDir;
  }

  async upsertLead(lead: Lead): Promise<void> {
    const insertLead = this.db.prepare(`
      INSERT INTO leads (
        source, external_id, company_name, category, city, address, phones,
        email, website, social_links, messenger_links, parsed_at, incomplete
      ) VALUES (
        @source, @external_id, @company_name, @category, @city, @address, @phones,
        @email, @website, @social_links, @messenger_links, @parsed_at, @incomplete
      )
      ON CONFLICT(source, external_id) DO UPDATE SET
        company_name = excluded.company_name,
        category = excluded.category,
        city = excluded.city,
        address = excluded.address,
        phones = excluded.phones,
        email = excluded.email,
        website = excluded.website,
        social_links = excluded.social_links,
        messenger_links = excluded.messenger_links,
        parsed_at = excluded.parsed_at,
        incomplete = excluded.incomplete
    `);
    const insertPhone = this.db.prepare(`
      INSERT OR IGNORE INTO lead_phones (phone, source, external_id)
      VALUES (?, ?, ?)
    `);

    this.db.transaction(() => {
      insertLead.run({
        ...lead,
        phones: JSON.stringify(lead.phones),
        social_links: JSON.stringify(lead.social_links),
        messenger_links: JSON.stringify(lead.messenger_links),
        incomplete: lead.incomplete ? 1 : 0
      });
      for (const phone of lead.phones) {
        insertPhone.run(phone, lead.source, lead.external_id);
      }
    })();
  }

  /**
   * Legacy raw-payload writer. Retained for backwards compatibility with callers
   * that haven't been migrated to {@link saveRawSnapshot}. Writes to the v1
   * `raw_records` table only — does not touch `raw_snapshots`.
   */
  saveRaw(source: string, externalId: string | undefined, kind: string, payload: unknown): void {
    this.db.prepare(`
      INSERT INTO raw_records (source, external_id, kind, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(source, externalId ?? null, kind, JSON.stringify(payload), new Date().toISOString());
  }

  async saveAttempt(attempt: ParseAttempt): Promise<void> {
    this.db.prepare(`
      INSERT INTO parse_attempts (
        company_task_id, job_id, source, external_id, attempt_no,
        result, error_type, message, proxy_id, duration_ms, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    );
  }

  async listLeads(): Promise<Lead[]> {
    const rows = this.db.prepare("SELECT * FROM leads ORDER BY company_name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      source: String(row.source),
      external_id: String(row.external_id),
      company_name: String(row.company_name),
      category: String(row.category),
      city: String(row.city),
      address: String(row.address),
      phones: JSON.parse(String(row.phones)) as string[],
      email: row.email ? String(row.email) : null,
      website: row.website ? String(row.website) : null,
      social_links: JSON.parse(String(row.social_links)) as string[],
      messenger_links: JSON.parse(String(row.messenger_links)) as string[],
      parsed_at: String(row.parsed_at),
      incomplete: Boolean(row.incomplete)
    }));
  }

  /**
   * Legacy proxy-event writer. Forwards to {@link saveProxyRotation} so the new
   * `proxy_channel` / `ip` / `rotated_at` / `cards_on_ip` columns receive a
   * sensible default (null) and `rotated_at` mirrors `created_at`.
   */
  saveProxyEvent(proxy: string | null, reason: string): void {
    this.saveProxyRotation({ proxy, reason });
  }

  async saveProxyRotation(input: ProxyRotationInput): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO proxy_history
        (proxy, reason, created_at, proxy_channel, ip, rotated_at, cards_on_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.proxy ?? null,
      input.reason,
      now,
      input.proxyChannel ?? null,
      input.ip ?? null,
      input.rotatedAt ?? now,
      input.cardsOnIp ?? null
    );
  }

  async saveCaptchaEvent(input: CaptchaEventInput): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO captcha_events
        (source, url, screenshot_path, action, created_at,
         company_task_id, proxy_id, snapshot_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.source,
      input.url ?? null,
      input.screenshotPath ?? null,
      input.action,
      now,
      input.companyTaskId ?? null,
      input.proxyId ?? null,
      input.snapshotId ?? null
    );
    return Number(result.lastInsertRowid);
  }

  // ============================================================
  // Raw snapshots (§3.7 / §3.11)
  // ============================================================

  async saveRawSnapshot(input: SaveRawSnapshotInput): Promise<number> {
    const now = new Date().toISOString();
    const payload =
      input.payload === undefined
        ? null
        : typeof input.payload === "string"
          ? input.payload
          : JSON.stringify(input.payload);

    // When a raw snapshot directory is configured, the on-disk file is
    // authoritative for content too — we still keep the inline payload for
    // backwards compatibility with callers / tests that inspect it directly.
    // A caller-supplied `payloadPath` is always honored (it is just a label
    // pointing at a pre-existing artefact, e.g. a fixture file).
    const diskPath = input.payloadPath ?? null;

    const result = this.db.prepare(`
      INSERT INTO raw_snapshots
        (company_task_id, source, external_id, kind, purpose,
         payload, payload_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.companyTaskId ?? null,
      input.source,
      input.externalId ?? null,
      input.kind,
      input.purpose,
      payload,
      diskPath,
      now,
      now
    );
    const snapshotId = Number(result.lastInsertRowid);

    // Best-effort disk write for inline payloads. Failures must not break the
    // save — inline payload is already persisted in the row above.
    if (
      this.rawSnapshotDir !== null &&
      payload !== null &&
      diskPath === null
    ) {
      const written = this.writeSnapshotToDisk(snapshotId, input, payload, now);
      if (written !== null) {
        this.db.prepare(
          "UPDATE raw_snapshots SET payload_path = ? WHERE snapshot_id = ?"
        ).run(written, snapshotId);
      }
    }

    return snapshotId;
  }

  /**
   * Persist a snapshot payload to disk under the configured raw snapshot
   * directory. Creates the directory if it does not exist. Returns the
   * absolute file path on success, or `null` on any I/O failure (errors are
   * swallowed so the caller's DB write is never blocked by a filesystem issue).
   */
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

  /**
   * Read the payload body of a snapshot. Prefers the inline `payload` column;
   * falls back to the on-disk file referenced by `payload_path` when the
   * inline value is missing. Returns `null` if the row does not exist or the
   * payload is unavailable (e.g. disk file was deleted out-of-band).
   */
  readRawSnapshotContent(snapshotId: number): string | null {
    const row = this.getRawSnapshot(snapshotId);
    if (!row) return null;
    if (row.payload !== null) return row.payload;
    if (row.payload_path) {
      try {
        return fs.readFileSync(row.payload_path, "utf8");
      } catch {
        return null;
      }
    }
    return null;
  }

  listRawSnapshots(filter: ListRawSnapshotsFilter = {}): RawSnapshotRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.purpose !== undefined) {
      where.push("purpose = ?");
      params.push(filter.purpose);
    }
    if (filter.source !== undefined) {
      where.push("source = ?");
      params.push(filter.source);
    }
    if (filter.externalId !== undefined) {
      where.push("external_id = ?");
      params.push(filter.externalId);
    }
    if (filter.companyTaskId !== undefined) {
      if (filter.companyTaskId === null) {
        where.push("company_task_id IS NULL");
      } else {
        where.push("company_task_id = ?");
        params.push(filter.companyTaskId);
      }
    }
    const sql =
      "SELECT * FROM raw_snapshots" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at DESC, snapshot_id DESC";
    return (this.db.prepare(sql).all(...params) as RawSnapshotRow[]).map((row) =>
      this.hydrateRawSnapshotPayload(row)
    );
  }

  getRawSnapshot(snapshotId: number): RawSnapshotRow | null {
    const row = this.db
      .prepare("SELECT * FROM raw_snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as RawSnapshotRow | undefined;
    return row ? this.hydrateRawSnapshotPayload(row) : null;
  }

  private hydrateRawSnapshotPayload(row: RawSnapshotRow): RawSnapshotRow {
    if (row.payload !== null || !row.payload_path) return row;
    try {
      return { ...row, payload: fs.readFileSync(row.payload_path, "utf8") };
    } catch {
      return row;
    }
  }

  /**
   * Ring-buffer cleanup for `purpose='recent'` snapshots. Keeps the newest
   * `maxEntries` rows and deletes the rest. On-disk payload files referenced
   * by the deleted rows are unlinked (best-effort). Returns the number deleted.
   */
  cleanupRecentSnapshots(options: CleanupRecentOptions): number {
    if (options.maxEntries < 0) throw new Error("maxEntries must be >= 0");
    const rows = this.db
      .prepare(
        `SELECT snapshot_id, payload_path FROM raw_snapshots
         WHERE purpose = 'recent'
           AND snapshot_id NOT IN (
             SELECT snapshot_id FROM raw_snapshots
             WHERE purpose = 'recent'
             ORDER BY created_at DESC, snapshot_id DESC
             LIMIT ?
           )`
      )
      .all(options.maxEntries) as Array<{ snapshot_id: number; payload_path: string | null }>;
    if (rows.length === 0) return 0;
    const placeholders = rows.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `DELETE FROM raw_snapshots WHERE snapshot_id IN (${placeholders})`
      )
      .run(...rows.map((r) => r.snapshot_id));
    this.unlinkPayloadFiles(rows);
    return result.changes;
  }

  /**
   * TTL cleanup. Deletes snapshots with `created_at < (now - olderThanMs)`,
   * optionally filtered by purpose. `now` can be injected for deterministic tests.
   * On-disk payload files for the deleted rows are unlinked (best-effort).
   */
  cleanupSnapshotsOlderThan(options: CleanupOlderOptions): number {
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - options.olderThanMs).toISOString();
    const withPurpose = options.purpose !== undefined;
    const selectSql = withPurpose
      ? "SELECT snapshot_id, payload_path FROM raw_snapshots WHERE purpose = ? AND created_at < ?"
      : "SELECT snapshot_id, payload_path FROM raw_snapshots WHERE created_at < ?";
    const deleteSql = withPurpose
      ? "DELETE FROM raw_snapshots WHERE purpose = ? AND created_at < ?"
      : "DELETE FROM raw_snapshots WHERE created_at < ?";
    const params = withPurpose ? [options.purpose, cutoff] : [cutoff];
    const rows = this.db.prepare(selectSql).all(...params) as Array<{
      snapshot_id: number;
      payload_path: string | null;
    }>;
    const result = this.db.prepare(deleteSql).run(...params);
    this.unlinkPayloadFiles(rows);
    return result.changes;
  }

  private unlinkPayloadFiles(
    rows: Array<{ snapshot_id: number; payload_path: string | null }>
  ): void {
    for (const row of rows) {
      if (!row.payload_path) continue;
      try {
        fs.unlinkSync(row.payload_path);
      } catch {
        // Best-effort: missing or unreadable files must not break cleanup.
      }
    }
  }

  // ============================================================
  // Queue / State layer
  // ============================================================

  async createParseJob(input: CreateParseJobInput): Promise<string> {
    const id = `${input.source}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO parse_jobs (id, source, city, category, status, total_found, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', 0, ?, ?)
    `).run(id, input.source, input.city, input.category, now, now);
    return id;
  }

  async updateParseJobTotalFound(parseJobId: string, totalFound: number): Promise<void> {
    this.db.prepare(`
      UPDATE parse_jobs SET total_found = ?, updated_at = ? WHERE id = ?
    `).run(totalFound, new Date().toISOString(), parseJobId);
  }

  async setParseJobStatus(parseJobId: string, status: ParseJobStatus): Promise<void> {
    const now = new Date().toISOString();
    const finishedAt = status === "completed" || status === "failed" ? now : null;
    this.db.prepare(`
      UPDATE parse_jobs SET status = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
      WHERE id = ?
    `).run(status, now, finishedAt, parseJobId);
  }

  async getParseJob(parseJobId: string): Promise<ParseJobRow | null> {
    const row = this.db.prepare("SELECT * FROM parse_jobs WHERE id = ?").get(parseJobId) as
      | ParseJobRow
      | undefined;
    return row ?? null;
  }

  async findResumableParseJob(input: CreateParseJobInput): Promise<ParseJobRow | null> {
    const row = this.db.prepare(`
      SELECT * FROM parse_jobs
      WHERE source = ? AND city = ? AND category = ?
        AND status NOT IN ('completed', 'failed')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(input.source, input.city, input.category) as ParseJobRow | undefined;
    return row ?? null;
  }

  async finalizeParseJob(parseJobId: string): Promise<ParseJobStatus> {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('success','partial') THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status NOT IN ('success','partial','failed') THEN 1 ELSE 0 END) AS open
      FROM company_tasks
      WHERE parse_job_id = ?
    `).get(parseJobId) as { done: number | null; failed: number | null; open: number | null };

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

  async enqueueCompanyTask(input: EnqueueCompanyTaskInput): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO company_tasks
        (parse_job_id, source, external_id, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?)
    `).run(input.parseJobId, input.source, input.externalId, now, now);
    if (result.changes === 0) {
      const existing = this.db.prepare(`
        SELECT id FROM company_tasks
        WHERE source = ? AND external_id = ? AND parse_job_id = ?
      `).get(input.source, input.externalId, input.parseJobId) as { id: number };
      return existing.id;
    }
    return Number(result.lastInsertRowid);
  }

  getCompanyTask(taskId: number): CompanyTaskRow | null {
    const row = this.db.prepare("SELECT * FROM company_tasks WHERE id = ?").get(taskId) as
      | CompanyTaskRow
      | undefined;
    return row ?? null;
  }

  async listCompanyTasks(parseJobId: string): Promise<CompanyTaskRow[]> {
    return this.db
      .prepare("SELECT * FROM company_tasks WHERE parse_job_id = ? ORDER BY id ASC")
      .all(parseJobId) as CompanyTaskRow[];
  }

  async countOpenTasks(parseJobId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) as n FROM company_tasks
      WHERE parse_job_id = ?
        AND status IN ('pending', 'processing', 'retry_scheduled', 'blocked')
    `).get(parseJobId) as { n: number };
    return row.n;
  }

  async claimNextTask(input: ClaimTaskInput): Promise<CompanyTaskRow | null> {
    const txn = this.db.transaction((): CompanyTaskRow | null => {
      const now = new Date().toISOString();
      const leaseUntil = new Date(Date.now() + input.leaseMs).toISOString();
      const row = this.db.prepare(`
        SELECT * FROM company_tasks
        WHERE parse_job_id = ?
          AND status IN ('pending', 'retry_scheduled')
          AND (next_run_at IS NULL OR next_run_at <= ?)
        ORDER BY id ASC
        LIMIT 1
      `).get(input.parseJobId, now) as CompanyTaskRow | undefined;
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE company_tasks
        SET status = 'processing',
            worker_id = ?,
            lease_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ? AND status IN ('pending', 'retry_scheduled')
      `).run(input.workerId, leaseUntil, now, row.id);
      if (result.changes === 0) return null;
      return {
        ...row,
        status: "processing",
        worker_id: input.workerId,
        lease_until: leaseUntil,
        attempts: row.attempts + 1,
        updated_at: now
      };
    });
    return txn.immediate();
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
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = 'blocked', last_error = ?, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(error, now, taskId);
    return result.changes > 0;
  }

  async scheduleTaskRetry(taskId: number, error: string, nextRunAt: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = 'retry_scheduled',
          worker_id = NULL,
          lease_until = NULL,
          next_run_at = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('processing', 'blocked')
    `).run(nextRunAt, error, now, taskId);
    return result.changes > 0;
  }

  async recoverExpiredLeases(referenceTime: Date = new Date()): Promise<number> {
    const now = referenceTime.toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = 'retry_scheduled',
          worker_id = NULL,
          lease_until = NULL,
          next_run_at = ?,
          last_error = COALESCE(last_error, 'lease expired'),
          updated_at = ?
      WHERE status = 'processing'
        AND lease_until IS NOT NULL
        AND lease_until <= ?
    `).run(now, now, now);
    return result.changes;
  }

  private async transitionFromProcessing(
    taskId: number,
    status: CompanyTaskStatus,
    error: string | null
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = ?,
          worker_id = NULL,
          lease_until = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(status, error, now, taskId);
    return result.changes > 0;
  }

  async getJobTelemetry(parseJobId: string): Promise<JobTelemetry> {
    return computeJobTelemetry(this.db, parseJobId);
  }

  /**
   * Count of `parse_attempts` rows linked to tasks of `parseJobId`. Used by the
   * JobManager to enforce `rateLimit.maxCardsPerSession` against the durable
   * source of truth (every attempt — success, partial, failed, blocked —
   * inserts a row in `parse_attempts`).
   */
  async countParseAttempts(parseJobId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM parse_attempts
      WHERE company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = ?)
    `).get(parseJobId) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Replace filesystem-unsafe characters in a path segment with `_`. Keeps the
 * length bounded so we never approach platform path limits even with long
 * external identifiers.
 */
function sanitizeSegment(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}
