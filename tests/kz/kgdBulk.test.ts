import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "@e965/xlsx";
import { chooseSpreadsheetAttachment, downloadAndCacheBulk, parseBulkWorkbook, readBulkCache, resolveCacheAction } from "../../src/kz/kgdBulk.js";

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

  it("parses legacy XLS while preserving leading zeroes", async () => {
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["БИН", "Название"], ["000240001420", "A"]]), "Ликвидация");
    const rows = await parseBulkWorkbook(XLSX.write(book, { type: "buffer", bookType: "biff8" }), { source: "insolvent", sourceUrl: "x", listDate: "2026-07-10" });
    expect(rows[0]).toMatchObject({ bin: "000240001420", listType: "Ликвидация" });
  });

  it("downloads atomically and validates cached SHA-256", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kgd-cache-")); const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("A").addRows([["БИН"], ["000240001420"]]); const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const fetcher = async (url: string | URL | Request) => String(url).endsWith(".xlsx") ? new Response(bytes) : new Response('<a href="list.xlsx">file</a>');
    await downloadAndCacheBulk("https://kgd.test/page", dir, "list", "2026-07-10", fetcher as typeof fetch);
    expect(readBulkCache(dir, "list")?.metadata.listDate).toBe("2026-07-10");
    fs.appendFileSync(path.join(dir, "list.xlsx"), "tampered"); expect(readBulkCache(dir, "list")).toBeNull();
  });

  it("reports corrupt workbooks", async () => await expect(parseBulkWorkbook(Buffer.from("bad"), { source: "insolvent", sourceUrl: "x", listDate: "2026-07-10" })).rejects.toThrow(/corrupt/i));
});
