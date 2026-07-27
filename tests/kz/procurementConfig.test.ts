import { describe, expect, it } from "vitest";
import { loadProcurementConfig } from "../../src/kz/procurement/config.js";

describe("external procurement configuration", () => {
  it("loads the production configuration with strict product and CRM gates", () => {
    const config = loadProcurementConfig("config/procurement-sources.json");
    expect(config.sources).toEqual(["mitwork", "samruk", "tizilim"]);
    expect(config.keywords).toEqual(expect.arrayContaining([
      "Компьютер", "Монитор", "Моноблок", "Ноутбук", "Интерактивная панель"
    ]));
    expect(config.keywords).not.toContain("Компьютер персональный");
    expect(config.pkTruPrefixes).toEqual(["262011.", "262013.", "262017.100."]);
    expect(config.minAmount).toBe(500_000);
    expect(config.bitrix).toMatchObject({ categoryId: 1, stageId: "C1:NEW", executeEnabled: false });
    expect(config.bitrix.managerIds).toEqual(["2255"]);
    expect(config.manualRunsRequired).toBe(7);
    expect(config.maxPages).toBe(500);
    expect(config.goszakupRegistryDatabasePath).toBe("data/scrape2lead.db");
  });

  it("targets the current plan year, not a stale dictionary id", () => {
    const config = loadProcurementConfig("config/procurement-sources.json");
    // plan_year_id 9 — это 2024 год: конвейер собирал его до перехода на скользящее окно.
    expect(config).not.toHaveProperty("planYearId");
    expect(config.rollingMonths).toBe(7);
    expect(Object.values(config.planYearIds)).not.toContain(9);

    const currentYear = new Date().getFullYear();
    const pinnedYears = Object.keys(config.planYearIds).map(Number);
    expect(Math.max(...pinnedYears)).toBeGreaterThanOrEqual(currentYear);
  });

  it("declares cameral control without an id, since EPZ does not expose that status", () => {
    const config = loadProcurementConfig("config/procurement-sources.json");
    expect(config.planStatuses).toEqual([
      { name: "Утвержден", id: 2 },
      { name: "На проверке камерального контроля", id: null }
    ]);
  });

  it("enables Bitrix execution in the dedicated F3 cutover config", () => {
    const config = loadProcurementConfig("config/procurement-sources.f3.json");
    expect(config.bitrix.executeEnabled).toBe(true);
  });
});
