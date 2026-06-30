import { describe, expect, it } from "vitest";
import { normalizeQuery, hasUsefulNormalizedForm } from "../src/enrichment/queryNormalize.js";

describe("normalizeQuery", () => {
  describe("TLD stripping", () => {
    it("drops a trailing .kz TLD", () => {
      expect(normalizeQuery("Akvilon.kz")).toBe("akvilon");
    });

    it("drops .ru, .com, .org, .net, .io TLDs", () => {
      expect(normalizeQuery("BrandX.ru")).toBe("brandx");
      expect(normalizeQuery("BrandX.com")).toBe("brandx");
      expect(normalizeQuery("BrandX.org")).toBe("brandx");
      expect(normalizeQuery("BrandX.net")).toBe("brandx");
      expect(normalizeQuery("BrandX.io")).toBe("brandx");
    });

    it("keeps digits that look like a TLD but are part of the brand", () => {
      // "1kz" is one token (no dot) so nothing gets split, nothing
      // gets stripped, the brand survives intact.
      expect(normalizeQuery("1kz")).toBe("1kz");
    });
  });

  describe("legal form and marketing suffix stripping", () => {
    it("drops Russian legal forms", () => {
      expect(normalizeQuery("ТОО КазСтройМаркет")).toBe("казстроймаркет");
      expect(normalizeQuery("ИП Ашимова")).toBe("ашимова");
      expect(normalizeQuery("ОАО СтройИнвест")).toBe("стройинвест");
    });

    it("drops the НДС suffix token and the preposition 'с' that often precedes it", () => {
      expect(normalizeQuery("DOM STROY COMPANY НДС")).toBe("dom stroy");
      expect(normalizeQuery("СтройМастер с НДС")).toBe("строймастер");
    });

    it("drops Официальный дистрибьютор wherever it appears (keeps 'group' is not legal here — wait, 'group' is in SUFFIX, so it should be dropped)", () => {
      expect(normalizeQuery("Официальный дистрибьютор Eco Group Kazakhstan")).toBe("eco kazakhstan");
      expect(normalizeQuery("Eco Group Kazakhstan Официальный дистрибьютор")).toBe("eco kazakhstan");
    });

    it("drops English legal / corporate suffixes", () => {
      expect(normalizeQuery("Acme Trading Ltd")).toBe("acme");
      expect(normalizeQuery("Acme Holdings Group")).toBe("acme");
      expect(normalizeQuery("Acme Corporation")).toBe("acme");
      expect(normalizeQuery("Acme Inc")).toBe("acme");
    });
  });

  describe("parenthetical content", () => {
    it("drops parenthetical content (typically the legal form)", () => {
      expect(normalizeQuery("220 VOLT (ИП Ашимова)")).toBe("220 volt");
      expect(normalizeQuery("Acme (company)")).toBe("acme");
    });
  });

  describe("whitespace and casing", () => {
    it("collapses repeated whitespace and trims", () => {
      expect(normalizeQuery("  Akvilon  .   kz  ")).toBe("akvilon");
    });

    it("lowercases the entire string", () => {
      expect(normalizeQuery("ASTANA Lamed")).toBe("astana lamed");
    });

    it("treats ё and е as the same character", () => {
      expect(normalizeQuery("Лёд")).toBe("лед");
      expect(normalizeQuery("Лед")).toBe("лед");
    });
  });

  describe("preserves 2GIS-relevant category tokens", () => {
    it("keeps 'магазин' and 'shop' — these are useful 2GIS category hints, not brand noise", () => {
      expect(normalizeQuery("Магазин Akvilon")).toBe("магазин akvilon");
      // 'group' is a corporate suffix and gets dropped, 'shop' is kept
      expect(normalizeQuery("Big Group Shop")).toBe("big shop");
    });
  });

  describe("edge cases", () => {
    it("returns an empty string for null, undefined, and ''", () => {
      expect(normalizeQuery(null)).toBe("");
      expect(normalizeQuery(undefined)).toBe("");
      expect(normalizeQuery("")).toBe("");
    });

    it("returns an empty string when the only tokens are suffixes", () => {
      expect(normalizeQuery("НДС")).toBe("");
      expect(normalizeQuery("Company Ltd")).toBe("");
    });

    it("does not throw on punctuation-only or whitespace-only input", () => {
      expect(normalizeQuery("...")).toBe("");
      expect(normalizeQuery("   ")).toBe("");
    });
  });
});

describe("hasUsefulNormalizedForm", () => {
  it("is true when the normalised form is non-empty", () => {
    expect(hasUsefulNormalizedForm("Akvilon.kz")).toBe(true);
    expect(hasUsefulNormalizedForm("1kz")).toBe(true);
  });

  it("is false when the normalised form is empty", () => {
    expect(hasUsefulNormalizedForm("")).toBe(false);
    expect(hasUsefulNormalizedForm(null)).toBe(false);
    expect(hasUsefulNormalizedForm("НДС")).toBe(false);
  });
});
