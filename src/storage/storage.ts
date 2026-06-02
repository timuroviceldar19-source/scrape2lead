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
export type { JobTelemetry };

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

export class Storage {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    runMigrations(this.db);
  }

  upsertLead(lead: Lead): void {
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

  saveAttempt(attempt: ParseAttempt): void {
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

  listLeads(): Lead[] {
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

  saveProxyRotation(input: ProxyRotationInput): void {
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

  saveCaptchaEvent(input: CaptchaEventInput): number {
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

  saveRawSnapshot(input: SaveRawSnapshotInput): number {
    const now = new Date().toISOString();
    const payload =
      input.payload === undefined
        ? null
        : typeof input.payload === "string"
          ? input.payload
          : JSON.stringify(input.payload);
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
      input.payloadPath ?? null,
      now,
      now
    );
    return Number(result.lastInsertRowid);
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
    return this.db.prepare(sql).all(...params) as RawSnapshotRow[];
  }

  getRawSnapshot(snapshotId: number): RawSnapshotRow | null {
    const row = this.db
      .prepare("SELECT * FROM raw_snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as RawSnapshotRow | undefined;
    return row ?? null;
  }

  /**
   * Ring-buffer cleanup for `purpose='recent'` snapshots. Keeps the newest
   * `maxEntries` rows and deletes the rest. Returns the number deleted.
   */
  cleanupRecentSnapshots(options: CleanupRecentOptions): number {
    if (options.maxEntries < 0) throw new Error("maxEntries must be >= 0");
    const result = this.db.prepare(`
      DELETE FROM raw_snapshots
      WHERE purpose = 'recent'
        AND snapshot_id NOT IN (
          SELECT snapshot_id FROM raw_snapshots
          WHERE purpose = 'recent'
          ORDER BY created_at DESC, snapshot_id DESC
          LIMIT ?
        )
    `).run(options.maxEntries);
    return result.changes;
  }

  /**
   * TTL cleanup. Deletes snapshots with `created_at < (now - olderThanMs)`,
   * optionally filtered by purpose. `now` can be injected for deterministic tests.
   */
  cleanupSnapshotsOlderThan(options: CleanupOlderOptions): number {
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - options.olderThanMs).toISOString();
    if (options.purpose !== undefined) {
      return this.db
        .prepare("DELETE FROM raw_snapshots WHERE purpose = ? AND created_at < ?")
        .run(options.purpose, cutoff).changes;
    }
    return this.db
      .prepare("DELETE FROM raw_snapshots WHERE created_at < ?")
      .run(cutoff).changes;
  }

  // ============================================================
  // Queue / State layer
  // ============================================================

  createParseJob(input: CreateParseJobInput): string {
    const id = `${input.source}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO parse_jobs (id, source, city, category, status, total_found, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', 0, ?, ?)
    `).run(id, input.source, input.city, input.category, now, now);
    return id;
  }

  updateParseJobTotalFound(parseJobId: string, totalFound: number): void {
    this.db.prepare(`
      UPDATE parse_jobs SET total_found = ?, updated_at = ? WHERE id = ?
    `).run(totalFound, new Date().toISOString(), parseJobId);
  }

  setParseJobStatus(parseJobId: string, status: ParseJobStatus): void {
    const now = new Date().toISOString();
    const finishedAt = status === "completed" || status === "failed" ? now : null;
    this.db.prepare(`
      UPDATE parse_jobs SET status = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
      WHERE id = ?
    `).run(status, now, finishedAt, parseJobId);
  }

  getParseJob(parseJobId: string): ParseJobRow | null {
    const row = this.db.prepare("SELECT * FROM parse_jobs WHERE id = ?").get(parseJobId) as
      | ParseJobRow
      | undefined;
    return row ?? null;
  }

  findResumableParseJob(input: CreateParseJobInput): ParseJobRow | null {
    const row = this.db.prepare(`
      SELECT * FROM parse_jobs
      WHERE source = ? AND city = ? AND category = ?
        AND status NOT IN ('completed', 'failed')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(input.source, input.city, input.category) as ParseJobRow | undefined;
    return row ?? null;
  }

  finalizeParseJob(parseJobId: string): ParseJobStatus {
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

    this.setParseJobStatus(parseJobId, status);
    return status;
  }

  enqueueCompanyTask(input: EnqueueCompanyTaskInput): number {
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

  listCompanyTasks(parseJobId: string): CompanyTaskRow[] {
    return this.db
      .prepare("SELECT * FROM company_tasks WHERE parse_job_id = ? ORDER BY id ASC")
      .all(parseJobId) as CompanyTaskRow[];
  }

  countOpenTasks(parseJobId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as n FROM company_tasks
      WHERE parse_job_id = ?
        AND status IN ('pending', 'processing', 'retry_scheduled', 'blocked')
    `).get(parseJobId) as { n: number };
    return row.n;
  }

  claimNextTask(input: ClaimTaskInput): CompanyTaskRow | null {
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

  markTaskSuccess(taskId: number): boolean {
    return this.transitionFromProcessing(taskId, "success", null);
  }

  markTaskPartial(taskId: number): boolean {
    return this.transitionFromProcessing(taskId, "partial", null);
  }

  markTaskFailed(taskId: number, error: string): boolean {
    return this.transitionFromProcessing(taskId, "failed", error);
  }

  markTaskBlocked(taskId: number, error: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = 'blocked', last_error = ?, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(error, now, taskId);
    return result.changes > 0;
  }

  scheduleTaskRetry(taskId: number, error: string, nextRunAt: string): boolean {
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

  recoverExpiredLeases(referenceTime: Date = new Date()): number {
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

  private transitionFromProcessing(
    taskId: number,
    status: CompanyTaskStatus,
    error: string | null
  ): boolean {
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

  getJobTelemetry(parseJobId: string): JobTelemetry {
    return computeJobTelemetry(this.db, parseJobId);
  }

  close(): void {
    this.db.close();
  }
}
