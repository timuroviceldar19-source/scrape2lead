/**
 * Postgres-backed implementation of {@link IJobStore}.
 *
 * Mirrors {@link SqliteJobStore} from `src/storage/apiJobStore.ts` but uses
 * the `pg` driver's async pool. The migration is applied lazily on first use
 * via {@link runPostgresMigrations} so constructing the store does not require
 * a live database.
 */
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  runPostgresMigrations
} from "./migrations.js";
import type {
  ApiJob,
  ApiJobArtifact,
  ApiJobLog,
  CreateApiJobInput,
  IJobStore,
  ListApiJobsFilter,
  ListApiJobsResult
} from "../apiJobStore.js";

export interface PostgresJobStoreOptions {
  /** Pool config passed through to `pg.Pool`. */
  pool?: PoolConfig;
}

export class PostgresJobStore implements IJobStore {
  private readonly pool: Pool;
  private closed = false;
  private migrationPromise: Promise<void> | null = null;

  constructor(connectionString: string, options: PostgresJobStoreOptions = {}) {
    this.pool = new Pool({ connectionString, ...(options.pool ?? {}) });
  }

  private async ensureMigratedOnce(): Promise<void> {
    if (!this.migrationPromise) {
      this.migrationPromise = this.runMigrations().catch((error) => {
        this.migrationPromise = null;
        throw error;
      });
    }
    return this.migrationPromise;
  }

