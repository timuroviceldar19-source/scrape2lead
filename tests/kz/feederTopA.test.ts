import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  backfillBinsFromMatches,
  backfillLeadBins,
  mergeLeadsWithKz
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
