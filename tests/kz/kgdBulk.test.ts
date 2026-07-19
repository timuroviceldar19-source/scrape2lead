import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { chooseSpreadsheetAttachment, parseBulkWorkbook, resolveCacheAction } from "../../src/kz/kgdBulk.js";

describe("KGD bulk lists", () => {
  it("rejects ambiguous spreadsheet attachments", () => {
    expect(() => chooseSpreadsheetAttachment("https://kgd.gov.kz/x", '<a href="a.xlsx">A</a><a href="b.xls">B</a>')).toThrow(/ambiguous/i);
  });

  it("parses all sheets, multiline headers, aliases and exact 12-digit BINs", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Банкротство").addRows([["Список"], ["№", "БИН(ИИН)", "Наименование"], [1, "000240001420", "A"], [2, "0002400014209", "not exact"]]);
    book.addWorksheet("Реабилитация").addRows([["БИН / ИИН", "Название"], ["980840002897", "B"]]);
    const rows = await parseBulkWorkbook(await book.xlsx.writeBuffer(), { source: "insolvent", sourceUrl: "x", listDate: "2026-07-10" });
    expect(rows.map((x) => x.bin)).toEqual(["000240001420", "980840002897"]);
    expect(rows.map((x) => x.listType)).toEqual(["Банкротство", "Реабилитация"]);
  });

  it("implements fresh, refresh/fallback and expired cache boundaries", () => {
    expect(resolveCacheAction(23.9)).toBe("use");
    expect(resolveCacheAction(24)).toBe("refresh_with_fallback");
    expect(resolveCacheAction(24 * 7)).toBe("expired");
  });
});
