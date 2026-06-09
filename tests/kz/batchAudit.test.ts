import { describe, expect, it } from "vitest";
import { buildBatchAuditReport, hasWeakTitleMatch } from "../../src/kz/batchAudit.js";
import { hasZakupTitleMatch } from "../../src/kz/zakupTenderFilter.js";
import type { CompanyCard, TenderRecord } from "../../src/kz/tenderTypes.js";

const baseCompany = (bin: string, name: string): CompanyCard => ({
  bin,
  name,
  registration_date: "01.01.2020",
  oked: "12345",
  oked_name: "Test",
  address: "Addr",
  director: "Director",
  legal_status: "unknown",
  krp_code: null,
  krp_name: null,
  kfs_code: null,
  kfs_name: null,
  sector_code: null,
  sector_name: null,
  updated_at: "2026-06-07T00:00:00.000Z",
  tender_count_total: 0,
  tender_count_active: 0,
  tender_active_budget_sum: null,
  tender_budget_sum: null,
  tender_sources: "",
  last_tender_end_date: null,
  stat_missing: false
});

const tender = (overrides: Partial<TenderRecord>): TenderRecord => ({
  source: "zakup.sk.kz",
  bin: "220540025781",
  tender_number: "100",
  tender_name: "Поставка оборудования API-KZ",
  customer_name: 'ТОО "API-KZ (АПИ-КЗ)"',
  budget_amount: "1000",
  currency: "KZT",
  start_date: null,
  end_date: null,
  status: "PUBLISHED",
  method: "OT",
  url: "https://zakup.sk.kz/#/lots/100",
  parsed_at: "2026-06-07T00:00:00.000Z",
  ...overrides
});

describe("batchAudit", () => {
  it("flags cross-bin duplicate tenders", () => {
    const companies = [baseCompany("111111111111", "Alpha"), baseCompany("222222222222", "Beta")];
    const tenders = [
      tender({ bin: "111111111111", tender_number: "900" }),
      tender({ bin: "222222222222", tender_number: "900" })
    ];

    const report = buildBatchAuditReport({ companies, tenders });
    expect(report.summary.cross_bin_duplicate_tenders).toBe(1);
    expect(report.tenders.every((row) => row.flags.includes("cross_bin_duplicate"))).toBe(true);
  });

  it("flags weak zakup title matches", () => {
    const companies = [baseCompany("220540025781", 'ТОО "API-KZ (АПИ-КЗ)"')];
    const tenders = [tender({ tender_name: "Гироскопическая инклинометрия" })];

    const report = buildBatchAuditReport({ companies, tenders });
    expect(hasWeakTitleMatch(companies[0].name, tenders[0].tender_name)).toBe(true);
    expect(report.tenders[0].flags).toContain("weak_title_match");
  });

  it("flags high volume and short search names", () => {
    const companies = [baseCompany("333333333333", "ТОО АО")];
    const tenders = Array.from({ length: 11 }, (_, index) =>
      tender({ bin: "333333333333", tender_number: String(1000 + index), tender_name: `Lot ${index}` })
    );

    const report = buildBatchAuditReport({ companies, tenders });
    expect(report.companies[0].flags).toContain("high_volume");
    expect(report.companies[0].flags).toContain("short_search_name");
  });
});
