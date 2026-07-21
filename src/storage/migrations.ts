import type Database from "better-sqlite3";

interface Migration {
  version: number;
  sql?: string;
  run?: (db: Database.Database) => void;
}

const migrations: Migration[] = [
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
  },
  {
    version: 8,
    sql: `
      ALTER TABLE leads ADD COLUMN found_category TEXT;
    `
  },
  {
    version: 9,
    run: (db: Database.Database) => {
      const cols = db.prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === "found_name")) {
        db.exec("ALTER TABLE leads ADD COLUMN found_name TEXT");
      }
    }
  },
  {
    version: 10,
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
    version: 11,
    run: (db: Database.Database) => {
      ensureStatGovDataTable(db);
      ensureUnifiedTenderDataTable(db);
    }
  },
  {
    version: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS kz_enrich_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bin TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kz_enrich_errors_bin ON kz_enrich_errors(bin);
    `
  },
  {
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS goszakup_registry_data (
        bin TEXT PRIMARY KEY,
        participant_id TEXT,
        name_ru TEXT,
        name_kz TEXT,
        rnn TEXT,
        role TEXT,
        residency TEXT,
        phone TEXT,
        email TEXT,
        website TEXT,
        registration_date TEXT,
        last_update_date TEXT,
        kopf TEXT,
        ownership_form TEXT,
        economic_sector TEXT,
        director_name TEXT,
        director_iin TEXT,
        legal_address TEXT,
        location_address TEXT,
        registry_url TEXT,
        updated_at TEXT NOT NULL,
        raw_snapshot_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_goszakup_registry_participant ON goszakup_registry_data(participant_id);
    `
  },
  {
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS outreach_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        stats_json TEXT
      );

      CREATE TABLE IF NOT EXISTS outreach_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES outreach_runs(id),
        bin TEXT NOT NULL,
        tender_number TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('winner', 'prospect')),
        created_at TEXT NOT NULL,
        UNIQUE(bin, tender_number, kind)
      );

      CREATE INDEX IF NOT EXISTS idx_outreach_items_kind_bin ON outreach_items(kind, bin);
    `
  },
  {
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS api_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        request_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_api_jobs_status_created
        ON api_jobs (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS api_job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES api_jobs(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,
        line TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_job_logs_job_id
        ON api_job_logs (job_id, id ASC);

      CREATE TABLE IF NOT EXISTS api_job_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES api_jobs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_job_artifacts_job_id
        ON api_job_artifacts (job_id);
    `
  },
  {
    version: 16,
    run: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS outreach_seen (
          bin TEXT NOT NULL,
          tender_number TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('winner', 'prospect')),
          first_seen_at TEXT NOT NULL,
          PRIMARY KEY (bin, tender_number, kind)
        );
      `);

      if (tableExists(db, "outreach_items")) {
        db.exec(`
          INSERT OR IGNORE INTO outreach_seen (bin, tender_number, kind, first_seen_at)
          SELECT bin, tender_number, kind, MIN(created_at)
          FROM outreach_items
          GROUP BY bin, tender_number, kind;
        `);

        const runIdCol = (db.prepare("PRAGMA table_info(outreach_items)").all() as Array<{ name: string; notnull: number }>)
          .find((col) => col.name === "run_id");
        if (runIdCol?.notnull === 1) {
          db.exec(`
            CREATE TABLE outreach_items_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id INTEGER REFERENCES outreach_runs(id),
              bin TEXT NOT NULL,
              tender_number TEXT NOT NULL,
              kind TEXT NOT NULL CHECK (kind IN ('winner', 'prospect')),
              created_at TEXT NOT NULL,
              UNIQUE(bin, tender_number, kind)
            );

            INSERT INTO outreach_items_new (id, run_id, bin, tender_number, kind, created_at)
            SELECT id, run_id, bin, tender_number, kind, created_at
            FROM outreach_items;

            DROP TABLE outreach_items;
            ALTER TABLE outreach_items_new RENAME TO outreach_items;

            CREATE INDEX IF NOT EXISTS idx_outreach_items_kind_bin ON outreach_items(kind, bin);
          `);
        }
      }
    }
  },
  {
    version: 17,
    run: (db: Database.Database) => {
      if (!tableExists(db, "goszakup_registry_data")) return;
      const columns = new Set(getColumnNames(db, "goszakup_registry_data"));
      addColumnIfMissing(db, "goszakup_registry_data", columns, "full_address_ru", "TEXT");
      addColumnIfMissing(db, "goszakup_registry_data", columns, "reporting_administrator", "TEXT");
    }
  },
  {
    version: 18,
    sql: `
      CREATE TABLE IF NOT EXISTS procurement_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        record_kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        parent_external_id TEXT,
        status TEXT,
        product_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tru_code TEXT,
        customer_name TEXT,
        customer_bin TEXT,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'KZT',
        start_date TEXT,
        end_date TEXT,
        url TEXT NOT NULL,
        purchase_method TEXT,
        collected_at TEXT NOT NULL,
        UNIQUE(source, record_kind, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_procurement_records_parent ON procurement_records(source, parent_external_id);
      CREATE INDEX IF NOT EXISTS idx_procurement_records_bin ON procurement_records(customer_bin);
    `
  }
];

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

function getColumnNames(db: Database.Database, tableName: string): string[] {
  if (!tableExists(db, tableName)) return [];
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return cols.map((col) => col.name);
}

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columns: Set<string>,
  name: string,
  definition: string
): void {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

function ensureStatGovDataTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stat_gov_data (
      bin TEXT PRIMARY KEY,
      name TEXT,
      registration_date TEXT,
      oked TEXT,
      oked_name TEXT,
      address TEXT,
      director TEXT,
      legal_status TEXT,
      krp_code TEXT,
      krp_name TEXT,
      kfs_code TEXT,
      kfs_name TEXT,
      sector_code TEXT,
      sector_name TEXT,
      updated_at TEXT,
      raw_snapshot_path TEXT
    )
  `);

  const columns = new Set(getColumnNames(db, "stat_gov_data"));
  addColumnIfMissing(db, "stat_gov_data", columns, "name", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "registration_date", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "oked", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "oked_name", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "address", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "director", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "legal_status", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "krp_code", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "krp_name", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "kfs_code", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "kfs_name", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "sector_code", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "sector_name", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "updated_at", "TEXT");
  addColumnIfMissing(db, "stat_gov_data", columns, "raw_snapshot_path", "TEXT");
}

