import { describe, expect, it } from "vitest";
import { scoreCompanyCard } from "../../src/kz/kzLeadScore.js";
import type { CompanyCard } from "../../src/kz/tenderTypes.js";

function card(overrides: Partial<CompanyCard>): CompanyCard {
  return {
    bin: "100000000001",
    name: "Test",
    registration_date: null,
    oked: null,
    oked_name: null,
    address: null,
    director: null,
    legal_status: "unknown",
    krp_code: null,
    krp_name: null,
    kfs_code: null,
    kfs_name: null,
    sector_code: null,
    sector_name: null,
    tender_count_total: 0,
    tender_count_active: 0,
    tender_budget_sum: null,
    tender_active_budget_sum: null,
    tender_sources: "",
    last_tender_end_date: null,
    stat_missing: false,
    ...overrides
  };
}

describe("scoreCompanyCard", () => {
  it("marks high activity suppliers as priority A", () => {
    const scored = scoreCompanyCard(card({
      tender_count_total: 55,
      tender_count_active: 12,
      tender_active_budget_sum: 1_000_000
    }));
    expect(scored.lead_priority).toBe("A");
    expect(scored.high_volume).toBe(true);
  });

  it("marks medium suppliers as priority B", () => {
    const scored = scoreCompanyCard(card({
      tender_count_total: 22,
      tender_count_active: 4,
      tender_active_budget_sum: 2_000_000
    }));
    expect(scored.lead_priority).toBe("B");
    expect(scored.high_volume).toBe(false);
  });

  it("marks low activity suppliers as priority C", () => {
    const scored = scoreCompanyCard(card({
      tender_count_total: 2,
      tender_count_active: 1,
      tender_active_budget_sum: 100_000
    }));
    expect(scored.lead_priority).toBe("C");
  });
});
