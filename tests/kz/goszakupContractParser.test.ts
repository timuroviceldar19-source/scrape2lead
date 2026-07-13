import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseContractGeneralHtml,
  parseContractPartiesHtml,
  parseContractSearchHtml,
  parseContractUnitsHtml
} from "../../src/kz/goszakupContractParser.js";

const FIXTURES = path.resolve("tests/fixtures/gz-contracts");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

describe("goszakup contract HTML parser", () => {
  it("parses contract rows and one-based pagination", () => {
    const result = parseContractSearchHtml(fixture("search.html"), 50);

    expect(result.items).toEqual([expect.objectContaining({
      contractId: "25553717",
      contractNumber: "980840002542/260020/00",
      url: "https://www.goszakup.gov.kz/ru/egzcontract/cpublic/show/25553717"
    })]);
    expect(result.pagination).toEqual({ totalCount: 1, totalPages: 1 });
  });

  it("parses the contract signing date", () => {
    expect(parseContractGeneralHtml(fixture("general.html"))).toEqual({
      signedAt: "2026-07-13 14:42:25"
    });
  });

  it("extracts ENSTRU codes from contract units", () => {
    expect(parseContractUnitsHtml(fixture("units.html"))).toEqual(["262030.100.000021"]);
  });

  it("prefers supplier BIN and falls back to a 12-digit IIN", () => {
    expect(parseContractPartiesHtml(fixture("parties-bin.html"))).toEqual({
      customerBin: "980840002542",
      customerName: "КГУ «Тестовая школа»",
      supplierBinIin: "120340012345",
      supplierName: "ТОО «Тест-поставщик»"
    });
    expect(parseContractPartiesHtml(fixture("parties-iin.html")).supplierBinIin).toBe("080419653489");
  });

  it("returns blank identifiers when portal values are invalid", () => {
    const html = fixture("parties-bin.html")
      .replace("980840002542", "123")
      .replace("120340012345", "not-a-bin");
    const result = parseContractPartiesHtml(html);

    expect(result.customerBin).toBe("");
    expect(result.supplierBinIin).toBe("");
  });
});

