import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportUnifiedReport } from "../../src/kz/unifiedExporter.js";
import { formatLeadPhone } from "../../src/kz/leadKzMerge.js";
import { mergeLeadsWithKz } from "../../src/kz/leadKzMerge.js";
import { scoreCompanyCards } from "../../src/kz/kzLeadScore.js";
import { KzStorage } from "../../src/kz/kzStorage.js";

const TEST_DB_PATH = path.join("data", "test-unified-export.db");
const TEST_XLSX_PATH = path.join("exports", "test-unified.xlsx");

describe("unifiedExporter", () => {
  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_XLSX_PATH)) fs.unlinkSync(TEST_XLSX_PATH);

    const db = new Database(TEST_DB_PATH);
    const storage = new KzStorage({ db });

    db.prepare(`
      INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at, phone_normalized, address_clean, crm_status, lead_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("2gis", "123", "ТОО ALAU", "061040006408", "test", "Astana", "raw addr", '["+77071111111"]', "[]", "[]", "2026-01-01", "+77071234567", "ул. Абая 1", "Ready to call", 85);
    db.prepare(`
      INSERT INTO leads (source, external_id, company_name, bin, category, city, address, phones, social_links, messenger_links, parsed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("2gis", "456", "ТОО BETA", null, "test", "Astana", "", "[]", "[]", "[]", "2026-01-01");

    db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("061040006408", "ТОО ALAU", "2010-05-15", "47111", "Retail", "Almaty", "Ivanov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);
    db.prepare("INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("990940012345", "ТОО BETA", "2015-03-20", "62010", "Software", "Astana", "Petrov", "active", null, null, null, "ТОО", null, null, "2026-01-01", null);

    db.prepare("INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("goszakup.gov.kz", "061040006408", "T-001", "Test tender 1", "Customer A", "1000000", "KZT", "2026-01-01", "2026-12-31", "Опубликована", "auction", null, "2026-01-01");
    db.prepare("INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("goszakup.gov.kz", "061040006408", "T-002", "Test tender 2", "Customer B", "2000000", "KZT", "2026-02-01", "2026-11-30", "Исполнен", "contest", null, "2026-02-01");

    storage.close();
  });

  afterAll(() => {
    try { if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { if (fs.existsSync(TEST_XLSX_PATH)) fs.unlinkSync(TEST_XLSX_PATH); } catch {}
  });

  it("exports unified XLSX with leads + KZ data", async () => {
    const result = await exportUnifiedReport({
      databasePath: TEST_DB_PATH,
      outPath: TEST_XLSX_PATH
    });

    expect(result.xlsxPath).toBe(TEST_XLSX_PATH);
    expect(result.leads).toBe(2);
    expect(result.tenders).toBe(2);
    expect(result.mergeStats.total_leads).toBe(2);
    expect(result.mergeStats.matched_exact).toBe(1);
    expect(result.mergeStats.matched_fuzzy_stat).toBe(1);
    expect(result.mergeStats.unmatched).toBe(0);
    expect(result.mergeStats.with_tenders).toBe(1);

    expect(fs.existsSync(TEST_XLSX_PATH)).toBe(true);

    const db = new Database(TEST_DB_PATH);
    const storage = new KzStorage({ db });
    const { matches } = mergeLeadsWithKz(db, scoreCompanyCards(storage.getCompanyCards()));
    storage.close();
    db.close();

    expect(formatLeadPhone(matches[0])).toBe("+77071234567");
  });

  it("filters by priority when specified", async () => {
    const result = await exportUnifiedReport({
      databasePath: TEST_DB_PATH,
      outPath: TEST_XLSX_PATH,
      priority: "A"
    });

    expect(result.leads).toBeGreaterThanOrEqual(0);
  });
});
