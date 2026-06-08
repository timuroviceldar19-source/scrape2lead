/**
 * Postgres SQL fragments used by {@link PostgresStorage}.
 *
 * These are exposed as a single object so tests can assert on the exact
 * statements that go on the wire without spinning up a live database. The
 * fragments are intentionally named (`CLAIM_NEXT_TASK_SQL`,
 * `ENQUEUE_COMPANY_TASK_SQL`, etc.) so a contract test can lock them down.
 */
export const POSTGRES_SQL = {
  // --- parse_jobs lifecycle ---
  CREATE_PARSE_JOB: `
    INSERT INTO parse_jobs (id, source, city, category, status, total_found, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'running', 0, $5::timestamptz, $6::timestamptz)
  `,

  UPDATE_PARSE_JOB_TOTAL_FOUND: `
    UPDATE parse_jobs SET total_found = $1, updated_at = $2::timestamptz WHERE id = $3
  `,

  SET_PARSE_JOB_STATUS: `
    UPDATE parse_jobs
       SET status = $1,
           updated_at = $2::timestamptz,
           finished_at = COALESCE($3::timestamptz, finished_at)
     WHERE id = $4
  `,

  GET_PARSE_JOB: `SELECT * FROM parse_jobs WHERE id = $1`,

  FIND_RESUMABLE_PARSE_JOB: `
    SELECT * FROM parse_jobs
     WHERE source = $1 AND city = $2 AND category = $3
       AND status NOT IN ('completed', 'failed')
     ORDER BY created_at DESC
     LIMIT 1
  `,

  // --- company_tasks queue / state ---
  ENQUEUE_COMPANY_TASK: `
    INSERT INTO company_tasks (parse_job_id, source, external_id, status, attempts, created_at, updated_at)
    VALUES ($1, $2, $3, 'pending', 0, $4::timestamptz, $5::timestamptz)
    ON CONFLICT (source, external_id, parse_job_id) DO NOTHING
    RETURNING id
  `,

  ENQUEUE_COMPANY_TASK_FALLBACK_SELECT: `
    SELECT id FROM company_tasks
     WHERE source = $1 AND external_id = $2 AND parse_job_id = $3
  `,

  // claimNextTask is wrapped in a transaction by the caller; SELECT ... FOR
  // UPDATE SKIP LOCKED is the queue-worker idiom that mirrors SQLite's
  // `db.transaction(...).immediate()` reservation.
  CLAIM_NEXT_TASK_SELECT: `
    SELECT id, parse_job_id, source, external_id, status, attempts, next_run_at,
           worker_id, lease_until, last_error, created_at, updated_at
      FROM company_tasks
     WHERE parse_job_id = $1
       AND status IN ('pending', 'retry_scheduled')
       AND (next_run_at IS NULL OR next_run_at <= $2::timestamptz)
     ORDER BY id ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  `,

  CLAIM_NEXT_TASK_UPDATE: `
    UPDATE company_tasks
       SET status = 'processing',
           worker_id = $1,
           lease_until = $2::timestamptz,
           attempts = attempts + 1,
           updated_at = $3::timestamptz
     WHERE id = $4
       AND status IN ('pending', 'retry_scheduled')
  `,

  COUNT_OPEN_TASKS: `
    SELECT COUNT(*)::int AS n FROM company_tasks
     WHERE parse_job_id = $1
       AND status IN ('pending', 'processing', 'retry_scheduled', 'blocked')
  `,

  LIST_COMPANY_TASKS: `
    SELECT id, parse_job_id, source, external_id, status, attempts, next_run_at,
           worker_id, lease_until, last_error, created_at, updated_at
      FROM company_tasks
     WHERE parse_job_id = $1
     ORDER BY id ASC
  `,

  // markTask* — one-way terminal transitions guarded by `status = 'processing'`.
  TRANSITION_FROM_PROCESSING: `
    UPDATE company_tasks
       SET status = $1,
           worker_id = NULL,
           lease_until = NULL,
           last_error = $2,
           updated_at = $3::timestamptz
     WHERE id = $4
       AND status = 'processing'
  `,

  MARK_TASK_BLOCKED: `
    UPDATE company_tasks
       SET status = 'blocked',
           last_error = $1,
           lease_until = NULL,
           updated_at = $2::timestamptz
     WHERE id = $3
       AND status = 'processing'
  `,

  SCHEDULE_TASK_RETRY: `
    UPDATE company_tasks
       SET status = 'retry_scheduled',
           worker_id = NULL,
           lease_until = NULL,
           next_run_at = $1::timestamptz,
           last_error = $2,
           updated_at = $3::timestamptz
     WHERE id = $4
       AND status IN ('processing', 'blocked')
  `,

  RECOVER_EXPIRED_LEASES: `
    UPDATE company_tasks
       SET status = 'retry_scheduled',
           worker_id = NULL,
           lease_until = NULL,
           next_run_at = $1::timestamptz,
           last_error = COALESCE(last_error, 'lease expired'),
           updated_at = $2::timestamptz
     WHERE status = 'processing'
       AND lease_until IS NOT NULL
       AND lease_until <= $3::timestamptz
  `,

  // --- leads / attempts / events ---
  UPSERT_LEAD: `
    INSERT INTO leads (
      source, external_id, company_name, category, city, address,
      phones, email, website, social_links, messenger_links,
      parsed_at, incomplete,
      bin, registration_date, oked, oked_name, director, founder,
      legal_status, company_age_years, legal_form
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7::jsonb, $8, $9, $10::jsonb, $11::jsonb,
      $12::timestamptz, $13,
      $14, $15, $16, $17, $18, $19,
      $20, $21, $22
    )
    ON CONFLICT (source, external_id) DO UPDATE SET
      company_name    = EXCLUDED.company_name,
      category        = EXCLUDED.category,
      city            = EXCLUDED.city,
      address         = EXCLUDED.address,
      phones          = EXCLUDED.phones,
      email           = EXCLUDED.email,
      website         = EXCLUDED.website,
      social_links    = EXCLUDED.social_links,
      messenger_links = EXCLUDED.messenger_links,
      parsed_at       = EXCLUDED.parsed_at,
      incomplete      = EXCLUDED.incomplete,
      bin             = EXCLUDED.bin,
      registration_date = EXCLUDED.registration_date,
      oked            = EXCLUDED.oked,
      oked_name       = EXCLUDED.oked_name,
      director        = EXCLUDED.director,
      founder         = EXCLUDED.founder,
      legal_status    = EXCLUDED.legal_status,
      company_age_years = EXCLUDED.company_age_years,
      legal_form      = EXCLUDED.legal_form
  `,

  LIST_LEADS: `SELECT * FROM leads ORDER BY company_name ASC`,

  SAVE_ATTEMPT: `
    INSERT INTO parse_attempts (
      company_task_id, job_id, source, external_id, attempt_no,
      result, error_type, message, proxy_id, duration_ms, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
  `,

  COUNT_PARSE_ATTEMPTS: `
    SELECT COUNT(*)::int AS n FROM parse_attempts
     WHERE company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = $1)
  `,

  SAVE_CAPTCHA_EVENT: `
    INSERT INTO captcha_events
      (source, url, screenshot_path, action, created_at,
       company_task_id, proxy_id, snapshot_id)
    VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)
    RETURNING id
  `,

  // `payload` is a TEXT column (see migrations.ts): bind the value as a plain
  // string so opaque HTML/text bodies such as "<captcha/>" — which are not
  // valid JSON — are stored verbatim, matching the SQLite default.
  SAVE_RAW_SNAPSHOT: `
    INSERT INTO raw_snapshots
      (company_task_id, source, external_id, kind, purpose,
       payload, payload_path, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
    RETURNING snapshot_id
  `,

  UPDATE_RAW_SNAPSHOT_PATH: `
    UPDATE raw_snapshots SET payload_path = $1 WHERE snapshot_id = $2
  `,

  SAVE_PROXY_ROTATION: `
    INSERT INTO proxy_history
      (proxy, reason, created_at, proxy_channel, ip, rotated_at, cards_on_ip)
    VALUES ($1, $2, $3::timestamptz, $4, $5, $6::timestamptz, $7)
  `
} as const;
