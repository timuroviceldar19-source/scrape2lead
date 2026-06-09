import { describe, expect, it } from "vitest";
import {
  filterZakupTenders,
  hasZakupTitleMatch,
  isKnownDefaultZakupFeed,
  tokenizeForZakupMatch
} from "../../src/kz/zakupTenderFilter.js";

const defaultFeedNumbers = [
  "1216770",
  "1225537",
  "1226459",
  "1228180",
  "1228178",
  "1228181",
  "1224410",
  "1227281",
  "1227835",
  "1222475"
];

const makeItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: "1001",
  nameRu: "Поставка кабеля для ТОО Тест",
  sumTruNoNds: "500000",
  advertStatus: "PUBLISHED",
  ...overrides
});

describe("zakupTenderFilter", () => {
  describe("tokenizeForZakupMatch", () => {
    it("extracts meaningful tokens from company name", () => {
      const tokens = tokenizeForZakupMatch('ТОО "ALAU"');
      expect(tokens).toContain("alau");
      expect(tokens.length).toBeGreaterThanOrEqual(1);
    });

    it("filters out generic tokens", () => {
      const tokens = tokenizeForZakupMatch("ТОО Казахстан КЗ Трейд Групп");
      expect(tokens).not.toContain("казахстан");
      expect(tokens).not.toContain("kz");
      expect(tokens).toContain("трейд");
      expect(tokens).toContain("групп");
    });
  });

  describe("hasZakupTitleMatch", () => {
    it("returns true when company token appears in tender name", () => {
      expect(hasZakupTitleMatch('ТОО "ALAU"', "Поставка для ALAU")).toBe(true);
    });

    it("returns false when no company token in tender name", () => {
      expect(hasZakupTitleMatch('ТОО "API-KZ (АПИ-КЗ)"', "Гироскопическая инклинометрия")).toBe(false);
    });

    it("returns false for empty company name", () => {
      expect(hasZakupTitleMatch("", "Поставка кабеля")).toBe(false);
    });
  });

  describe("isKnownDefaultZakupFeed", () => {
    it("returns true for all default feed numbers", () => {
      expect(isKnownDefaultZakupFeed(defaultFeedNumbers)).toBe(true);
    });

    it("returns false when numbers include non-default ones", () => {
      expect(isKnownDefaultZakupFeed(["1216770", "9999999"])).toBe(false);
    });

    it("returns false for empty array", () => {
      expect(isKnownDefaultZakupFeed([])).toBe(false);
    });
  });

  describe("filterZakupTenders", () => {
    it("rejects default feed items with weak title match", () => {
      const items = defaultFeedNumbers.map((num, i) =>
        makeItem({ number: num, nameRu: `Гироскопическая инклинометрия ${i}` })
      );
      const result = filterZakupTenders(items, "210940017793", 'ТОО "ALAU"');

      expect(result.accepted).toHaveLength(0);
      expect(result.rejected.length).toBeGreaterThanOrEqual(10);
      expect(result.stats.accepted).toBe(0);
      expect(result.stats.rejected).toBeGreaterThanOrEqual(10);
    });

    it("accepts items with matching title tokens", () => {
      const items = [makeItem({ number: "99999", nameRu: "Поставка кабеля для ALAU" })];
      const result = filterZakupTenders(items, "111111111111", 'ТОО "ALAU"');

      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0].customer_name).toBe('ТОО "ALAU"');
      expect(result.rejected).toHaveLength(0);
    });

    it("handles empty array without throwing", () => {
      const result = filterZakupTenders([], "111111111111", 'ТОО "ALAU"');
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
      expect(result.stats.total).toBe(0);
    });

    it("rejects items with no number", () => {
      const items = [makeItem({ number: undefined, nameRu: "Поставка кабеля" })];
      const result = filterZakupTenders(items, "111111111111", 'ТОО "ALAU"');
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0].reason).toBe("missing_number");
    });

    it("rejects duplicate tender numbers", () => {
      const items = [
        makeItem({ number: "500", nameRu: "Поставка для ALAU" }),
        makeItem({ number: "500", nameRu: "Поставка для ALAU" })
      ];
      const result = filterZakupTenders(items, "111111111111", 'ТОО "ALAU"');
      expect(result.accepted).toHaveLength(1);
      expect(result.rejected[0].reason).toBe("duplicate_tender_number");
    });
  });
});
