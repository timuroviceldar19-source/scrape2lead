import { describe, it, expect } from "vitest";
import { normalizeText, calculateNameSimilarity, calculateConfidenceScore } from "../../src/enrichment/scoring.js";

describe("Enrichment Scoring", () => {
  describe("normalizeText", () => {
    it("should normalize and remove city suffixes", () => {
      // "тоо" остается, так как это префикс юрлица, а не город
      expect(normalizeText("  ТОО '12 Месяцев Астана'  ")).toBe("тоо 12 месяцев");
      expect(normalizeText("СтройМир (Павлодар)")).toBe("строймир");
    });
    it("should replace ё with е", () => {
      expect(normalizeText("Чёрный")).toBe("черный");
    });
  });

  describe("calculateConfidenceScore", () => {
    it("should return MEDIUM confidence for good match with valid phone (prefix difference)", () => {
      // "тоо 12 месяцев" vs "12 месяцев" gives ~0.71 similarity.
      // Total score: (0.71 * 0.55) + (1.0 * 0.20) + (1.0 * 0.15) + (1.0 * 0.10) = ~0.84
      const score = calculateConfidenceScore(
        "12 Месяцев Астана", "ТОО 12 Месяцев",
        "Астана", "Астана",
        "Стройматериалы", "Стройматериалы и ремонт",
        true // has valid phone
      );
      expect(score.confidence_level).toBe("medium");
      expect(score.total).toBeGreaterThanOrEqual(0.80);
      expect(score.total).toBeLessThan(0.85);
    });

    it("should return HIGH confidence for exact match with valid phone", () => {
      const score = calculateConfidenceScore(
        "12 Месяцев Астана", "12 Месяцев",
        "Астана", "Астана",
        "Стройматериалы", "Стройматериалы",
        true // has valid phone
      );
      expect(score.confidence_level).toBe("high");
      expect(score.total).toBeGreaterThanOrEqual(0.85);
    });

    it("should return LOW confidence for mismatched city and name", () => {
      const score = calculateConfidenceScore(
        "СтройМир Астана", "Продукты Алматы",
        "Астана", "Алматы",
        "Стройматериалы", "Продукты",
        false
      );
      expect(score.confidence_level).toBe("low");
      expect(score.total).toBeLessThan(0.65);
    });
  });
});
