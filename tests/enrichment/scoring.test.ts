import { describe, it, expect } from "vitest";
import {
  normalizeText,
  calculateNameSimilarity,
  calculateConfidenceScore,
  applyChannelBoost
} from "../../src/enrichment/scoring.js";

describe("Enrichment Scoring", () => {
  describe("normalizeText (legacy — still used for category normalisation)", () => {
    it("should normalize and remove city suffixes", () => {
      // "тоо" остается, так как это префикс юрлица, а не город
      expect(normalizeText("  ТОО '12 Месяцев Астана'  ")).toBe("тоо 12 месяцев");
      expect(normalizeText("СтройМир (Павлодар)")).toBe("строймир");
    });
    it("should replace ё with е", () => {
      expect(normalizeText("Чёрный")).toBe("черный");
    });
  });

  describe("calculateNameSimilarity (now goes through queryNormalize)", () => {
    it("strips TLDs and legal-form noise from both names", () => {
      // "12 Месяцев Астана" and "ТОО 12 Месяцев" both normalise to
      // "12 месяцев" once the city and the "ТОО" prefix are dropped.
      expect(calculateNameSimilarity("12 Месяцев Астана", "ТОО 12 Месяцев")).toBe(1);
      expect(calculateNameSimilarity("Akvilon.kz", "Аквилон")).toBe(0); // Latin vs Cyrillic — no shared characters
    });

    it("returns 0 for names with zero shared characters", () => {
      // "аквилон" (7 cyrillic chars) and "bcdfghj" (7 latin chars)
      // share no characters at all, so Levenshtein gives 7 and the
      // similarity is exactly 0.
      expect(calculateNameSimilarity("Аквилон", "bcdfghj")).toBe(0);
    });

    it("returns a small but non-zero value for names that share a few letters", () => {
      // "строймир" and "продукты" share 'р' and 'о' (the algorithm
      // aligns them and saves 2 substitutions), so the similarity is
      // small but not zero.
      const sim = calculateNameSimilarity("СтройМир", "Продукты");
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(0.3);
    });
  });

  describe("calculateConfidenceScore", () => {
    it("returns HIGH for a perfect match with valid signal", () => {
      const score = calculateConfidenceScore(
        "12 Месяцев Астана", "ТОО 12 Месяцев",
        "Астана", "Астана",
        "Стройматериалы", "Стройматериалы и ремонт",
        true, false, false
      );
      expect(score.confidence_level).toBe("high");
      expect(score.total).toBeGreaterThanOrEqual(0.85);
    });

    it("returns HIGH for an exact match with valid phone", () => {
      const score = calculateConfidenceScore(
        "12 Месяцев Астана", "12 Месяцев",
        "Астана", "Астана",
        "Стройматериалы", "Стройматериалы",
        true, false, false
      );
      expect(score.confidence_level).toBe("high");
      expect(score.total).toBeGreaterThanOrEqual(0.85);
    });

    it("returns LOW for mismatched city and name", () => {
      const score = calculateConfidenceScore(
        "СтройМир Астана", "Продукты Алматы",
        "Астана", "Алматы",
        "Стройматериалы", "Продукты",
        false, false, false
      );
      expect(score.confidence_level).toBe("low");
      expect(score.total).toBeLessThan(0.65);
    });

    it("returns LOW for a name with the new TLD/legal-form noise stripped (Akvilon.kz vs Аквилон)", () => {
      const score = calculateConfidenceScore(
        "Akvilon.kz", "Аквилон",
        "Астана", "Астана",
        "Стройматериалы", "Стройматериалы",
        true, false, false
      );
      expect(score.confidence_level).toBe("low");
      expect(score.total).toBeLessThan(0.65);
    });

    it("blocks substring boost for generic/short names", () => {
      const score = calculateConfidenceScore(
        "Auto", "AutoMart",
        "Астана", "Астана",
        "Автосервис", "Автосервис",
        true, true, false
      );
      expect(score.confidence_level).not.toBe("high");
    });

    it("allows domain boost for non-generic names", () => {
      const score = calculateConfidenceScore(
        "AIKOS", "Аквилон",
        "Астана", "Астана",
        "Электроника", "Электроника",
        true, true, true,
        "https://aikos.kz"
      );
      expect(score.name_similarity).toBeGreaterThanOrEqual(0.9);
    });

    it("blocks domain boost for generic names", () => {
      const score = calculateConfidenceScore(
        "Auto", "Some Other",
        "Астана", "Астана",
        "Автосервис", "Автосервис",
        true, true, true,
        "https://automart.kz"
      );
      expect(score.name_similarity).toBeLessThan(0.9);
    });
  });

  describe("applyChannelBoost", () => {
    it("promotes low → medium when 2+ channels are valid", () => {
      const result = applyChannelBoost("low", { phone: "valid", address: "valid", website: "invalid" });
      expect(result.level).toBe("medium");
      expect(result.applied).toBe(true);
      expect(result.validChannelCount).toBe(2);
    });

    it("promotes low → medium when all 3 channels are valid", () => {
      const result = applyChannelBoost("low", { phone: "valid", address: "valid", website: "valid" });
      expect(result.level).toBe("medium");
      expect(result.applied).toBe(true);
      expect(result.validChannelCount).toBe(3);
    });

    it("keeps low when only 1 channel is valid", () => {
      const result = applyChannelBoost("low", { phone: "valid", address: "invalid", website: "empty" });
      expect(result.level).toBe("low");
      expect(result.applied).toBe(false);
      expect(result.validChannelCount).toBe(1);
    });

    it("keeps low when 0 channels are valid", () => {
      const result = applyChannelBoost("low", { phone: "invalid", address: "empty", website: "empty" });
      expect(result.level).toBe("low");
      expect(result.applied).toBe(false);
      expect(result.validChannelCount).toBe(0);
    });

    it("never downgrades high or medium", () => {
      expect(applyChannelBoost("high", { phone: "invalid", address: "invalid", website: "invalid" }).level).toBe("high");
      expect(applyChannelBoost("medium", { phone: "invalid", address: "invalid", website: "invalid" }).level).toBe("medium");
    });

    it("treats 'empty' as not-valid (only 'valid' counts)", () => {
      const result = applyChannelBoost("low", { phone: "empty", address: "empty", website: "empty" });
      expect(result.validChannelCount).toBe(0);
    });
  });
});
