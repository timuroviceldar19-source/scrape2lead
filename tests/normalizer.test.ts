import { describe, expect, it } from "vitest";
import { finalizeLead, normalizeEmail, normalizePhone, normalizeUrl } from "../src/normalizer/normalize.js";

describe("normalizer", () => {
  it("normalizes RU/KZ phones to +7 format", () => {
    expect(normalizePhone("8 (777) 123-45-67")).toBe("+77771234567");
    expect(normalizePhone("+7 701 222 33 44")).toBe("+77012223344");
    expect(normalizePhone("7012223344")).toBe("+77012223344");
  });

  it("validates email and url fields", () => {
    expect(normalizeEmail(" INFO@Example.COM ")).toBe("info@example.com");
    expect(normalizeEmail("bad")).toBeNull();
    expect(normalizeUrl("example.com/")).toBe("https://example.com");
  });

  it("marks lead incomplete when phones are missing", () => {
    const lead = finalizeLead({
      source: "2gis",
      external_id: "1",
      company_name: " Demo ",
      category: " service ",
      city: " moscow ",
      address: " street ",
      phones: [],
      email: null,
      website: null,
      social_links: [],
      messenger_links: [],
      parsed_at: new Date().toISOString(),
      incomplete: false
    });

    expect(lead.incomplete).toBe(true);
  });
});
