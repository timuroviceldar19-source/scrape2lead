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
    expect(config.manualRunsRequired).toBe(7);
    expect(config.planYearId).toBe(9);
    expect(config.maxPages).toBe(500);
    expect(config.goszakupRegistryDatabasePath).toBe("data/scrape2lead.db");
  });
});
