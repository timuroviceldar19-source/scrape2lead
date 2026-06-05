import { describe, it, expect } from "vitest";
import { validatePhone, validateAddress, validateWebsite } from "../../src/enrichment/validator.js";

describe("Enrichment Validator", () => {
  describe("validatePhone", () => {
    it("should validate correct KZ numbers", () => {
      expect(validatePhone("+7 777 123 45 67")).toEqual({ raw: "+7 777 123 45 67", normalized: "+77771234567", status: "valid" });
      expect(validatePhone("87771234567")).toEqual({ raw: "87771234567", normalized: "+77771234567", status: "valid" });
    });
    it("should invalidate short numbers", () => {
      expect(validatePhone("2400")).toEqual({ raw: "2400", normalized: null, status: "invalid" });
      expect(validatePhone("22")).toEqual({ raw: "22", normalized: null, status: "invalid" });
      expect(validatePhone("36")).toEqual({ raw: "36", normalized: null, status: "invalid" });
    });
  });

  describe("validateAddress", () => {
    it("should invalidate numeric-only short addresses", () => {
      expect(validateAddress("22")).toEqual({ status: "invalid", clean: null });
      expect(validateAddress("2400")).toEqual({ status: "invalid", clean: null });
      expect(validateAddress("36")).toEqual({ status: "invalid", clean: null });
    });
    it("should invalidate addresses without letters", () => {
      expect(validateAddress("1234567")).toEqual({ status: "invalid", clean: null });
    });
    it("should validate proper addresses", () => {
      expect(validateAddress("ул. Абая 10, офис 5")).toEqual({ status: "valid", clean: "ул. Абая 10, офис 5" });
    });
  });

  describe("validateWebsite", () => {
    it("should invalidate Kaspi links for real_website", () => {
      expect(validateWebsite("https://kaspi.kz/shop/...")).toEqual({ status: "invalid", clean: null });
      expect(validateWebsite("kaspi.com")).toEqual({ status: "invalid", clean: null });
    });
    it("should validate proper websites", () => {
      expect(validateWebsite("example.com")).toEqual({ status: "valid", clean: "https://example.com" });
    });
  });
});
