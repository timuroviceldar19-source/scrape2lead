import { describe, it, expect } from "vitest";
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
  });

  it("throws clear error when header is missing", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Лист1");
    ws.getRow(1).values = ["Неизвестный", "Заголовок"];

    expect(() => parseRegisterWorkbook(wb, "bad.xlsx")).toThrow(
      /Не найдена строка заголовков/
    );
  });
});

import { pickLatestRegisterFile, parseDateKeyFromFileName } from "../../src/bitrix/salesPult/register/diskClient.js";

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