function ensureUnifiedTenderDataTable(db: Database.Database): void {
  if (!tableExists(db, "tender_data")) {
    createUnifiedTenderDataTable(db, "tender_data");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tender_data_bin ON tender_data(bin)");
    return;
  }

  const columns = getColumnNames(db, "tender_data");
  const needsRebuild =
    !columns.includes("source") ||
    !columns.includes("tender_number") ||
    !columns.includes("tender_name") ||
    !columns.includes("parsed_at") ||
    !hasUniqueTenderKey(db);

  if (!needsRebuild) {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tender_data_source_bin_number ON tender_data(source, bin, tender_number)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tender_data_bin ON tender_data(bin)");
    return;
  }

  const oldTable = `tender_data_old_${Date.now()}`;
  db.exec(`ALTER TABLE tender_data RENAME TO ${oldTable}`);
  createUnifiedTenderDataTable(db, "tender_data");

  const oldColumns = new Set(getColumnNames(db, oldTable));
  const value = (name: string, fallback: string): string =>
    oldColumns.has(name) ? name : fallback;

  db.exec(`
    INSERT OR IGNORE INTO tender_data (
      source, bin, tender_number, tender_name, customer_name, budget_amount,
      currency, start_date, end_date, status, method, url, parsed_at
    )
    SELECT
      ${oldColumns.has("source") ? "COALESCE(source, 'zakup.sk.kz')" : "'zakup.sk.kz'"},
      ${value("bin", "''")},
      ${value("tender_number", "''")},
      ${value("tender_name", "''")},
      ${value("customer_name", "NULL")},
      ${value("budget_amount", "NULL")},
      COALESCE(${value("currency", "NULL")}, 'KZT'),
      ${value("start_date", "NULL")},
      ${value("end_date", "NULL")},
      ${value("status", "NULL")},
      ${value("method", "NULL")},
      ${value("url", "NULL")},
      COALESCE(${value("parsed_at", "NULL")}, datetime('now'))
    FROM ${oldTable}
    WHERE COALESCE(${value("bin", "''")}, '') != ''
      AND COALESCE(${value("tender_number", "''")}, '') != ''
      AND COALESCE(${value("tender_name", "''")}, '') != ''
  `);

  db.exec(`DROP TABLE ${oldTable}`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_tender_data_bin ON tender_data(bin)");
}

function createUnifiedTenderDataTable(db: Database.Database, tableName: string): void {
  db.exec(`
    CREATE TABLE ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      bin TEXT NOT NULL,
      tender_number TEXT NOT NULL,
      tender_name TEXT NOT NULL,
      customer_name TEXT,
      budget_amount TEXT,
      currency TEXT DEFAULT 'KZT',
      start_date TEXT,
      end_date TEXT,
      status TEXT,
      method TEXT,
      url TEXT,
      parsed_at TEXT NOT NULL,
      UNIQUE(source, bin, tender_number)
    )
  `);
}

function hasUniqueTenderKey(db: Database.Database): boolean {
  const indexes = db.prepare("PRAGMA index_list(tender_data)").all() as Array<{ name: string; unique: number }>;
  for (const index of indexes) {
    if (!index.unique) continue;
    const columns = db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>;
    const names = columns.map((col) => col.name);
    if (names.join(",") === "source,bin,tender_number") return true;
  }
  return false;
}

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
        if (migration.run) {
          migration.run(db);
        } else if (migration.sql) {
          db.exec(migration.sql);
        }
        db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      })();
    }
  } finally {
    if (fkPrev) db.pragma("foreign_keys = ON");
  }
}
