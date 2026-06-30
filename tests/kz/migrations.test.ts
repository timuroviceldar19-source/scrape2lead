import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/storage/migrations.js";

describe("KZ v11 migration", () => {
  it("creates KZ tables on a fresh database", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const statColumns = columns(db, "stat_gov_data");
    const tenderColumns = columns(db, "tender_data");

    expect(statColumns).toContain("legal_status");
    expect(statColumns).toContain("raw_snapshot_path");
    expect(tenderColumns).toContain("source");
    expect(tenderColumns).toContain("tender_number");
    expect(columns(db, "kz_enrich_errors")).toContain("message");

    db.close();
  });

  it("rebuilds legacy tender_data without source as zakup.sk.kz rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_version (version, applied_at) VALUES (10, '2026-06-07T00:00:00.000Z');
      CREATE TABLE tender_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bin TEXT NOT NULL,
        tender_number TEXT NOT NULL,
        tender_name TEXT NOT NULL,
        customer_name TEXT,
        budget_amount TEXT,
        currency TEXT,
        start_date TEXT,
        end_date TEXT,
        status TEXT,
        method TEXT,
        lots_count TEXT,
        url TEXT,
        parsed_at TEXT NOT NULL,
        UNIQUE(bin, tender_number)
      );
      INSERT INTO tender_data (
        bin, tender_number, tender_name, customer_name, budget_amount,
        currency, start_date, end_date, status, method, lots_count, url, parsed_at
      ) VALUES (
        '220540025781', 'LOT-1', 'Legacy lot', 'API-KZ', '1000',
        'KZT', '2026-06-01', '2026-06-10', 'open', 'auction', '1', 'https://example.test', '2026-06-07T00:00:00.000Z'
      );
    `);

    runMigrations(db);

    const row = db.prepare("SELECT source, bin, tender_number FROM tender_data").get() as {
      source: string;
      bin: string;
      tender_number: string;
    };
    expect(row).toEqual({
      source: "zakup.sk.kz",
      bin: "220540025781",
      tender_number: "LOT-1"
    });

    db.close();
  });
});

describe("KZ v16 outreach retention ledger", () => {
  it("backfills outreach_seen from outreach_items and makes run_id nullable", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_version (version, applied_at) VALUES (15, '2026-06-17T00:00:00.000Z');

      CREATE TABLE outreach_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        stats_json TEXT
      );
      INSERT INTO outreach_runs (id, started_at, finished_at) VALUES (1, '2026-06-01T00:00:00.000Z', '2026-06-01T01:00:00.000Z');

      CREATE TABLE outreach_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES outreach_runs(id),
        bin TEXT NOT NULL,
        tender_number TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('winner', 'prospect')),
        created_at TEXT NOT NULL,
        UNIQUE(bin, tender_number, kind)
      );
      INSERT INTO outreach_items (run_id, bin, tender_number, kind, created_at) VALUES
        (1, '061040006408', 'CT-100', 'winner', '2026-06-01T10:00:00.000Z'),
        (1, '061040006408', 'CT-100', 'prospect', '2026-06-02T10:00:00.000Z');
    `);

    runMigrations(db);

    const seen = db.prepare("SELECT bin, tender_number, kind, first_seen_at FROM outreach_seen ORDER BY kind").all() as Array<{
      bin: string;
      tender_number: string;
      kind: string;
      first_seen_at: string;
    }>;
    expect(seen).toHaveLength(2);
    expect(seen.find((row) => row.kind === "winner")?.first_seen_at).toBe("2026-06-01T10:00:00.000Z");
    expect(seen.find((row) => row.kind === "prospect")?.first_seen_at).toBe("2026-06-02T10:00:00.000Z");

    const runIdCol = (db.prepare("PRAGMA table_info(outreach_items)").all() as Array<{ name: string; notnull: number }>)
      .find((col) => col.name === "run_id");
    expect(runIdCol?.notnull).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_items").get() as { count: number }).count).toBe(2);

    db.close();
  });

  it("keeps dedup pairs in outreach_seen after old runs are pruned", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const oldStarted = "2020-01-01T00:00:00.000Z";
    const oldFinished = "2020-01-01T01:00:00.000Z";
    const runId = Number(db.prepare(
      "INSERT INTO outreach_runs (started_at, finished_at) VALUES (?, ?)"
    ).run(oldStarted, oldFinished).lastInsertRowid);

    db.prepare(`
      INSERT INTO outreach_items (run_id, bin, tender_number, kind, created_at)
      VALUES (?, '061040006408', 'CT-OLD', 'winner', '2020-01-02T00:00:00.000Z')
    `).run(runId);
    db.prepare(`
      INSERT INTO outreach_seen (bin, tender_number, kind, first_seen_at)
      VALUES ('061040006408', 'CT-OLD', 'winner', '2020-01-02T00:00:00.000Z')
    `).run();

    db.prepare("UPDATE outreach_items SET run_id = NULL WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM outreach_runs WHERE id = ?").run(runId);

    expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_seen").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT run_id FROM outreach_items WHERE bin = '061040006408'").get() as { run_id: number | null }).run_id).toBeNull();

    db.close();
  });
});

function columns(db: Database.Database, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((col) => col.name);
}
