import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { mergeLeadsWithKz, writeKzToLeads } from "../../src/kz/leadKzMerge.js";
import { scoreCompanyCards } from "../../src/kz/kzLeadScore.js";
import { KzStorage } from "../../src/kz/kzStorage.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  const storage = new KzStorage({ db });
  return db;
}

function insertLead(db: Database.Database, source: string, externalId: string, companyName: string, bin: string | null): void {
  db.prepare(`
    INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(source, externalId, companyName, bin, "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");
}

describe("leadKzMerge", () => {
  it("matches lead by exact bin", () => {
    const db = createTestDb();
    insertLead(db, "2gis", "123", "ТОО ALAU", "061040006408");
    db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("061040006408", "ТОО ALAU", "2010-05-15", "47111", "Retail", "Almaty", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);

    const storage = new KzStorage({ db });
    const cards = scoreCompanyCards(storage.getCompanyCards());
    const { matches, stats } = mergeLeadsWithKz(db, cards);

    expect(matches).toHaveLength(1);
    expect(matches[0].match_type).toBe("exact_bin");
    expect(matches[0].kz_bin).toBe("061040006408");
    expect(matches[0].stat_gov?.name).toBe("ТОО ALAU");
    expect(stats.matched_exact).toBe(1);
    expect(stats.with_bin).toBe(1);
    db.close();
  });

  it("matches lead by fuzzy name when bin is missing", () => {
    const db = createTestDb();
    insertLead(db, "2gis", "456", 'ТОО "ALAU"', null);
    db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("061040006408", "ТОО ALAU", "2010-05-15", "47111", "Retail", "Almaty", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);

    const storage = new KzStorage({ db });
    const cards = scoreCompanyCards(storage.getCompanyCards());
    const { matches, stats } = mergeLeadsWithKz(db, cards);

    expect(matches).toHaveLength(1);
    expect(matches[0].match_type).toBe("fuzzy_name_stat");
    expect(matches[0].kz_bin).toBe("061040006408");
    expect(matches[0].match_score).toBeGreaterThan(0.7);
    expect(stats.matched_fuzzy_stat).toBe(1);
    db.close();
  });

  it("falls back to registry when stat is missing", () => {
    const db = createTestDb();
    insertLead(db, "2gis", "789", "ТОО BETA", null);
    db.prepare("INSERT INTO goszakup_registry_data (bin, participant_id, name_ru, name_kz, rnn, role, residency, phone, email, website, registration_date, last_update_date, kopf, ownership_form, economic_sector, director_name, director_iin, legal_address, location_address, registry_url, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("990940012345", "12345", "ТОО BETA", null, null, "Поставщик", null, "+77071234567", "beta@mail.ru", null, null, null, null, null, null, "Petrov", null, null, null, null, "2026-01-01", null);

    const storage = new KzStorage({ db });
    const cards = scoreCompanyCards(storage.getCompanyCards());
    const { matches, stats } = mergeLeadsWithKz(db, cards);

    expect(matches).toHaveLength(1);
    expect(matches[0].match_type).toBe("fuzzy_name_registry");
    expect(matches[0].kz_bin).toBe("990940012345");
    expect(matches[0].registry?.phone).toBe("+77071234567");
    expect(stats.matched_fuzzy_registry).toBe(1);
    db.close();
  });

  it("writeKzToLeads updates lead fields from stat_gov", () => {
    const db = createTestDb();
    insertLead(db, "2gis", "123", "ТОО ALAU", null);
    db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("061040006408", "ТОО ALAU", "2010-05-15", "47111", "Retail", "Almaty", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);

    const storage = new KzStorage({ db });
    const cards = scoreCompanyCards(storage.getCompanyCards());
    const { matches } = mergeLeadsWithKz(db, cards);

    const updated = writeKzToLeads(db, matches);
    expect(updated).toBe(1);

    const lead = db.prepare("SELECT * FROM leads WHERE external_id = ?").get("123") as Record<string, unknown>;
    expect(lead.bin).toBe("061040006408");
    expect(lead.registration_date).toBe("2010-05-15");
    expect(lead.oked).toBe("47111");
    expect(lead.director).toBe("Ivanov");
    expect(lead.legal_status).toBe("active");
    expect(lead.legal_form).toBe("ТОО");
    db.close();
  });
});
