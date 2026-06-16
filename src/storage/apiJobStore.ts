/**
 * Persistent job store for the Scrape2Lead API server.
 *
 * `IJobStore` is a narrow, async contract that hides the backend (SQLite via
 * `better-sqlite3` or Postgres via `pg`). Server code should depend only on
 * this interface so the storage backend can be swapped by environment
 * variables.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type ApiJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ApiJobType = "scrape" | "kz-enrich" | "kz-export" | "kz-autopilot";

export interface ApiJob {
  id: string;
  type: ApiJobType;
  status: ApiJobStatus;
  command: string;
  args: string[];
  request: Record<string, unknown>;
  cwd: string;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  artifacts: string[];
}

export interface ApiJobLog {
  id: number;
  job_id: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
  created_at: string;
}

export interface ApiJobArtifact {
  id: number;
  job_id: string;
  name: string;
  path: string;
  size: number;
  mtime: string;
  created_at: string;
}

export interface CreateApiJobInput {
  id: string;
  type: ApiJobType;
  command: string;
  args: string[];
  request: Record<string, unknown>;
  cwd: string;
}

export interface ListApiJobsFilter {
  status?: ApiJobStatus;
  limit?: number;
  offset?: number;
}

export interface ListApiJobsResult {
  jobs: ApiJob[];
  total: number;
}

export interface JobStoreOptions {
  /** SQLite database path or `:memory:`. Ignored when `sqliteDb` is provided. */
  databasePath?: string;
  /** Postgres connection string. When set, takes precedence over SQLite. */
  postgresConnectionString?: string;
  /** Existing SQLite database instance (useful for tests with `:memory:`). */
  sqliteDb?: Database.Database;
}

export interface IJobStore {
  createJob(input: CreateApiJobInput): Promise<void>;
  getJob(id: string): Promise<ApiJob | null>;
  listJobs(filter: ListApiJobsFilter): Promise<ListApiJobsResult>;
  claimNextQueuedJob(): Promise<ApiJob | null>;
  setJobPid(id: string, pid: number): Promise<boolean>;
  finishJob(
    id: string,
    status: Exclude<ApiJobStatus, "queued" | "running">,
    exitCode: number | null,
    signal: string | null,
    error?: string
  ): Promise<boolean>;
  cancelJob(id: string): Promise<boolean>;
  resetRunningJobs(): Promise<number>;
  appendLog(jobId: string, stream: ApiJobLog["stream"], line: string): Promise<void>;
  getLogs(jobId: string): Promise<ApiJobLog[]>;
  saveArtifacts(jobId: string, artifacts: Array<Omit<ApiJobArtifact, "id" | "job_id" | "created_at">>): Promise<void>;
  listArtifacts(jobId?: string): Promise<ApiJobArtifact[]>;
  getArtifact(id: number): Promise<ApiJobArtifact | null>;
  countRunningJobs(): Promise<number>;
  close(): void | Promise<void>;
}

/**
 * SQLite-backed implementation of {@link IJobStore}.
 *
 * Methods are declared `async` to satisfy the interface, but the driver is
 * synchronous so every method returns an immediately-resolved Promise.
 */
