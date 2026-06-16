/**
 * Postgres schema migrations.
 *
 * The SQLite default ships versioned migrations
 * (`src/storage/migrations.ts`) that incrementally rebuild the schema as the
 * TZ evolves. The Postgres implementation starts with the final TZ-aligned
 * shape in a single v1 migration — there is no legacy Postgres database to
 * upgrade from in this slice. Future schema changes should land here as
 * additive `version > 1` entries so the on-disk `schema_version` table keeps
 * a portable migration history.
 *
 * Schema shape mirrors the SQLite v4 final form with these TZ-prescribed
 * differences (see `docs/storage.md`):
 *  - `*_at` columns are `TIMESTAMPTZ` (the application still passes ISO-8601
 *    strings; the driver casts them on write and Postgres returns them as
 *    `Date` objects which we re-serialise to ISO strings to match the
 *    `IStorage` return contract).
 *  - JSON-shaped lead columns (`leads.phones`, `leads.social_links`,
 *    `leads.messenger_links`) are `JSONB` and accept/return JSON text on the
 *    wire.
 *  - `raw_snapshots.payload` is `TEXT` (not `JSONB`): callers store either a
 *    JSON-serialised body or an opaque HTML/text fragment such as
 *    `"<captcha/>"`, so the column must accept arbitrary strings byte-for-byte
 *    like the SQLite default. The `IStorage` contract types it as
 *    `string | null`.
 *  - `leads.incomplete` is `BOOLEAN`.
 *  - FK constraints are declared inline (Postgres enforces them
 *    unconditionally).
 */
import type { PoolClient } from "pg";

interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT (NOW())
      );

      CREATE TABLE IF NOT EXISTS parse_jobs (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL,
        city          TEXT NOT NULL,
        category      TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        total_found   INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL,
        finished_at   TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS company_tasks (
        id            BIGSERIAL PRIMARY KEY,
        parse_job_id  TEXT NOT NULL REFERENCES parse_jobs(id) ON DELETE CASCADE,
        source        TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        next_run_at   TIMESTAMPTZ,
        worker_id     TEXT,
        lease_until   TIMESTAMPTZ,
        last_error    TEXT,
        created_at    TIMESTAMPTZ NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL,
        UNIQUE (source, external_id, parse_job_id)
      );

      CREATE INDEX IF NOT EXISTS idx_company_tasks_claim
        ON company_tasks (parse_job_id, status, next_run_at, id);

      CREATE TABLE IF NOT EXISTS leads (
        source            TEXT NOT NULL,
        external_id       TEXT NOT NULL,
        company_name      TEXT NOT NULL,
        category          TEXT NOT NULL,
        city              TEXT NOT NULL,
        address           TEXT NOT NULL,
        phones            JSONB NOT NULL,
        email             TEXT,
        website           TEXT,
        social_links      JSONB NOT NULL,
        messenger_links   JSONB NOT NULL,
        parsed_at         TIMESTAMPTZ NOT NULL,
        incomplete        BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (source, external_id)
      );

      CREATE TABLE IF NOT EXISTS lead_phones (
        phone        TEXT PRIMARY KEY,
        source       TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        FOREIGN KEY (source, external_id)
          REFERENCES leads(source, external_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS raw_records (
        id            BIGSERIAL PRIMARY KEY,
        source        TEXT NOT NULL,
        external_id   TEXT,
        kind          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS parse_attempts (
        id                BIGSERIAL PRIMARY KEY,
        company_task_id   BIGINT REFERENCES company_tasks(id) ON DELETE SET NULL,
        job_id            TEXT,
        source            TEXT NOT NULL,
        external_id       TEXT,
        attempt_no        INTEGER,
        result            TEXT NOT NULL,
        error_type        TEXT,
        message           TEXT,
        proxy_id          TEXT,
        duration_ms       INTEGER,
        created_at        TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_parse_attempts_task
        ON parse_attempts (company_task_id, created_at);

      CREATE TABLE IF NOT EXISTS raw_snapshots (
        snapshot_id        BIGSERIAL PRIMARY KEY,
        company_task_id    BIGINT REFERENCES company_tasks(id) ON DELETE SET NULL,
        source             TEXT NOT NULL,
        external_id        TEXT,
        kind               TEXT NOT NULL,
        purpose            TEXT NOT NULL,
        payload            TEXT,
        payload_path       TEXT,
        created_at         TIMESTAMPTZ NOT NULL,
        updated_at         TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_raw_snapshots_purpose_time
        ON raw_snapshots (purpose, created_at, snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_raw_snapshots_task
        ON raw_snapshots (company_task_id);

      CREATE TABLE IF NOT EXISTS captcha_events (
        id                BIGSERIAL PRIMARY KEY,
        source            TEXT NOT NULL,
        url               TEXT,
        screenshot_path   TEXT,
        action            TEXT NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL,
        company_task_id   BIGINT REFERENCES company_tasks(id) ON DELETE SET NULL,
        snapshot_id       BIGINT REFERENCES raw_snapshots(snapshot_id) ON DELETE SET NULL,
        proxy_id          TEXT
      );

      CREATE TABLE IF NOT EXISTS proxy_history (
        id            BIGSERIAL PRIMARY KEY,
        proxy         TEXT,
        reason        TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL,
        proxy_channel TEXT,
        ip            TEXT,
        rotated_at    TIMESTAMPTZ,
        cards_on_ip   INTEGER
      );
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE leads ADD COLUMN bin TEXT;
      ALTER TABLE leads ADD COLUMN registration_date TEXT;
      ALTER TABLE leads ADD COLUMN oked TEXT;
      ALTER TABLE leads ADD COLUMN oked_name TEXT;
      ALTER TABLE leads ADD COLUMN director TEXT;
      ALTER TABLE leads ADD COLUMN founder TEXT;
      ALTER TABLE leads ADD COLUMN legal_status TEXT;
      ALTER TABLE leads ADD COLUMN company_age_years INTEGER;
      ALTER TABLE leads ADD COLUMN legal_form TEXT;
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS api_jobs (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        status      TEXT NOT NULL,
        command     TEXT NOT NULL,
        args_json   TEXT NOT NULL,
        request_json TEXT NOT NULL,
        cwd         TEXT NOT NULL,
        pid         INTEGER,
        created_at  TIMESTAMPTZ NOT NULL,
        started_at  TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        exit_code   INTEGER,
        signal      TEXT,
        error       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_api_jobs_status_created
        ON api_jobs (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS api_job_logs (
        id          BIGSERIAL PRIMARY KEY,
        job_id      TEXT NOT NULL REFERENCES api_jobs(id) ON DELETE CASCADE,
        stream      TEXT NOT NULL,
        line        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_job_logs_job_id
        ON api_job_logs (job_id, id ASC);

      CREATE TABLE IF NOT EXISTS api_job_artifacts (
        id          BIGSERIAL PRIMARY KEY,
        job_id      TEXT NOT NULL REFERENCES api_jobs(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        path        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        mtime       TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_job_artifacts_job_id
        ON api_job_artifacts (job_id);
    `
  }
];

/**
 * Apply any pending migrations against the supplied client. Safe to call
 * repeatedly: each migration is wrapped in its own transaction, the
 * `schema_version` table is read up-front, and statements are no-ops when
 * the target version is already applied.
 */
export async function runPostgresMigrations(client: PoolClient): Promise<void> {
  await client.query("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT (NOW()))");
  const current = await client.query<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_version");
  const currentVersion = current.rows[0]?.version ?? 0;
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  for (const migration of pending) {
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_version (version) VALUES ($1)", [migration.version]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Drop every application-owned table from the database. Intended for the
 * live-integration test only; never call this from runtime code.
 */
export async function dropAllTables(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS captcha_events CASCADE");
  await client.query("DROP TABLE IF EXISTS raw_snapshots CASCADE");
  await client.query("DROP TABLE IF EXISTS parse_attempts CASCADE");
  await client.query("DROP TABLE IF EXISTS raw_records CASCADE");
  await client.query("DROP TABLE IF EXISTS lead_phones CASCADE");
  await client.query("DROP TABLE IF EXISTS leads CASCADE");
  await client.query("DROP TABLE IF EXISTS proxy_history CASCADE");
  await client.query("DROP TABLE IF EXISTS company_tasks CASCADE");
  await client.query("DROP TABLE IF EXISTS parse_jobs CASCADE");
  await client.query("DROP TABLE IF EXISTS schema_version CASCADE");
}