  private async runMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await runPostgresMigrations(client);
    } finally {
      client.release();
    }
  }

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

  async createJob(input: CreateApiJobInput): Promise<void> {
    const now = new Date().toISOString();
    await this.withClient((client) =>
      client.query(
        `INSERT INTO api_jobs (id, type, status, command, args_json, request_json, cwd, pid, created_at)
         VALUES ($1, $2, 'queued', $3, $4, $5, $6, NULL, $7::timestamptz)`,
        [input.id, input.type, input.command, JSON.stringify(input.args), JSON.stringify(input.request), input.cwd, now]
      )
    );
  }

  async getJob(id: string): Promise<ApiJob | null> {
    return this.withClient(async (client) => {
      const jobResult = await client.query<ApiJobRow>("SELECT * FROM api_jobs WHERE id = $1", [id]);
      if (jobResult.rows.length === 0) return null;
      const artifactResult = await client.query<{ name: string }>(
        "SELECT name FROM api_job_artifacts WHERE job_id = $1",
        [id]
      );
      return hydrateJob(jobResult.rows[0], artifactResult.rows.map((r) => r.name));
    });
  }

  async listJobs(filter: ListApiJobsFilter): Promise<ListApiJobsResult> {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const offset = Math.max(0, filter.offset ?? 0);
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.status) {
      where.push("status = $" + (params.length + 1));
      params.push(filter.status);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    return this.withClient(async (client) => {
      const countResult = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM api_jobs ${whereSql}`,
        params
      );
      const rowsResult = await client.query<ApiJobRow & { artifact_names: string | null }>(
        `SELECT j.*, STRING_AGG(a.name, ',') AS artifact_names
         FROM api_jobs j
         LEFT JOIN api_job_artifacts a ON a.job_id = j.id
         ${whereSql}
         GROUP BY j.id
         ORDER BY j.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return {
        jobs: rowsResult.rows.map((row) => hydrateJob(row, parseArtifactNames(row.artifact_names))),
        total: countResult.rows[0]?.n ?? 0
      };
    });
  }

  async claimNextQueuedJob(): Promise<ApiJob | null> {
    const now = new Date().toISOString();
    return this.withClient(async (client) => {
      const result = await client.query<ApiJobRow>(`
        UPDATE api_jobs
        SET status = 'running', started_at = $1::timestamptz
        WHERE id = (
          SELECT id FROM api_jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `, [now]);
      if (result.rows.length === 0) return null;
      return hydrateJob(result.rows[0], []);
    });
  }

  async setJobPid(id: string, pid: number): Promise<boolean> {
    const result = await this.withClient((client) =>
      client.query(
        `UPDATE api_jobs
         SET pid = $1
         WHERE id = $2 AND status = 'running'`,
        [pid, id]
      )
    );
    return (result.rowCount ?? 0) > 0;
  }

  async finishJob(
    id: string,
    status: Exclude<ApiJob["status"], "queued" | "running">,
    exitCode: number | null,
    signal: string | null,
    error?: string
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.withClient((client) =>
      client.query(
        `UPDATE api_jobs
         SET status = $1, pid = NULL, finished_at = $2::timestamptz, exit_code = $3, signal = $4, error = $5
         WHERE id = $6 AND status = 'running'`,
        [status, now, exitCode, signal, error ?? null, id]
      )
    );
    return (result.rowCount ?? 0) > 0;
  }

  async cancelJob(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.withClient((client) =>
      client.query(
        `UPDATE api_jobs
         SET status = 'cancelled', pid = NULL, finished_at = $1::timestamptz
         WHERE id = $2 AND status IN ('queued', 'running')`,
        [now, id]
      )
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resetRunningJobs(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.withClient((client) =>
      client.query(
        `UPDATE api_jobs
         SET status = 'interrupted', pid = NULL, finished_at = $1::timestamptz,
             error = COALESCE(error, 'server restarted while job was running')
         WHERE status = 'running'`,
        [now]
      )
    );
    return result.rowCount ?? 0;
  }

  async appendLog(jobId: string, stream: ApiJobLog["stream"], line: string): Promise<void> {
    const now = new Date().toISOString();
    await this.withClient((client) =>
      client.query(
        `INSERT INTO api_job_logs (job_id, stream, line, created_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [jobId, stream, line, now]
      )
    );
  }

  async getLogs(jobId: string): Promise<ApiJobLog[]> {
    return this.withClient(async (client) => {
      const result = await client.query<ApiJobLog>(
        `SELECT id, job_id, stream, line, created_at
         FROM api_job_logs
         WHERE job_id = $1
         ORDER BY id ASC`,
        [jobId]
      );
      return result.rows.map((row) => ({
        ...row,
        created_at: toIso(row.created_at)
      }));
    });
  }

  async saveArtifacts(
    jobId: string,
    artifacts: Array<Omit<ApiJobArtifact, "id" | "job_id" | "created_at">>
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.withTransaction(async (client) => {
      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO api_job_artifacts (job_id, name, path, size, mtime, created_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
          [jobId, artifact.name, artifact.path, artifact.size, artifact.mtime, now]
        );
      }
    });
  }

  async listArtifacts(jobId?: string): Promise<ApiJobArtifact[]> {
    return this.withClient(async (client) => {
      let result;
      if (jobId) {
        result = await client.query<ApiJobArtifactRow>(
          `SELECT id, job_id, name, path, size, mtime, created_at
           FROM api_job_artifacts
           WHERE job_id = $1
           ORDER BY created_at DESC`,
          [jobId]
        );
      } else {
        result = await client.query<ApiJobArtifactRow>(
          `SELECT id, job_id, name, path, size, mtime, created_at
           FROM api_job_artifacts
           ORDER BY created_at DESC
           LIMIT 1000`
        );
      }
      return result.rows.map((row) => ({
        ...row,
        mtime: toIso(row.mtime),
        created_at: toIso(row.created_at)
      }));
    });
  }

  async getArtifact(id: number): Promise<ApiJobArtifact | null> {
    return this.withClient(async (client) => {
      const result = await client.query<ApiJobArtifactRow>(
        `SELECT id, job_id, name, path, size, mtime, created_at
         FROM api_job_artifacts
         WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        ...row,
        mtime: toIso(row.mtime),
        created_at: toIso(row.created_at)
      };
    });
  }

  async countRunningJobs(): Promise<number> {
    return this.withClient(async (client) => {
      const result = await client.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM api_jobs WHERE status = 'running'"
      );
      return result.rows[0]?.n ?? 0;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pool.end().catch(() => undefined);
  }

  async closeAsync(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end().catch(() => undefined);
  }
}

interface ApiJobRow {
  id: string;
  type: ApiJob["type"];
  status: ApiJob["status"];
  command: string;
  args_json: string;
  request_json: string;
  cwd: string;
  pid: number | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
}

interface ApiJobArtifactRow {
  id: number;
  job_id: string;
  name: string;
  path: string;
  size: number;
  mtime: Date | string;
  created_at: Date | string;
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
    created_at: toIso(row.created_at),
    started_at: row.started_at ? toIso(row.started_at) : null,
    finished_at: row.finished_at ? toIso(row.finished_at) : null,
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

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(String(value)).toISOString();
}
