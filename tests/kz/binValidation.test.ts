import { describe, expect, it } from "vitest";
import {
  isTooCompanyName,
  isValidKzBinChecksum,
  validateHarvestCandidate
} from "../../src/kz/binValidation.js";

describe("isValidKzBinChecksum", () => {
  it("accepts known valid BINs from batch", () => {
    expect(isValidKzBinChecksum("061040006408")).toBe(true);
    expect(isValidKzBinChecksum("960440000716")).toBe(true);
    expect(isValidKzBinChecksum("241240019455")).toBe(true);
  });

  it("rejects invalid control digit", () => {
    expect(isValidKzBinChecksum("061040006409")).toBe(false);
    expect(isValidKzBinChecksum("123456789012")).toBe(false);
  });
});

describe("isTooCompanyName", () => {
  it("accepts ТОО variants", () => {
    expect(isTooCompanyName('ТОО "ALAU"')).toBe(true);
    expect(isTooCompanyName("Товарищество с ограниченной ответственностью \"Test\"")).toBe(true);
  });

  it("rejects ИП and АО-only", () => {
    expect(isTooCompanyName('ИП "Сервис"')).toBe(false);
    expect(isTooCompanyName('АО "Нефтяная страховая компания"')).toBe(false);
  });
});

describe("validateHarvestCandidate", () => {
  it("accepts valid ТОО row", () => {
    const result = validateHarvestCandidate({
      bin: "061040006408",
      name: 'ТОО "ALAU"',
      participant_id: "44899"
    });
    expect(result.accepted).toBe(true);
  });

  it("rejects ИП by name", () => {
    const result = validateHarvestCandidate({
      bin: "061040006408",
      name: 'ИП "Сервис"',
      participant_id: "99999"
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("not_too_name");
  });
});
