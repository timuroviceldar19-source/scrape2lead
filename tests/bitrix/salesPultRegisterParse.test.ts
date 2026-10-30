import { afterEach, describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";
import { parseRegisterWorkbook } from "../../src/bitrix/salesPult/register/parseExcel.js";

describe("parseRegisterWorkbook", () => {
  it("parses rows, handles formula results, and extracts manager plans", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");

    // Row 1: totals (should be ignored)
    ws.getRow(1).values = [null, "ИТОГО", 1000000];

    // Row 2: Header row
    ws.getRow(2).values = [
      null,
      "Дата подписания договора", // 1
      "Тип продажи", // 2
      "Контрагент", // 3
      "Кол-во", // 4
      "Товар", // 5
      "Цена за ед без НДС", // 6
      "Сумма без НДС", // 7
      "Windows", // 8
      "Office", // 9
      "Антивирус", // 10
      "Доставка", // 11
      "Установка", // 12
      "Цена продажи за ед без НДС", // 13
      "Сумма продажи без НДС", // 14
      "Сумма договора с портала без НДС", // 15
      "ИТОГО вал", // 16
      "Бонус МОП", // 17
      "Бонус РОП", // 18
      "Менеджер" // 19
    ];

    // Row 3: Data row 1 (ИП - панель, formula result)
    ws.getRow(3).values = [
      null,
      new Date("2026-10-01T00:00:00.000Z"),
      "зцп",
      "КГУ Тестовая школа",
      2,
      "панель",
      500000,
      { formula: "D3*F3", result: 1000000 },
      null, null, null, null, null,
      600000,
      { formula: "D3*M3", result: 1200000 },
      1200000,
      { formula: "N3-G3", result: 200000 },
      { formula: "P3*0.03", result: 6000 },
      { formula: "P3*0.005", result: 1000 },
      "Эльмира"
    ];

    // Row 4: Data row 2 (КТ - моноблок, string date "02.10")
    ws.getRow(4).values = [
      null,
      "02.10",
      "ом",
      "ГУ Аппарат",
      3,
      "моноблок",
      200000,
      600000,
      10000, null, null, null, null,
      300000,
      900000,
      900000,
      290000,
      8700,
      1450,
      "Бекзат"
    ];

    // Row 5: Empty template row with zeros (should be skipped)
    ws.getRow(5).values = [null, null, null, null, 0, null, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null];

    // Row 7: Summary table header
    ws.getRow(7).values = [
      null,
      null,
      "Менеджер",
      "Сумма продажи без НДС",
      "Вал",
      "Бонусы",
      "План на месяц",
      "% выполнения"
    ];

    // Row 8: Manager 1
    ws.getRow(8).values = [null, null, "Эльмира", 1200000, 200000, 6000, 30000000, 0.04];
    // Row 9: Manager 2
    ws.getRow(9).values = [null, null, "Бекзат", 900000, 290000, 8700, 15000000, 0.06];
    // Row 10: B2B
    ws.getRow(10).values = [null, null, "B2B", 0, 0, 0, 40000000, 0];

    const parsed = parseRegisterWorkbook(wb, "ОП 28.10.26.xlsx");

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.asOf).toBe("2026-10-28");
    expect(parsed.month).toBe("2026-10");
    expect(parsed.hasValColumn).toBe(true);

    const row1 = parsed.rows[0];
    expect(row1.date).toBe("2026-10-01");
    expect(row1.type).toBe("зцп");
    expect(row1.channel).toBe("Запрос ценовых предложений");
    expect(row1.product).toBe("панель");
    expect(row1.group).toBe("ИП");
    expect(row1.kind).toBe("Интерактивные панели");
    expect(row1.sale).toBe(1200000);
    expect(row1.val).toBe(200000);
    expect(row1.bonusMop).toBe(6000);
    expect(row1.bonusRop).toBe(1000);
    expect(row1.manager).toBe("Эльмира");

    const row2 = parsed.rows[1];
    expect(row2.date).toBe("2026-10-02");
    expect(row2.channel).toBe("Электронный магазин");
    expect(row2.group).toBe("КТ");
    expect(row2.kind).toBe("Моноблоки");
    expect(row2.sale).toBe(900000);
    expect(row2.val).toBe(290000);

    expect(parsed.plans).toEqual({
      "Эльмира": 30000000,
      "Бекзат": 15000000,
      "B2B": 40000000
    });
  });

  it("handles scrambled column positions correctly", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");

    // Scrambled header in row 1
    ws.getRow(1).values = [
      null,
      "Менеджер",
      "Сумма продажи без НДС",
      "Товар",
      "Контрагент",
      "Дата подписания договора",
      "Тип продажи",
      "ИТОГО вал",
      "Кол-во"
    ];

    ws.getRow(2).values = [
      null,
      "Жанат",
      500000,
      "ноутбук",
      "ТОО Пример",
      "2026-10-05",
      "ок",
      150000,
      1
    ];

    const parsed = parseRegisterWorkbook(wb, "ОП 05.10.26.xlsx");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].manager).toBe("Жанат");
    expect(parsed.rows[0].sale).toBe(500000);
    expect(parsed.rows[0].val).toBe(150000);
    expect(parsed.rows[0].group).toBe("КТ");
    expect(parsed.rows[0].kind).toBe("Ноутбуки");
    expect(parsed.rows[0].channel).toBe("Открытый конкурс");
    expect(parsed.hasValColumn).toBe(true);
  });

  it("throws clear error when header is missing", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");
    ws.getRow(1).values = ["Неизвестный", "Заголовок"];

    expect(() => parseRegisterWorkbook(wb, "bad.xlsx")).toThrow(
      /Не найдена строка заголовков/
    );
  });

  it("handles header 'Дата договора' (format 01.10–09.10)", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");

    ws.getRow(1).values = [
      null,
      "Дата договора",
      "Тип продажи",
      "Контрагент",
      "Кол-во",
      "Товар",
      "Сумма без НДС",
      "Сумма продажи без НДС",
      "ИТОГО вал",
      "Менеджер"
    ];

    ws.getRow(2).values = [
      null,
      "2026-10-02",
      "ом",
      "ТОО Синтетик Тест",
      1,
      "моноблок",
      100000,
      150000,
      50000,
      "Менеджер А"
    ];

    const parsed = parseRegisterWorkbook(wb, "ОП 02.10.26.xlsx");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].date).toBe("2026-10-02");
    expect(parsed.rows[0].sale).toBe(150000);
    expect(parsed.rows[0].val).toBe(50000);
    expect(parsed.hasValColumn).toBe(true);
  });

  it("handles workbook without 'ИТОГО вал' column: hasValColumn is false and val is null without computing sale - cost", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");

    ws.getRow(1).values = [
      null,
      "Дата подписания договора",
      "Тип продажи",
      "Контрагент",
      "Кол-во",
      "Товар",
      "Сумма без НДС",
      "Сумма продажи без НДС",
      "Менеджер"
    ];

    ws.getRow(2).values = [
      null,
      "2026-09-15",
      "зцп",
      "ТОО Пример Без Вала",
      2,
      "панель",
      200000,
      300000,
      "Менеджер Б"
    ];

    const parsed = parseRegisterWorkbook(wb, "ОП 30.09.26.xlsx");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].sale).toBe(300000);
    expect(parsed.rows[0].cost).toBe(200000);
    expect(parsed.hasValColumn).toBe(false);
    expect(parsed.rows[0].val).toBeNull();
  });
});

