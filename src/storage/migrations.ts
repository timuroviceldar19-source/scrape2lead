import type Database from "better-sqlite3";

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leads (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        company_name TEXT NOT NULL,
        category TEXT NOT NULL,
        city TEXT NOT NULL,
        address TEXT NOT NULL,
        phones TEXT NOT NULL,
        email TEXT,
        website TEXT,
        social_links TEXT NOT NULL,
        messenger_links TEXT NOT NULL,
        parsed_at TEXT NOT NULL,
        incomplete INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source, external_id)
      );

      CREATE TABLE IF NOT EXISTS lead_phones (
        phone TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        FOREIGN KEY (source, external_id) REFERENCES leads(source, external_id)
      );

      CREATE TABLE IF NOT EXISTS raw_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        external_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS parse_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proxy_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS captcha_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        url TEXT,
        screenshot_path TEXT,
        action TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS parse_jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        city TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        total_found INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS company_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parse_job_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at TEXT,
        worker_id TEXT,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, external_id, parse_job_id),
        FOREIGN KEY (parse_job_id) REFERENCES parse_jobs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_company_tasks_claim
        ON company_tasks (parse_job_id, status, next_run_at, id);

      ALTER TABLE parse_attempts ADD COLUMN company_task_id INTEGER;
      ALTER TABLE parse_attempts ADD COLUMN attempt_no INTEGER;
      ALTER TABLE parse_attempts ADD COLUMN error_type TEXT;
      ALTER TABLE parse_attempts ADD COLUMN proxy_id TEXT;
      ALTER TABLE parse_attempts ADD COLUMN duration_ms INTEGER;
    `
  },
  {
    version: 3,
    sql: `
      -- 1) Rebuild parse_attempts: job_id becomes nullable, status renamed to result,
      --    company_task_id is the primary FK on company_tasks.
      CREATE TABLE parse_attempts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_task_id INTEGER REFERENCES company_tasks(id) ON DELETE SET NULL,
        job_id TEXT,
        source TEXT NOT NULL,
        external_id TEXT,
        attempt_no INTEGER,
        result TEXT NOT NULL,
        error_type TEXT,
        message TEXT,
        proxy_id TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );

      INSERT INTO parse_attempts_new
        (id, company_task_id, job_id, source, external_id, attempt_no,
         result, error_type, message, proxy_id, duration_ms, created_at)
      SELECT id, company_task_id, job_id, source, external_id, attempt_no,
             status, error_type, message, proxy_id, duration_ms, created_at
      FROM parse_attempts;

      DROP TABLE parse_attempts;
      ALTER TABLE parse_attempts_new RENAME TO parse_attempts;

      CREATE INDEX idx_parse_attempts_task
        ON parse_attempts (company_task_id, created_at);

      -- 2) raw_snapshots: structured snapshot table per TZ §3.7 / §3.11.
      CREATE TABLE raw_snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_task_id INTEGER REFERENCES company_tasks(id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        external_id TEXT,
        kind TEXT NOT NULL,
        purpose TEXT NOT NULL,
        payload TEXT,
        payload_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_raw_snapshots_purpose_time
        ON raw_snapshots (purpose, created_at, snapshot_id);
      CREATE INDEX idx_raw_snapshots_task
        ON raw_snapshots (company_task_id);

      -- 3) captcha_events: TZ-aligned columns.
      ALTER TABLE captcha_events ADD COLUMN company_task_id INTEGER;
      ALTER TABLE captcha_events ADD COLUMN proxy_id TEXT;
      ALTER TABLE captcha_events ADD COLUMN snapshot_id INTEGER;

      -- 4) proxy_history: TZ-aligned columns.
      ALTER TABLE proxy_history ADD COLUMN proxy_channel TEXT;
      ALTER TABLE proxy_history ADD COLUMN ip TEXT;
      ALTER TABLE proxy_history ADD COLUMN rotated_at TEXT;
      ALTER TABLE proxy_history ADD COLUMN cards_on_ip INTEGER;
    `
  },
  {
    version: 4,
    sql: `
      -- Rebuild captcha_events with proper FK constraints.
      -- SQLite ALTER TABLE ADD COLUMN cannot carry FK definitions,
      -- so we recreate the table to enforce ON DELETE SET NULL.
      CREATE TABLE captcha_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        url TEXT,
        screenshot_path TEXT,
        action TEXT NOT NULL,
        created_at TEXT NOT NULL,
        company_task_id INTEGER REFERENCES company_tasks(id) ON DELETE SET NULL,
        snapshot_id INTEGER REFERENCES raw_snapshots(snapshot_id) ON DELETE SET NULL,
        proxy_id TEXT
      );

      INSERT INTO captcha_events_new
        (id, source, url, screenshot_path, action, created_at,
         company_task_id, snapshot_id, proxy_id)
      SELECT id, source, url, screenshot_path, action, created_at,
             company_task_id, snapshot_id, proxy_id
      FROM captcha_events;

      DROP TABLE captcha_events;
      ALTER TABLE captcha_events_new RENAME TO captcha_events;
    `
  },
  {
    version: 5,
    sql: `
      -- Add Kaspi-specific lead quality and metadata columns
      ALTER TABLE leads ADD COLUMN rating REAL;
      ALTER TABLE leads ADD COLUMN review_count INTEGER;
      ALTER TABLE leads ADD COLUMN product_count INTEGER;
      ALTER TABLE leads ADD COLUMN shop_categories TEXT;
    `
  },
  {
    version: 6,
    sql: `
      -- Add CRM-ready enrichment columns
      ALTER TABLE leads ADD COLUMN lead_id TEXT;
      ALTER TABLE leads ADD COLUMN source_search_city TEXT;
      ALTER TABLE leads ADD COLUMN merchant_city_guess TEXT;
      ALTER TABLE leads ADD COLUMN city_status TEXT;
      ALTER TABLE leads ADD COLUMN address_raw TEXT;
      ALTER TABLE leads ADD COLUMN address_clean TEXT;
      ALTER TABLE leads ADD COLUMN phone_raw TEXT;
      ALTER TABLE leads ADD COLUMN phone_normalized TEXT;
      ALTER TABLE leads ADD COLUMN phone_status TEXT;
      ALTER TABLE leads ADD COLUMN email_raw TEXT;
      ALTER TABLE leads ADD COLUMN email_status TEXT;
      ALTER TABLE leads ADD COLUMN kaspi_profile_url TEXT;
      ALTER TABLE leads ADD COLUMN real_website TEXT;
      ALTER TABLE leads ADD COLUMN messenger_flags TEXT;
      ALTER TABLE leads ADD COLUMN lead_score INTEGER;
      ALTER TABLE leads ADD COLUMN priority TEXT;
      ALTER TABLE leads ADD COLUMN contactability TEXT;
      ALTER TABLE leads ADD COLUMN crm_status TEXT;
      ALTER TABLE leads ADD COLUMN next_action TEXT;
      ALTER TABLE leads ADD COLUMN parser_note TEXT;
    `
  },
  {
    version: 7,
    sql: `
      -- Add enrichment tracking and stricter validation status columns
      ALTER TABLE leads ADD COLUMN address_status TEXT;
      ALTER TABLE leads ADD COLUMN website_status TEXT;
      ALTER TABLE leads ADD COLUMN enrichment_source TEXT;
      ALTER TABLE leads ADD COLUMN enrichment_url TEXT;
      ALTER TABLE leads ADD COLUMN confidence_score REAL;
      ALTER TABLE leads ADD COLUMN enrichment_status TEXT;
      ALTER TABLE leads ADD COLUMN enrichment_attempted_at TEXT;
      ALTER TABLE leads ADD COLUMN enrichment_error TEXT;
    `
  }
];

export function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as { version: number | null };
  const currentVersion = current.version ?? 0;
  const pending = migrations.filter((item) => item.version > currentVersion);
  if (pending.length === 0) return;

  // Disable foreign keys during migrations so table rebuilds (e.g. parse_attempts v3)
  // are safe even when other tables reference them. PRAGMA cannot run inside a txn.
  const fkPrev = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  if (fkPrev) db.pragma("foreign_keys = OFF");
  try {
    for (const migration of pending) {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      })();
    }
  } finally {
    if (fkPrev) db.pragma("foreign_keys = ON");
  }
}
