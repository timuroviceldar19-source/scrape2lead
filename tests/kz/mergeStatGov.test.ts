import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { mergeStatGovData } from "../../scripts/merge-stat-gov-data.js";

describe("mergeStatGovData", () => {
  it("maps legal_status from stat.legal_status and leaves founder null", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE stat_gov_data (
        bin TEXT PRIMARY KEY,
        name TEXT,
        registration_date TEXT,
        oked TEXT,
        oked_name TEXT,
        director TEXT,
        legal_status TEXT,
        krp_name TEXT,
        kfs_name TEXT
      );
      CREATE TABLE leads (
        source TEXT,
        external_id TEXT,
        company_name TEXT,
        bin TEXT,
        registration_date TEXT,
        oked TEXT,
        oked_name TEXT,
        director TEXT,
        founder TEXT,
        legal_status TEXT,
        company_age_years INTEGER,
        legal_form TEXT
      );
      INSERT INTO stat_gov_data (
        bin, name, registration_date, oked, oked_name, director,
        legal_status, krp_name, kfs_name
      ) VALUES (
        '220540025781', 'ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "API-KZ"',
        '2022-05-18', '46610', 'Trade', 'Director',
        'unknown', 'Small business', 'Foreign individual ownership'
      );
      INSERT INTO leads (
        source, external_id, company_name, bin, founder, legal_status
      ) VALUES (
        '2gis', 'lead-1', 'API-KZ', '220540025781', 'old founder', 'Foreign individual ownership'
      );
    `);

    const stats = mergeStatGovData(db);
    const row = db.prepare("SELECT legal_status, legal_form, founder FROM leads").get() as {
      legal_status: string;
      legal_form: string;
      founder: string | null;
    };

    expect(stats).toEqual({ matched: 1, skipped: 0 });
    expect(row.legal_status).toBe("unknown");
    expect(row.legal_status).not.toBe("Foreign individual ownership");
    expect(row.legal_form).toBe("Foreign individual ownership");
    expect(row.founder).toBeNull();

    db.close();
  });
});