import {
  fetchLatestRegisterFromDisk,
  pickLatestRegisterFile,
  pickMonthlyFinalRegisterFiles,
  parseDateKeyFromFileName
} from "../../src/bitrix/salesPult/register/diskClient.js";
import { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";

describe("pickLatestRegisterFile", () => {
  it("picks latest file by date from filename, then by UPDATE_TIME", () => {
    expect(parseDateKeyFromFileName("ОП 28.10.26.xlsx")).toBe("2026-10-28");
    expect(parseDateKeyFromFileName("ОП 05.10.2026.xlsx")).toBe("2026-10-05");

    const items = [
      { ID: 1, NAME: "ОП 25.10.26.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-10-25T10:00:00" },
      { ID: 2, NAME: "ОП 28.10.26.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-10-28T09:00:00" },
      { ID: 3, NAME: "ОП 28.10.26.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-10-28T12:00:00" },
      { ID: 4, NAME: "другой.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-10-29T12:00:00" }
    ];

    const latest = pickLatestRegisterFile(items);
    expect(latest?.ID).toBe(3);
  });
});

describe("pickMonthlyFinalRegisterFiles", () => {
  it("picks the final file of each month, prioritizing later dateKey and later UPDATE_TIME on same date", () => {
    const items = [
      { ID: 10, NAME: "ОП 30.07.26.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-07-30T10:00:00" },
      { ID: 11, NAME: "ОП 31.07.26.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-07-31T16:11:40" },
      { ID: 12, NAME: "ОП 31.07.26 (1).xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-08-03T08:58:36" },
      { ID: 20, NAME: "ОП 25.08.26.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-08-25T10:00:00" },
      { ID: 21, NAME: "ОП 31.08.26.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-08-31T18:00:00" },
      { ID: 30, NAME: "image.png", TYPE: "file" as const, UPDATE_TIME: "2026-08-31T18:00:00" },
      { ID: 40, NAME: "ОП 28.10.26.xlsx", TYPE: "file" as const, UPDATE_TIME: "2026-10-28T17:00:00" }
    ];

    const monthly = pickMonthlyFinalRegisterFiles(items);
    expect(monthly.get("2026-07")?.ID).toBe(12);
    expect(monthly.get("2026-07")?.NAME).toBe("ОП 31.07.26 (1).xlsx");
    expect(monthly.get("2026-08")?.ID).toBe(21);
    expect(monthly.get("2026-10")?.ID).toBe(40);
    expect(monthly.has("2026-09")).toBe(false);
  });
});

describe("fetchLatestRegisterFromDisk", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads every page of the folder and downloads the latest register even when it is on the second page", async () => {
    const files = Array.from({ length: 60 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 7, 1) + i * 86_400_000);
      const name = `ОП ${String(day.getUTCDate()).padStart(2, "0")}.${String(day.getUTCMonth() + 1).padStart(2, "0")}.26.xlsx`;
      return { ID: 1000 + i, NAME: name, TYPE: "file", DOWNLOAD_URL: `https://disk.example/${1000 + i}` };
    });
    // BitrixClient.call returns the unwrapped `result`; a batch answers { result: { p0: [...] }, result_error: {} }.
    const transport = {
      call: vi.fn(async (method: string, body: any) => {
        if (method !== "batch") throw new Error(`unexpected ${method}`);
        const result: Record<string, unknown> = {};
        for (const [key, command] of Object.entries(body.cmd as Record<string, string>)) {
          const start = Number(new URLSearchParams(command.split("?")[1]).get("start") ?? 0);
          result[key] = files.slice(start, start + 50);
        }
        return { result, result_error: {} };
      })
    };
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b, 3, 4])));
    vi.stubGlobal("fetch", fetchMock);

    const file = await fetchLatestRegisterFromDisk(new ReadOnlyBitrixClient(transport), 89975);

    expect(file?.fileName).toBe("ОП 29.09.26.xlsx");
    expect(fetchMock).toHaveBeenCalledWith("https://disk.example/1059");
    expect(file?.buffer.subarray(0, 2).toString()).toBe("PK");
  });
});
