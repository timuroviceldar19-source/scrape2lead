import { describe, expect, it } from "vitest";
import { isUsableZakupSearchName, normalizeCompanyName } from "../../src/kz/normalizeCompanyName.js";

describe("normalizeCompanyName", () => {
  it("removes Kazakh legal form prefixes and quotes", () => {
    expect(
      normalizeCompanyName('ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "API-KZ (АПИ-КЗ)"')
    ).toBe("API-KZ");
  });

  it("removes short legal forms", () => {
    expect(normalizeCompanyName('ТОО "KazService"')).toBe("KazService");
    expect(normalizeCompanyName("АО Национальная компания")).toBe("Национальная компания");
  });

  it("checks minimum zakup search length after normalization", () => {
    expect(isUsableZakupSearchName("ТОО AB")).toBe(false);
    expect(isUsableZakupSearchName("ТОО ABC")).toBe(true);
  });
});