export class SqliteJobStore implements IJobStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor(databasePath: string);
  constructor(db: Database.Database);
  constructor(source: string | Database.Database) {
    if (typeof source === "string") {
      if (source !== ":memory:") {
        fs.mkdirSync(path.dirname(source), { recursive: true });
      }
      this.db = new Database(source);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.ownsDb = true;
    } else {
      this.db = source;
      this.ownsDb = false;
    }
    runMigrations(this.db);
  }

  async createJob(input: CreateApiJobInput): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO api_jobs (id, type, status, command, args_json, request_json, cwd, pid, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.type,
      "queued",
      input.command,
      JSON.stringify(input.args),
      JSON.stringify(input.request),
      input.cwd,
      null,
      now
    );
  }

  async getJob(id: string): Promise<ApiJob | null> {
    const row = this.db.prepare("SELECT * FROM api_jobs WHERE id = ?").get(id) as ApiJobRow | undefined;
    if (!row) return null;
    const artifacts = (this.db.prepare("SELECT name FROM api_job_artifacts WHERE job_id = ?").all(id) as Array<{ name: string }>)
      .map((a) => a.name);
    return hydrateJob(row, artifacts);
  }

  async listJobs(filter: ListApiJobsFilter): Promise<ListApiJobsResult> {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const offset = Math.max(0, filter.offset ?? 0);
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countRow = this.db.prepare(`SELECT COUNT(*) AS n FROM api_jobs ${whereSql}`).get(...params) as { n: number };

    const rows = this.db.prepare(`
      SELECT j.*, GROUP_CONCAT(a.name) AS artifact_names
      FROM api_jobs j
      LEFT JOIN api_job_artifacts a ON a.job_id = j.id
      ${whereSql}
      GROUP BY j.id
      ORDER BY j.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<ApiJobRow & { artifact_names: string | null }>;

    return {
      jobs: rows.map((row) => hydrateJob(row, parseArtifactNames(row.artifact_names))),
      total: countRow.n
    };
  }

  async claimNextQueuedJob(): Promise<ApiJob | null> {
    const now = new Date().toISOString();
    const row = this.db.prepare(`
      UPDATE api_jobs
      SET status = 'running', started_at = ?
      WHERE id = (
        SELECT id FROM api_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      RETURNING *
    `).get(now) as ApiJobRow | undefined;
    if (!row) return null;
    return hydrateJob(row, []);
  }

  async setJobPid(id: string, pid: number): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE api_jobs
      SET pid = ?
      WHERE id = ? AND status = 'running'
    `).run(pid, id);
    return result.changes > 0;
  }

  async finishJob(
    id: string,
    status: Exclude<ApiJobStatus, "queued" | "running">,
    exitCode: number | null,
    signal: string | null,
    error?: string
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE api_jobs
      SET status = ?, pid = NULL, finished_at = ?, exit_code = ?, signal = ?, error = ?
      WHERE id = ? AND status = 'running'
    `).run(status, now, exitCode, signal, error ?? null, id);
    return result.changes > 0;
  }

  async cancelJob(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE api_jobs
      SET status = 'cancelled', pid = NULL, finished_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(now, id);
    return result.changes > 0;
  }

  async resetRunningJobs(): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE api_jobs
      SET status = 'interrupted', pid = NULL, finished_at = ?, error = COALESCE(error, 'server restarted while job was running')
      WHERE status = 'running'
    `).run(now);
    return result.changes;
  }

  async appendLog(jobId: string, stream: ApiJobLog["stream"], line: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO api_job_logs (job_id, stream, line, created_at)
      VALUES (?, ?, ?, ?)
    `).run(jobId, stream, line, now);
  }

  async getLogs(jobId: string): Promise<ApiJobLog[]> {
    return this.db.prepare(`
      SELECT id, job_id, stream, line, created_at
      FROM api_job_logs
      WHERE job_id = ?
      ORDER BY id ASC
    `).all(jobId) as ApiJobLog[];
  }

  async saveArtifacts(
    jobId: string,
    artifacts: Array<Omit<ApiJobArtifact, "id" | "job_id" | "created_at">>
  ): Promise<void> {
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO api_job_artifacts (job_id, name, path, size, mtime, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction(() => {
      for (const artifact of artifacts) {
        insert.run(jobId, artifact.name, artifact.path, artifact.size, artifact.mtime, now);
      }
    });
    txn();
  }

  async listArtifacts(jobId?: string): Promise<ApiJobArtifact[]> {
    if (jobId) {
      return this.db.prepare(`
        SELECT id, job_id, name, path, size, mtime, created_at
        FROM api_job_artifacts
        WHERE job_id = ?
        ORDER BY created_at DESC
      `).all(jobId) as ApiJobArtifact[];
    }
    return this.db.prepare(`
      SELECT id, job_id, name, path, size, mtime, created_at
      FROM api_job_artifacts
      ORDER BY created_at DESC
      LIMIT 1000
    `).all() as ApiJobArtifact[];
  }

  async getArtifact(id: number): Promise<ApiJobArtifact | null> {
    const row = this.db.prepare(`
      SELECT id, job_id, name, path, size, mtime, created_at
      FROM api_job_artifacts
      WHERE id = ?
    `).get(id) as ApiJobArtifact | undefined;
    return row ?? null;
  }

  async countRunningJobs(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM api_jobs WHERE status = 'running'").get() as { n: number };
    return row.n;
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}

interface ApiJobRow {
  id: string;
  type: ApiJobType;
  status: ApiJobStatus;
  command: string;
  args_json: string;
  request_json: string;
  cwd: string;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
}

function hydrateJob(row: ApiJobRow, artifacts: string[]): ApiJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    cwd: row.cwd,
    pid: row.pid,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    exit_code: row.exit_code,
    signal: row.signal,
    error: row.error,
    artifacts
  };
}

function parseArtifactNames(value: string | null): string[] {
  if (!value) return [];
  return value.split(",");
}

/**
 * Create a {@link IJobStore} backed by SQLite or Postgres depending on the
 * supplied options / environment.
 *
 * Postgres is selected when `options.databaseUrl` or `DATABASE_URL` starts
 * with `postgres://` / `postgresql://`. Otherwise SQLite is used.
 */
export async function createJobStore(options: JobStoreOptions = {}): Promise<IJobStore> {
  const pgConn = options.postgresConnectionString ?? process.env.POSTGRES_CONNECTION_STRING;
  if (pgConn?.startsWith("postgres://") || pgConn?.startsWith("postgresql://")) {
    const { PostgresJobStore } = await import("./postgres/apiJobStore.js");
    return new PostgresJobStore(pgConn);
  }
  if (options.sqliteDb) {
    return new SqliteJobStore(options.sqliteDb);
  }
  return new SqliteJobStore(options.databasePath ?? process.env.SCRAPE2LEAD_DATABASE_PATH ?? "data/scrape2lead.db");
}
