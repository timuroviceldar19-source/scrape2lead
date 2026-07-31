import { describe, expect, it } from "vitest";
import { buildLeadCodeProposal, renderLeadCodeProposal, validateContractSourceCoverage } from "../../src/kz/goszakupLeadCodeProposal.js";

describe("lead code proposal", () => {
  it("groups allowed hardware codes, flags exclusions, and limits zero rows", () => {
    const proposal = buildLeadCodeProposal([
      { code: "a", name: "Ноутбук", contracts: 8 },
      { code: "b", name: "Принтер лазерный", contracts: 2 },
      { code: "c", name: "Лицензия ПО", contracts: 7 },
      { code: "d", name: "Картридж", contracts: 0 },
      { code: "e", name: "Монитор", contracts: 0 }
    ]);
    expect(proposal.nonZero.map((row) => row.code)).toEqual(["a", "c", "b"]);
    expect(proposal.nonZero[1]?.note).toMatch(/ПО/);
    expect(proposal.zero.map((row) => row.code)).toEqual(["d", "e"]);
    expect(renderLeadCodeProposal(proposal)).toContain("Коды с 0 контрактов");
  });

  it("rejects a source that does not cover the requested window", () => {
    expect(() => validateContractSourceCoverage({ rows: 3, minDate: "2026-06-15", maxDate: "2026-07-31" }, "2026-05-01", "2026-07-31")).toThrow(/не покрывает/i);
  });
});
