import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  backfillBinsFromMatches,
  backfillLeadBins,
  mergeLeadsWithKz,
  scrubInvalidLeadBins
} from "../../src/kz/leadKzMerge.js";
import { scoreCompanyCards } from "../../src/kz/kzLeadScore.js";
import { KzStorage } from "../../src/kz/kzStorage.js";

describe("backfillLeadBins", () => {
  it("prefers higher-priority company cards when multiple names match", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    try {
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "1", "ТОО ALAU BUILD", null, "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");

      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("061040006408", "ТОО ALAU", "2010-05-15", "47111", "Retail", "Almaty", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);
      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("990940012345", "ТОО ALAU BUILD", "2015-03-20", "62010", "Software", "Astana", "Petrov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);
      db.prepare("INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("goszakup.gov.kz", "990940012345", "T-003", "Big tender", "Customer", "60000000", "KZT", "2026-01-01", "2026-12-31", "Действует", "auction", null, "2026-01-01");
      db.prepare("INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("goszakup.gov.kz", "061040006408", "T-004", "Small tender", "Customer", "100000", "KZT", "2026-01-01", "2026-12-31", "Действует", "auction", null, "2026-01-01");

      const cards = scoreCompanyCards(storage.getCompanyCards(["061040006408", "990940012345"]));
      const updated = backfillLeadBins(db, cards);
      expect(updated).toBe(1);

      const lead = db.prepare("SELECT bin FROM leads WHERE external_id = ?").get("1") as { bin: string };
      expect(lead.bin).toBe("990940012345");
    } finally {
      storage.close();
      db.close();
    }
  });

  it("assigns each batch BIN to at most one lead", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    try {
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "1", "Sardar Group", null, "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "2", "Tumar Group", null, "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");

      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("160140021493", 'ТОО "Sardar Group"', "2010-05-15", "47111", "Retail", "Astana", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);
      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("160140021494", 'ТОО "Tumar Group"', "2010-05-15", "47111", "Retail", "Astana", "Petrov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);
      db.prepare("INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("goszakup.gov.kz", "160140021493", "T-010", "Tender A", "Customer", "60000000", "KZT", "2026-01-01", "2026-12-31", "Действует", "auction", null, "2026-01-01");
      db.prepare("INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("goszakup.gov.kz", "160140021494", "T-011", "Tender B", "Customer", "100000", "KZT", "2026-01-01", "2026-12-31", "Действует", "auction", null, "2026-01-01");

      const cards = scoreCompanyCards(storage.getCompanyCards(["160140021493", "160140021494"]));
      expect(backfillLeadBins(db, cards)).toBe(2);

      const bins = db.prepare("SELECT bin FROM leads ORDER BY external_id").all() as Array<{ bin: string }>;
      expect(bins.map((row) => row.bin)).toEqual(["160140021493", "160140021494"]);
    } finally {
      storage.close();
      db.close();
    }
  });

  it("scrubInvalidLeadBins clears weak batch assignments", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    try {
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "1", "Random Shop", "160140021493", "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");
      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("160140021493", 'ТОО "NAZAR GROUP"', "2010-05-15", "47111", "Retail", "Astana", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);

      const cards = scoreCompanyCards(storage.getCompanyCards(["160140021493"]));
      expect(scrubInvalidLeadBins(db, cards)).toBe(1);

      const lead = db.prepare("SELECT bin FROM leads WHERE external_id = ?").get("1") as { bin: string | null };
      expect(lead.bin).toBeNull();
    } finally {
      storage.close();
      db.close();
    }
  });
});

describe("scoped fuzzy merge", () => {
  it("does not attach company_card from stat rows outside the provided batch", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    try {
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "9", "ТОО OUTSIDE BATCH", null, "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");

      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("111111111111", "ТОО OUTSIDE BATCH", "2010-05-15", "47111", "Retail", "Almaty", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);
      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("061040006408", "ТОО ALAU", "2010-05-15", "47111", "Retail", "Almaty", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);

      const cards = scoreCompanyCards(storage.getCompanyCards(["061040006408"]));
      const { matches } = mergeLeadsWithKz(db, cards);
      const match = matches.find((m) => m.external_id === "9");
      expect(match?.match_type).toBe("none");
      expect(match?.company_card).toBeNull();
    } finally {
      storage.close();
      db.close();
    }
  });

  it("backfillBinsFromMatches writes kz_bin onto leads.bin", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    try {
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "456", 'ТОО "ALAU"', null, "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");
      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("061040006408", "ТОО ALAU", "2010-05-15", "47111", "Retail", "Almaty", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);

      const cards = scoreCompanyCards(storage.getCompanyCards(["061040006408"]));
      const { matches } = mergeLeadsWithKz(db, cards);
      expect(backfillBinsFromMatches(db, matches)).toBe(1);

      const lead = db.prepare("SELECT bin FROM leads WHERE external_id = ?").get("456") as { bin: string };
      expect(lead.bin).toBe("061040006408");
    } finally {
      storage.close();
      db.close();
    }
  });
});
