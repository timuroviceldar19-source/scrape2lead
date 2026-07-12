import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildLotsNstruSearchUrl,
  looksLikeIgnoredEnstruFilter,
  readNstruCodes,
  resolveLotStatusIds,
  writeLotsWorkbook,
  type GoszakupLotsNstruRow
} from "../../src/kz/goszakupLotsNstruExporter.js";

describe("buildLotsNstruSearchUrl", () => {
  it("builds lots search URL with enstru, year and month filters", () => {
    const url = buildLotsNstruSearchUrl({
      nstruCode: "262011.100.000000",
      year: 2026,
      month: 6
    });

    expect(url).toContain("https://goszakup.gov.kz/ru/search/lots?");
    expect(url).toContain("filter%5Benstru%5D=262011.100.000000");
    expect(url).toContain("filter%5Byear%5D=2026");
    expect(url).toContain("filter%5Bmonth%5D=6");
    expect(url).toContain("count_record=50");
    expect(url).not.toContain("page=");
  });

  it("includes status filters when provided", () => {
    const url = buildLotsNstruSearchUrl({
      nstruCode: "262011.100.000000",
      year: 2026,
      month: 6,
      statusIds: [10]
    });

    expect(url).toContain("filter%5Bstatus%5D%5B%5D=10");
  });

  it("uses goszakup page numbering where the second page is page=2", () => {
    const url = buildLotsNstruSearchUrl({
      nstruCode: "262011.100.000000",
      year: 2026,
      month: 6,
      pageNum: 1
    });

    expect(url).toContain("page=2");
  });

  it("builds name search URL with filter[name] instead of filter[enstru]", () => {
    const url = buildLotsNstruSearchUrl({
      nameQuery: "компьютер",
      year: 2026,
      month: 7
    });

    expect(url).toContain(`filter%5Bname%5D=${encodeURIComponent("компьютер")}`);
    expect(url).not.toContain("filter%5Benstru%5D");
  });

  it("throws when both or neither of nstruCode and nameQuery are provided", () => {
    expect(() => buildLotsNstruSearchUrl({ year: 2026, month: 7 })).toThrow(/exactly one/);
    expect(() =>
      buildLotsNstruSearchUrl({
        nstruCode: "262011.100.000000",
        nameQuery: "компьютер",
        year: 2026,
        month: 7
      })
    ).toThrow(/exactly one/);
  });
});

describe("resolveLotStatusIds", () => {
  it("maps status names and numeric strings to ids", () => {
    expect(resolveLotStatusIds(["Опубликован"])).toEqual([210]);
    expect(resolveLotStatusIds(["опубликован (прием заявок)", "360"])).toEqual([220, 360]);
  });

  it("deduplicates resolved ids", () => {
    expect(resolveLotStatusIds(["Опубликован", "210"])).toEqual([210]);
  });

  it("throws for unknown status names", () => {
    expect(() => resolveLotStatusIds(["Несуществующий"])).toThrow(/Unknown lot status/);
  });
});

describe("looksLikeIgnoredEnstruFilter", () => {
  it("accepts uniform lot names produced by a valid enstru code", () => {
    const items = Array.from({ length: 50 }, () => ({ lot_name: "Компьютер" }));
    expect(looksLikeIgnoredEnstruFilter(items)).toBe(false);
  });

  it("flags mixed lot names produced when goszakup drops the filter", () => {
    const items = [
      { lot_name: "Удлинитель" },
      { lot_name: "Батарейка" },
      { lot_name: "Квартира" },
      { lot_name: "Счетчик газовый" },
      { lot_name: "Компьютер" }
    ];
    expect(looksLikeIgnoredEnstruFilter(items)).toBe(true);
  });
});

describe("readNstruCodes", () => {
  it("removes empty lines and duplicates while preserving first-seen order", () => {
    const filePath = path.join(os.tmpdir(), `nstru-${Date.now()}.txt`);
    fs.writeFileSync(filePath, "262011.100.000000\n\n262011.100.000001\n262011.100.000000\n", "utf8");

    try {
      expect(readNstruCodes(filePath)).toEqual(["262011.100.000000", "262011.100.000001"]);
    } finally {
      fs.unlinkSync(filePath);
    }
  });
});

describe("writeLotsWorkbook", () => {
  it("writes expected columns and hyperlink cells", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lots-nstru-"));
    const filePath = path.join(dir, "lots.xlsx");
    const row: GoszakupLotsNstruRow = {
      nstru_code: "262011.100.000000",
      month: "Июнь",
      lot_number: "87175914-ЗЦП3",
      lot_name: "Ноутбук",
      announce_number: "17236037-1",
      announce_name: "Приобретение ноутбук",
      customer: "ГУ Заказчик",
      quantity: "1",
      amount: "258 620.69",
      method: "Запрос ценовых предложений",
      status: "Закупка не состоялась",
      lot_url: "https://goszakup.gov.kz/ru/search/lots/1",
      announce_url: "https://goszakup.gov.kz/ru/announce/index/1",
      customer_url: "https://goszakup.gov.kz/ru/registry/show_supplier/1"
    };

    await writeLotsWorkbook(filePath, [row]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.getWorksheet("Лоты НСТРУ");

    expect(sheet?.getRow(1).getCell(1).value).toBe("Запрос (НСТРУ/слово)");
    expect(sheet?.getRow(2).getCell(1).value).toBe("262011.100.000000");
    expect(sheet?.getRow(2).getCell(12).value).toEqual({
      text: row.lot_url,
      hyperlink: row.lot_url
    });
  });
});
