import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { collectLeadBins, findBinsMissingEnrich } from "../../src/kz/enrichMissing.js";
import { formatLeadAddress, formatLeadPhone } from "../../src/kz/leadKzMerge.js";
import { KzStorage } from "../../src/kz/kzStorage.js";

describe("enrichMissing helpers", () => {
  it("collectLeadBins returns valid unique BINs from leads and extras", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    try {
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "1", "A", "061040006408", "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "2", "B", "061040006408", "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");
      db.prepare(`
        INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("2gis", "3", "C", null, "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");

      const bins = collectLeadBins(db, ["990940012345"]);
      expect(bins.sort()).toEqual(["061040006408", "990940012345"]);
    } finally {
      storage.close();
      db.close();
    }
  });

  it("findBinsMissingEnrich flags missing stat, registry, or tenders", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    try {
      db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("061040006408", "A", "2010-01-01", "47111", "Retail", "Almaty", "Dir", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);
      db.prepare("INSERT INTO goszakup_registry_data (bin, participant_id, name_ru, name_kz, rnn, role, residency, phone, email, website, registration_date, last_update_date, kopf, ownership_form, economic_sector, director_name, director_iin, legal_address, location_address, registry_url, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("990940012345", "1", "B", null, null, "Поставщик", null, "+77071234567", null, null, null, null, null, null, null, null, null, null, null, null, "2026-01-01", null);
      db.prepare("INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("goszakup.gov.kz", "111140006135", "T-1", "Tender", "Customer", "1000", "KZT", "2026-01-01", "2026-12-31", "active", "auction", null, "2026-01-01");

      const missing = findBinsMissingEnrich(storage, [
        "061040006408",
        "990940012345",
        "111140006135",
        "220640028224"
      ]).sort();

      expect(missing).toEqual([
        "061040006408",
        "111140006135",
        "220640028224",
        "990940012345"
      ]);
    } finally {
      storage.close();
      db.close();
    }
  });
});

describe("lead contact formatting", () => {
  it("prefers normalized phone and clean address", () => {
    expect(formatLeadPhone({
      phone_normalized: "+77071234567",
      phones: '["+77079999999"]',
      phone_raw: "+77071111111"
    })).toBe("+77071234567");

    expect(formatLeadPhone({
      phones: '["+77071111111", "+77072222222"]'
    })).toBe("+77071111111, +77072222222");

    expect(formatLeadAddress({
      address_clean: "ул. Абая 1",
      address: "raw",
      address_raw: "raw2"
    })).toBe("ул. Абая 1");
  });
});
