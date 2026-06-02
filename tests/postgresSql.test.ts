import { describe, it, expect } from "vitest";
import { POSTGRES_SQL } from "../src/storage/postgres/sql.js";
import { PostgresStorage } from "../src/storage/postgres/PostgresStorage.js";
import { runPostgresMigrations, dropAllTables } from "../src/storage/postgres/migrations.js";

describe("POSTGRES_SQL fragments", () => {
  it("claimNextTask uses FOR UPDATE SKIP LOCKED and id-ascending order", () => {
    expect(POSTGRES_SQL.CLAIM_NEXT_TASK_SELECT).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(POSTGRES_SQL.CLAIM_NEXT_TASK_SELECT).toMatch(/ORDER BY\s+id ASC\s+LIMIT 1/);
  });

  it("enqueueCompanyTask uses ON CONFLICT DO NOTHING RETURNING id", () => {
    expect(POSTGRES_SQL.ENQUEUE_COMPANY_TASK).toMatch(
      /ON CONFLICT \(source, external_id, parse_job_id\) DO NOTHING/
    );
    expect(POSTGRES_SQL.ENQUEUE_COMPANY_TASK).toMatch(/RETURNING id/);
  });

  it("terminal transitions guard on status='processing'", () => {
    expect(POSTGRES_SQL.TRANSITION_FROM_PROCESSING).toMatch(/status = 'processing'/);
  });

  it("markTaskBlocked guards on status='processing'", () => {
    expect(POSTGRES_SQL.MARK_TASK_BLOCKED).toMatch(/status = 'processing'/);
  });

  it("scheduleTaskRetry allows processing or blocked origin", () => {
    expect(POSTGRES_SQL.SCHEDULE_TASK_RETRY).toMatch(
      /status IN \('processing', 'blocked'\)/
    );
  });

  it("recoverExpiredLeases only touches processing rows with expired leases", () => {
    expect(POSTGRES_SQL.RECOVER_EXPIRED_LEASES).toMatch(/status = 'processing'/);
    expect(POSTGRES_SQL.RECOVER_EXPIRED_LEASES).toMatch(/lease_until IS NOT NULL/);
    expect(POSTGRES_SQL.RECOVER_EXPIRED_LEASES).toMatch(/lease_until <= \$3::timestamptz/);
  });

  it("upsertLead uses JSONB casts for array columns", () => {
    expect(POSTGRES_SQL.UPSERT_LEAD).toMatch(/\$7::jsonb/);
    expect(POSTGRES_SQL.UPSERT_LEAD).toMatch(/\$10::jsonb/);
    expect(POSTGRES_SQL.UPSERT_LEAD).toMatch(/\$11::jsonb/);
  });

  it("saveRawSnapshot returns snapshot_id and binds payload as TEXT (no jsonb cast)", () => {
    expect(POSTGRES_SQL.SAVE_RAW_SNAPSHOT).toMatch(/RETURNING snapshot_id/);
    // payload is a TEXT column so opaque non-JSON bodies (e.g. "<captcha/>")
    // store verbatim; the bind must NOT carry a ::jsonb cast.
    expect(POSTGRES_SQL.SAVE_RAW_SNAPSHOT).not.toMatch(/\$6::jsonb/);
    expect(POSTGRES_SQL.SAVE_RAW_SNAPSHOT).toMatch(/payload, payload_path/);
  });

  it("saveCaptchaEvent returns id", () => {
    expect(POSTGRES_SQL.SAVE_CAPTCHA_EVENT).toMatch(/RETURNING id/);
  });
});

describe("PostgresStorage construction", () => {
  it("does not require a live DB to construct", () => {
    const storage = new PostgresStorage("postgres://user:pass@localhost:5432/db");
    expect(typeof storage.close).toBe("function");
    expect(typeof storage.closeAsync).toBe("function");
    expect(typeof storage.ensureMigrated).toBe("function");
    expect(typeof storage.dropAllTables).toBe("function");
  });

  it("accepts rawSnapshotDir option", () => {
    const storage = new PostgresStorage("postgres://user:pass@localhost:5432/db", {
      rawSnapshotDir: "/tmp/raw"
    });
    expect(storage).toBeInstanceOf(PostgresStorage);
  });

  it("exposes static migration helpers", () => {
    expect(typeof runPostgresMigrations).toBe("function");
    expect(typeof dropAllTables).toBe("function");
  });
});
