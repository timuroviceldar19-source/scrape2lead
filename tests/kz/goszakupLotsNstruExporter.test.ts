import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import {
  buildLotsNstruSearchUrl,
  dedupeRows,
  ensurePageLimitCoversTotal,
  filterLotRows,
  gotoLotsPageWithRetry,
  looksLikeIgnoredEnstruFilter,
  readNstruCodes,
  resolveLotStatusIds,
  writeLotsWorkbook,
  type GoszakupLotsNstruRow
} from "../../src/kz/goszakupLotsNstruExporter.js";

describe("lots page navigation retries", () => {
  it("retries a transient navigation failure and eventually succeeds", async () => {
    const transient = new Error("page.goto: net::ERR_NAME_NOT_RESOLVED");
    const goto = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(new Error("page.goto: Timeout 30000ms exceeded"))
      .mockResolvedValueOnce(null);
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const retries: string[] = [];

    await gotoLotsPageWithRetry(
      { goto, waitForTimeout },
      "https://goszakup.gov.kz/ru/search/lots?x=1",
      { timeoutMs: 60_000, maxAttempts: 4, retryDelayMs: 2_000, onRetry: (message) => retries.push(message) }
    );

    expect(goto).toHaveBeenCalledTimes(3);
    expect(goto).toHaveBeenLastCalledWith(
      "https://goszakup.gov.kz/ru/search/lots?x=1",
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    expect(retries).toHaveLength(2);
    expect(waitForTimeout.mock.calls).toEqual([[2_000], [4_000]]);
  });

  it("throws the final error after the configured attempt limit", async () => {
    const finalError = new Error("page.goto: Timeout 60000ms exceeded");
    const goto = vi.fn().mockRejectedValue(finalError);

    await expect(gotoLotsPageWithRetry(
      { goto, waitForTimeout: vi.fn().mockResolvedValue(undefined) },
      "https://goszakup.gov.kz/ru/search/lots?x=1",
      { timeoutMs: 60_000, maxAttempts: 3, retryDelayMs: 0 }
    )).rejects.toBe(finalError);

    expect(goto).toHaveBeenCalledTimes(3);
  });
});

function lotRow(overrides: Partial<GoszakupLotsNstruRow> = {}): GoszakupLotsNstruRow {
  return {
    nstru_code: "262011.100.000000",
    month: "Июнь",
    lot_number: `lot-${Math.random()}`,
    lot_name: "Компьютер",
    announce_number: "1",
    announce_name: "Приобретение",
    customer: "ГУ Заказчик",
    quantity: "1",
    amount: "900 000",
    method: "Запрос ценовых предложений",
    status: "Опубликован",
    lot_url: "",
    announce_url: "",
    customer_url: "",
    ...overrides
  };
}

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

  it("builds a KATO-only URL without a product query", () => {
    const url = buildLotsNstruSearchUrl({
      katoCode: "351610000",
      year: 2026,
      month: 8,
      statusIds: [210, 220, 230, 240]
    });

    expect(url).toContain("filter%5Bkato%5D=351610000");
    expect(url).not.toContain("filter%5Benstru%5D");
    expect(url).not.toContain("filter%5Bname%5D");
    expect(url.match(/filter%5Bstatus%5D%5B%5D=/g)).toHaveLength(4);
  });

  it("throws unless exactly one product or KATO query is provided", () => {
    expect(() => buildLotsNstruSearchUrl({ year: 2026, month: 7 })).toThrow(/exactly one/);
    expect(() =>
      buildLotsNstruSearchUrl({
        nstruCode: "262011.100.000000",
        nameQuery: "компьютер",
        year: 2026,
        month: 7
      })
    ).toThrow(/exactly one/);
    expect(() =>
      buildLotsNstruSearchUrl({
        nstruCode: "262011.100.000000",
        katoCode: "351610000",
        year: 2026,
        month: 7
      })
    ).toThrow(/exactly one/);
  });
});

