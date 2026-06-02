# Storage Layer & Postgres Migration Path

The runtime/core modules depend on a narrow `IStorage` contract
(`src/storage/interface.ts`). The default in-tree implementation is the
SQLite-backed `Storage` class (`src/storage/storage.ts`); a
Postgres-backed `PostgresStorage` is shipped at
`src/storage/postgres/PostgresStorage.ts` and selected via
`STORAGE_BACKEND=postgres`.

This document describes the two implementations and the
SQLite-specific behaviours the Postgres port re-implements.

## Where the Postgres implementation lives

```
src/storage/
  interface.ts              ← IStorage contract (shared)
  storage.ts                ← SQLite default (implements IStorage)
  migrations.ts             ← SQLite migrations (default)
  postgres/
    PostgresStorage.ts      ← Postgres impl (implements IStorage)
    migrations.ts           ← Postgres schema migrations
    sql.ts                  ← Named SQL fragments (contract tests)
```

`PostgresStorage` uses the `pg` client and accepts an optional
`{ rawSnapshotDir, pool }` second argument. Pool options are forwarded
to `pg.Pool` as-is so callers can set `ssl`, `max`, `idleTimeoutMillis`,
etc.

## CLI / config

The CLI's `buildStorage()` is the single point of change:

```ts
function buildStorage(config: RuntimeConfig): IStorage {
  switch (config.storageBackend) {
    case "postgres":
      if (!config.postgresConnectionString) {
        throw new Error("STORAGE_BACKEND=postgres requires postgresConnectionString");
      }
      return new PostgresStorage(
        config.postgresConnectionString,
        { rawSnapshotDir: config.rawSnapshotDir }
      );
    case "sqlite":
    default:
      return new Storage(config.databasePath, config.rawSnapshotDir);
  }
}
```

Selection precedence is `STORAGE_BACKEND` env var > `storageBackend`
config field. The default is `sqlite`, so the existing CLI surface and
`config.example.json` keep working without changes.

`RuntimeConfig` exposes two new fields:

- `storageBackend: "sqlite" | "postgres"` — defaults to `"sqlite"`.
- `postgresConnectionString: string | null` — required when
  `storageBackend === "postgres"`.

`config.example.json` includes both with explanatory comments; the
`.env.example` mirrors them as `STORAGE_BACKEND` and
`POSTGRES_CONNECTION_STRING`.

## What the Postgres implementation does

`IStorage` is intentionally narrow: it covers only the methods
`JobManager`, `ProxyRotator`, and the CLI actually call. Legacy
helpers on the SQLite `Storage` class (`saveRaw`, `listRawSnapshots`,
`getRawSnapshot`, `readRawSnapshotContent`, `cleanupRecentSnapshots`,
`cleanupSnapshotsOlderThan`, `saveProxyEvent`) are **not** part of the
contract — Postgres keeps the `IStorage` surface only.

### Method-by-method expectations

- **`createParseJob`** — returns a fresh `id` in the same
  `${source}-${ms}-${rand}` format the SQLite default uses, so the
  CLI's `jobId` output and the on-disk `exports/` filenames stay
  identical.
- **`findResumableParseJob`** — same input triple, same "most recent
  non-terminal" rule. Postgres `ORDER BY created_at DESC LIMIT 1`.
- **`claimNextTask`** — runs `SELECT ... FOR UPDATE SKIP LOCKED` plus
  a guarded `UPDATE` inside a transaction. See "Atomic claim" below.
- **`markTask*` / `scheduleTaskRetry`** — the SQLite
  `transitionFromProcessing` guard (`WHERE status = 'processing'`) and
  one-way terminal semantics are preserved exactly. The Postgres
  UPDATE uses the same predicate.
- **`recoverExpiredLeases`** — bulk transition of
  `status='processing' AND lease_until <= now()` rows to
  `retry_scheduled`.
- **`saveAttempt`** — `result` is a string column; `job_id` is
  nullable. Postgres `TEXT` is used; `result` is the value of
  `attempt.status` (the rename happened in the SQLite v3 migration —
  Postgres v1 starts with the correct shape).
- **`saveRawSnapshot` / `readRawSnapshotContent`** — inline `payload`
  is `JSONB`. The on-disk `payload_path` fallback writes the same way
  as SQLite when `rawSnapshotDir` is configured.
