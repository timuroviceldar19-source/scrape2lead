import { describe, expect, it } from "vitest";
import { DEFAULT_GZ_EXCLUDE_KEYWORDS, isExcludedByName } from "../../src/kz/gzItemFilter.js";

describe("isExcludedByName", () => {
  const stopList = [...DEFAULT_GZ_EXCLUDE_KEYWORDS];

  it("drops single-word junk items regardless of case", () => {
    expect(isExcludedByName("Уголок", stopList)).toBe(true);
    expect(isExcludedByName("стойка", stopList)).toBe(true);
    expect(isExcludedByName("КАЛЬКУЛЯТОР", stopList)).toBe(true);
  });

  it("drops junk when it appears as a token inside a longer name", () => {
    expect(isExcludedByName("Приобретение: Плинтус напольный", stopList)).toBe(true);
  });

  it("matches multi-word phrases as a substring", () => {
    expect(isExcludedByName("Источник бесперебойного питания APC 650", stopList)).toBe(true);
  });

  it("does not drop legitimate items", () => {
    expect(isExcludedByName("Компьютер", stopList)).toBe(false);
    expect(isExcludedByName("Панель интерактивная", stopList)).toBe(false);
    expect(isExcludedByName("Рабочая станция", stopList)).toBe(false);
    expect(isExcludedByName("Ноутбук", stopList)).toBe(false);
  });

  it("uses whole-token matching so single-word stop-words do not hit substrings", () => {
    // "Игра" must not knock out words that merely contain those letters.
    expect(isExcludedByName("Выиграл тендер", ["Игра"])).toBe(false);
    // "Стойка" must not hit "рабочая станция".
    expect(isExcludedByName("Рабочая станция", ["Стойка"])).toBe(false);
  });

  it("returns false for empty name or empty stop-list", () => {
    expect(isExcludedByName("", stopList)).toBe(false);
    expect(isExcludedByName("Уголок", [])).toBe(false);
  });
});
