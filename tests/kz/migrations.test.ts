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

function columns(db: Database.Database, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((col) => col.name);
}