- **`saveCaptchaEvent` / `saveProxyRotation`** — straightforward
  inserts returning the new id via `RETURNING id`.
- **`getJobTelemetry`** — same SQL shape as the SQLite version
  (`computeJobTelemetry` in `src/core/telemetry.ts`). The Postgres
  implementation inlines equivalent `SELECT ... GROUP BY` queries.
- **`close`** — detaches `pool.end()`. The public `close()` is sync
  and never throws; an internal `closeAsync()` is provided for tests
  that want to await pool drain.

## SQLite-specific behaviour re-implemented in Postgres

### `BEGIN IMMEDIATE` (atomic task claim)

`Storage.claimNextTask` runs inside `db.transaction(...).immediate()`,
which acquires SQLite's reserved lock before the SELECT. The
Postgres implementation uses:

- `SELECT ... FOR UPDATE SKIP LOCKED` on the candidate task row,
  inside a `BEGIN; ... COMMIT;` transaction.
- `ORDER BY id ASC LIMIT 1` to match the SQLite claim order.
- `SKIP LOCKED` is the Postgres idiom for queue workers — it avoids
  the head-of-line blocking that `FOR UPDATE` alone would cause.

The SELECT and the guarded UPDATE run in the same transaction; they
are never split across auto-committed statements.

### `last_insert_rowid()`

The SQLite default uses `result.lastInsertRowid` to surface new IDs.
Postgres uses `INSERT ... RETURNING <id>` for `enqueueCompanyTask`,
`saveCaptchaEvent`, and `saveRawSnapshot`.

`enqueueCompanyTask` uses `ON CONFLICT DO NOTHING RETURNING id` and
falls back to a second `SELECT id ...` if the conflict path returns no
row, exactly mirroring the SQLite behaviour.

### PRAGMAs

- `PRAGMA journal_mode = WAL` — Postgres has WAL natively; nothing to
  do at the application layer.
- `PRAGMA foreign_keys = ON` — Postgres enforces FK constraints
  unconditionally. The Postgres migration defines them inline.
- `PRAGMA foreign_keys = OFF` is used inside the SQLite migration
  runner to allow table-rebuild migrations. Postgres does not need
  this; the migration runs against a fresh `schema_version` table.

### JSON / text payload handling

- `leads.phones`, `leads.social_links`, `leads.messenger_links` and
  `raw_snapshots.payload` are `JSONB` columns in Postgres. The
  application still passes JSON strings; the implementation casts
  with `?::jsonb` and reads back via `::text` so the public surface
  stays a string.
- `Lead.phones` (string array) — same shape as SQLite. No
  `lead_phones` lookup table; the JSONB array is the canonical
  representation.

### Booleans and dates

- `leads.incomplete` is `BOOLEAN NOT NULL DEFAULT FALSE` in Postgres.
  The implementation maps the SQLite `0/1` ↔ `false/true` convention
  inside the SQL casts.
- All `*_at` columns are `TIMESTAMPTZ`. The application passes ISO
  strings; a thin `?::timestamptz` cast keeps the public surface the
  same. Return values are converted back to ISO-8601 strings to
  match `IStorage` signatures.

### Migrations

`src/storage/postgres/migrations.ts` ships a single v1 migration
landing the full TZ-aligned schema. Because there is no legacy
Postgres DB to upgrade from, future changes should land as additive
`version > 1` entries that follow the same `schema_version` table
convention as the SQLite runner.

`PostgresStorage` exposes `ensureMigrated()` and `dropAllTables()`
helpers. The CLI calls `ensureMigrated()` on startup (fire-and-forget
log message — first-touch is lazy). Tests use `dropAllTables()` for
isolation.

## Tests

- `tests/postgresSql.test.ts` — unit/contract test asserting
  `POSTGRES_SQL` fragments and that `PostgresStorage` construction
  does not require a live DB.
- `tests/postgresLive.test.ts` — live integration test gated by the
  `POSTGRES_TEST_URL` env var. When unset, the test skips; when set,
  it provisions a clean schema, exercises the full `IStorage`
  surface, and verifies the FK `ON DELETE SET NULL` behaviour on
  `captcha_events` and `raw_snapshots`.

Run live integration locally with:

```sh
POSTGRES_TEST_URL=postgres://user:pass@localhost:5432/scrape2lead_test \
  npx vitest run tests/postgresLive.test.ts
```
