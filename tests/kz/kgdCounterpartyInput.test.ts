import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseCounterpartyArgs, readCounterpartyBins } from "../../src/kz/kgdCounterpartyInput.js";

describe("counterparty CLI input", () => {
  it("defaults limit to 20 and validates positive integers", () => {
    expect(parseCounterpartyArgs(["--input", "bins.csv"])).toEqual({ input: "bins.csv", limit: 20 });
    expect(parseCounterpartyArgs(["--input", "bins.csv", "--limit", "2"]).limit).toBe(2);
    for (const value of ["0", "-1", "1.5", "x"]) {
      expect(() => parseCounterpartyArgs(["--input", "x.csv", "--limit", value])).toThrow(/positive integer/i);
    }
  });

  it("reads CSV, preserves leading zeroes/order, deduplicates and reports skipped rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kgd-input-"));
    const file = path.join(dir, "bins.csv");
    fs.writeFileSync(file, "Компания,БИН\nA,000240001420\nB,bad\nC,000240001420\nD,980840002897\n");
    await expect(readCounterpartyBins(file, 1)).resolves.toEqual({ bins: ["000240001420"], totalRows: 4, invalidRows: 1, duplicateRows: 1, limitSkipped: 1 });
  });

  it("finds a normalized BIN/IIN header in XLSX", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kgd-xlsx-"));
    const file = path.join(dir, "bins.xlsx");
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Data").addRows([["Name", " БИН / ИИН "], ["A", "000240001420"]]);
    await book.xlsx.writeFile(file);
    expect((await readCounterpartyBins(file, 20)).bins).toEqual(["000240001420"]);
  });
});
