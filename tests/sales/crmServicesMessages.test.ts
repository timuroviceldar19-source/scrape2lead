import { describe, expect, it } from "vitest";
import {
  buildCrmFirstTouchMessage,
  buildCrmFollowUpMessage,
  buildIntegratorMessage,
  buildWaLink,
  CRM_CASE_STATS,
  formatCount
} from "../../src/sales/crmServicesMessages.js";

describe("CRM services outreach messages", () => {
  it("substitutes case numbers and prices into the first touch message", () => {
    const message = buildCrmFirstTouchMessage({
      dealsScanned: 4075,
      duplicatePairsFound: 40,
      dealsKeyed: 130,
      importPriceFrom: 80_000,
      cleanupPriceFrom: 100_000
    });

    expect(message).toContain("4 075 сделок");
    expect(message).toContain("40 пар дублей");
    expect(message).toContain("от 100 тыс ₸");
    expect(message).toContain("от 80 тыс ₸");
    expect(message).not.toMatch(/\{\{|\bundefined\b|NaN/);
  });

  it("uses the canonical case stats by default in all three templates", () => {
    for (const build of [buildCrmFirstTouchMessage, buildCrmFollowUpMessage, buildIntegratorMessage]) {
      const message = build();
      expect(message).toContain(formatCount(CRM_CASE_STATS.dealsScanned));
      expect(message).not.toMatch(/\{\{|\bundefined\b|NaN/);
    }
  });

  it("mentions the keyed deals count in the integrator pitch", () => {
    expect(buildIntegratorMessage()).toContain("130 переведено");
  });

  it("builds wa.me links with normalized KZ phones and encoded message text", () => {
    const link = buildWaLink("+7 (777) 123-45-67; +7 705 000 00 00", buildCrmFirstTouchMessage());
    expect(link).toMatch(/^https:\/\/wa\.me\/77771234567\?text=/);
    expect(link).toContain(encodeURIComponent("Битрикс24"));
  });

  it("formats counts with regular spaces only", () => {
    expect(formatCount(4075)).toBe("4 075");
    expect(formatCount(40)).toBe("40");
    expect(formatCount(4075)).not.toMatch(/[\u00A0\u202F]/);
  });
});