describe("pagination safety", () => {
  it("rejects a result set that exceeds the configured page limit", () => {
    expect(() => ensurePageLimitCoversTotal(51, 50)).toThrow(/truncate/i);
  });

  it("accepts a result set fully covered by the configured page limit", () => {
    expect(() => ensurePageLimitCoversTotal(50, 50)).not.toThrow();
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

describe("filterLotRows", () => {
  it("drops lots below the minimum amount", () => {
    const rows = [lotRow({ amount: "100 000" }), lotRow({ amount: "900 000" })];
    const kept = filterLotRows(rows, 500000, []);
    expect(kept).toHaveLength(1);
    expect(kept[0].amount).toBe("900 000");
  });

  it("drops lots whose name is in the stop-list", () => {
    const rows = [lotRow({ lot_name: "Уголок" }), lotRow({ lot_name: "Компьютер" })];
    const kept = filterLotRows(rows, 0, ["Уголок"]);
    expect(kept).toHaveLength(1);
    expect(kept[0].lot_name).toBe("Компьютер");
  });

  it("keeps everything when no filters are configured", () => {
    const rows = [lotRow({ amount: "1" }), lotRow({ lot_name: "Уголок" })];
    expect(filterLotRows(rows, 0, [])).toHaveLength(2);
  });
});

describe("dedupeRows", () => {
  it("merges matched delivery places for the same lot", () => {
    const rows = [
      lotRow({ lot_number: "lot-1", delivery_place: "Балхаш" }),
      lotRow({ lot_number: "lot-1", delivery_place: "Саяк" }),
      lotRow({ lot_number: "lot-2", delivery_place: "Балхаш" })
    ];

    const deduped = dedupeRows(rows);

    expect(deduped).toHaveLength(2);
    expect(deduped[0].delivery_place).toBe("Балхаш; Саяк");
  });
});

describe("Balkhash and Aktogay export config", () => {
  it("contains the requested geography, active statuses and unrestricted product scope", () => {
    const configPath = path.resolve("config/gz-lots-balkhash-aktogay.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      katoLocations: Array<{ name: string; kato: string }>;
      months: number[];
      statuses: string[];
      keywords: string[];
      nstruCodes: string[];
      minAmount: number;
      excludeKeywords: string[];
      outPath: string;
    };

    expect(config.katoLocations).toEqual([
      { name: "Балхаш", kato: "351610000" },
      { name: "Саяк", kato: "351645100" },
      { name: "Шашубай", kato: "353679100" },
      { name: "Торангылык", kato: "353675100" },
      { name: "Актогай", kato: "353630100" }
    ]);
    expect(config.months).toEqual([8, 9, 10, 11, 12]);
    expect(resolveLotStatusIds(config.statuses)).toEqual([210, 220, 230, 240]);
    expect(config.keywords).toEqual([]);
    expect(config.nstruCodes).toEqual([]);
    expect(config.minAmount).toBe(0);
    expect(config.excludeKeywords).toEqual([]);
    expect(config.outPath).toBe("exports/gz-lots-balkhash-aktogay-2026-aug-dec.xlsx");
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
      delivery_place: "Балхаш",
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

    expect(sheet?.getRow(1).getCell(1).value).toBe("Запрос (НСТРУ/слово/КАТО)");
    expect(sheet?.getRow(2).getCell(1).value).toBe("262011.100.000000");
    expect(sheet?.getRow(1).getCell(2).value).toBe("Место поставки");
    expect(sheet?.getRow(2).getCell(2).value).toBe("Балхаш");
    expect(sheet?.getRow(2).getCell(13).value).toEqual({
      text: row.lot_url,
      hyperlink: row.lot_url
    });
    expect(sheet?.views).toContainEqual(expect.objectContaining({ state: "frozen", ySplit: 1 }));
    expect(sheet?.autoFilter).toBe("A1:O2");
    expect(sheet?.getRow(1).fill).toMatchObject({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" }
    });
    expect(sheet?.getRow(1).font).toMatchObject({ bold: true, color: { argb: "FFFFFFFF" } });
    expect(sheet?.getRow(2).alignment).toMatchObject({ vertical: "top", wrapText: true });
    expect(sheet?.getRow(2).getCell(13).font).toMatchObject({
      color: { argb: "FF0563C1" },
      underline: true
    });
  });
});
