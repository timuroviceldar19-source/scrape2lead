import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { FinanceParseError } from "../../src/bitrix/salesPult/finance/parseReport.js";
import { isIncomeStatementWorkbook, parseIncomeStatement } from "../../src/bitrix/salesPult/finance/incomeStatement.js";
import { financeWorkbook } from "../fixtures/sales-pult/financeWorkbook.js";
import {
  IS_COMPANY,
  IS_MONTHS,
  defaultSections,
  fixtureSectionMonthSum,
  incomeStatementWorkbook,
  incomeStatementWorkbookBuffer
} from "../fixtures/sales-pult/incomeStatementWorkbook.js";

// Все данные выдуманные (tests/fixtures/sales-pult/incomeStatementWorkbook.ts).

const lineOf = (st: ReturnType<typeof parseIncomeStatement>, label: RegExp) => {
  const line = st.lines.find((x) => label.test(x.label));
  if (!line) throw new Error(`нет строки ${label}`);
  return line;
};
const valueAt = (st: ReturnType<typeof parseIncomeStatement>, label: RegExp, key: string) =>
  lineOf(st, label).values[st.periods.findIndex((p) => p.key === key)];

describe("ОПиУ: разбор книги ФО", () => {
  it("узнаёт книгу ФО по листам «ОПиУ» и «Расш. ОПиУ», ежедневный отчёт — нет", () => {
    expect(isIncomeStatementWorkbook(incomeStatementWorkbook())).toBe(true);
    expect(isIncomeStatementWorkbook(incomeStatementWorkbook({ noBreakdownSheet: true }))).toBe(true);
    expect(isIncomeStatementWorkbook(financeWorkbook())).toBe(false);
    expect(isIncomeStatementWorkbook(financeWorkbook({ stockSheets: true }))).toBe(false);
  });

  it("периоды — из шапки: свёрнутые месяцы с данными и итоги лет с подписью из файла", () => {
    const st = parseIncomeStatement(incomeStatementWorkbook());
    const months = st.periods.filter((p) => p.kind === "month").map((p) => p.key);
    expect(months).toEqual(IS_MONTHS);
    expect(st.periods.filter((p) => p.kind === "year")).toEqual([
      { key: "2025", kind: "year", year: 2025, label: "2025" },
      { key: "2026", kind: "year", year: 2026, label: "9 мес. 2026" }
    ]);
    // порядок как в файле: месяцы года, затем его итог
    expect(st.periods.map((p) => p.key).indexOf("2025")).toBe(12);
    expect(st.company).toBe(IS_COMPANY);
    expect(st.unit).toBe("тенге без НДС");
  });

  it("строки — как в форме: скрытые, пустые и без подписи пропускаются; вид строки по формуле и формату", () => {
    const st = parseIncomeStatement(incomeStatementWorkbook());
    expect(st.lines.map((x) => [x.label.slice(0, 24), x.code ?? "", x.kind])).toEqual([
      ["Выручка", "010", "item"],
      ["Себестоимость реализован", "011", "item"],
      ["Валовая прибыль (строка ", "012", "subtotal"],
      ["Наценка", "", "ratio"],
      ["Маржа", "", "ratio"],
      ["Расходы по реализации", "013", "item"],
      ["Административные расходы", "014", "item"],
      ["Итого операционная прибы", "020", "subtotal"],
      ["Рентабельность операцион", "", "ratio"],
      ["Финансовые доходы", "021", "item"],
      ["Финансовые расходы", "022", "item"],
      ["Прочие доходы", "024", "item"],
      ["Прочие расходы", "025", "item"],
      ["Прибыль (убыток) до нало", "100", "subtotal"],
      ["Расходы (-) (доходы (+))", "101", "item"],
      ["Прибыль (убыток) после н", "200", "subtotal"],
      ["Общий совокупный доход (", "500", "subtotal"]
    ]);
    expect(st.warnings).toEqual([]);
  });

  it("значения — сохранённые результаты формул: месяц, итог года, доли как в файле", () => {
    const st = parseIncomeStatement(incomeStatementWorkbook());
    const rev = fixtureSectionMonthSum("revenue", "2026-03");
    const cost = fixtureSectionMonthSum("cost", "2026-03");
    expect(valueAt(st, /^Выручка$/, "2026-03")).toBe(rev);
    expect(valueAt(st, /^Валовая/, "2026-03")).toBe(rev - cost);
    expect(valueAt(st, /^Наценка$/, "2026-03")).toBeCloseTo((rev - cost) / cost, 10);
    const year = IS_MONTHS.filter((m) => m.startsWith("2026")).reduce((s, m) => s + fixtureSectionMonthSum("revenue", m), 0);
    expect(valueAt(st, /^Выручка$/, "2026")).toBe(year);
    // в декабре 2025 есть налог — обычное число без формулы
    expect(valueAt(st, /подоходному налогу/, "2025-12")).toBe(400_000);
    expect(valueAt(st, /подоходному налогу/, "2026-03")).toBeNull();
  });

  it("расшифровка привязана формулой ОПиУ к итогу статьи, а не по коду в заголовке", () => {
    const st = parseIncomeStatement(incomeStatementWorkbook());
    const revenue = lineOf(st, /^Выручка$/).breakdown!;
    expect(revenue.title).toBe("Расшифровка Доходов (строка 010 ОПиУ)");
    expect(revenue.rows).toHaveLength(defaultSections()[0].rows.length);
    expect(revenue.rows[0]).toEqual({ label: "ТОО «Школа Пример» Договор № 1/2026 от 10.01.2026 г", months: { "2025-11": 2_000_000, "2026-01": 9_000_000, "2026-03": 4_000_000 } });
    // отрицательная корректировка сохраняется, текст из файла не меняется (экранирует страница)
    expect(revenue.rows[2].months["2026-04"]).toBe(-300_000);
    expect(revenue.rows[3].label).toBe("<b>ТОО «Скобки & Ко»</b> договор № 9 от 01.09.2026");
    // в заголовке «строка 022», но формула «Финансовых доходов» (021) ведёт сюда
    expect(lineOf(st, /^Финансовые доходы$/).breakdown?.title).toBe("Расшифровка Доходов от финансирования (строка 022 ОПиУ)");
    expect(lineOf(st, /^Финансовые расходы$/).breakdown?.title).toBe("Расшифровка Расходов на финасирование (строка ОПиУ)");
    // развёрнутая группа тоже читается; «Руководитель» под последней статьёй в строки не попадает
    expect(lineOf(st, /^Расходы по реализации$/).breakdown?.rows.map((x) => x.label)).toEqual(["Транспортные услуги Реализация"]);
    // расшифровка есть только у статей, итоги и доли не раскрываются
    expect(st.lines.filter((x) => x.breakdown).map((x) => x.code)).toEqual(["010", "011", "013", "014", "021", "022", "024", "025"]);
  });

  it("книга, сохранённая в .xlsx и прочитанная заново, разбирается так же (формулы, свёрнутые группы, формат долей)", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await incomeStatementWorkbookBuffer()) as never);
    expect(isIncomeStatementWorkbook(wb)).toBe(true);
    expect(parseIncomeStatement(wb)).toEqual(parseIncomeStatement(incomeStatementWorkbook()));
  });

  it("сумма строк расшифровки не сходится с ОПиУ — предупреждение, расшифровка остаётся", () => {
    const st = parseIncomeStatement(incomeStatementWorkbook({ revenueMismatch: 1_000 }));
    expect(lineOf(st, /^Выручка$/).breakdown?.rows.length).toBeGreaterThan(0);
    expect(st.warnings).toEqual(["«Выручка»: сумма строк расшифровки не сходится с ОПиУ за март 2026 (разница 1 000 ₸)"]);
  });

  it("книга без формул: расшифровка ищется по коду в заголовке и берётся, только если суммы сходятся", () => {
    const st = parseIncomeStatement(incomeStatementWorkbook({ valuesOnly: true }));
    expect(valueAt(st, /^Выручка$/, "2026-03")).toBe(fixtureSectionMonthSum("revenue", "2026-03"));
    expect(st.lines.filter((x) => x.breakdown).map((x) => x.code)).toEqual(["010", "011", "014", "024", "025"]);
    // «строка 022» в заголовке — это доходы, а не «Финансовые расходы» (022): суммы не сошлись, не привязываем
    expect(lineOf(st, /^Финансовые расходы$/).breakdown).toBeUndefined();
    // вид строки без формул — по подписи и формату
    expect(lineOf(st, /^Валовая/).kind).toBe("subtotal");
    expect(lineOf(st, /^Маржа$/).kind).toBe("ratio");
  });

  it("нет листа расшифровки — ОПиУ без раскрытия", () => {
    const st = parseIncomeStatement(incomeStatementWorkbook({ noBreakdownSheet: true }));
    expect(st.lines.length).toBe(17);
    expect(st.lines.some((x) => x.breakdown)).toBe(false);
  });

  it("лист без шапки «Наименование показателей» с месяцами — ошибка без данных из файла", () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("ОПиУ").getCell("B2").value = "ТОО «Секрет» 123 456 ₸";
    wb.addWorksheet("Расш. ОПиУ");
    expect(() => parseIncomeStatement(wb)).toThrow(FinanceParseError);
    expect(() => parseIncomeStatement(wb)).toThrow(/^на листе «ОПиУ» нет шапки «Наименование показателей» с месяцами$/);
  });
});
