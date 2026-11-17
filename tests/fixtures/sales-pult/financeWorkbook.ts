// Выдуманный ежедневный финансовый отчёт той же формы, что у финансиста: блоки в тех же
// колонках, подписи те же. Названия компаний, банков и контрагентов придуманы.
import ExcelJS from "exceljs";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const f = (result: number | undefined) => ({ formula: "SUM(1)", result });

export const FIN_COMPANIES = ["Альфа", "Бета", "Гамма"];

export interface FinanceDebtorFixture {
  name: string;
  company: 0 | 1;
  amount: number;
  date: string;
  note?: string;
}

export const DEFAULT_DEBTORS: FinanceDebtorFixture[] = [
  { name: "Школа Тест №1", company: 0, amount: 5_000_000, date: "2026-11-05" },
  { name: "Колледж Пример", company: 0, amount: 3_000_000, date: "2026-09-01" },
  { name: "Учреждение Образец", company: 1, amount: 2_000_000, date: "2026-06-01", note: "претензия 01.09.2026" }
];

export interface FinanceWorkbookOptions {
  sheetName?: string;
  debtors?: FinanceDebtorFixture[];
  /** Итог дебиторов «Альфы» в файле, если он не равен сумме строк. */
  alphaDebtorsTotal?: number;
  omitDebtors?: boolean;
  omitCash?: boolean;
  /** Остаток «сегодня» в блоке движения денег (по умолчанию равен деньгам на счетах). */
  cashFlowToday?: number;
}

export function financeWorkbook(options: FinanceWorkbookOptions = {}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Справка");
  const ws = wb.addWorksheet(options.sheetName ?? "Ежед.");
  const set = (addr: string, value: unknown) => {
    ws.getCell(addr).value = value as ExcelJS.CellValue;
  };
  const header = (row: number, key: unknown) => {
    set(`J${row}`, key);
    FIN_COMPANIES.forEach((name, i) => set(`${"KLM"[i]}${row}`, name));
    set(`N${row}`, "ИТОГО");
  };
  const account = (row: number, code: number | string, values: number[]) => {
    set(`J${row}`, code);
    values.forEach((v, i) => set(`${"KLM"[i]}${row}`, v));
    set(`N${row}`, f(values.reduce((s, v) => s + v, 0)));
  };

  // Сводка и курсы
  set("A1", "Дата");
  set("B1", f(undefined));
  set("E1", "Октябрь");
  set("G1", "01.11. - 16.11.2026");
  set("A3", "Курс покупки USD");
  set("B3", 450.5);
  set("D3", "Выручка");
  set("E3", f(10_500_000));
  set("G3", f(6_000_000));
  set("D6", "Прибыль");

  // Прошлый месяц
  header(1, d("2026-10-31"));
  account(2, 6000, [10_000_000, 400_000, 0]);
  account(3, 6100, [100_000, 0, 0]);
  account(4, 6200, [0, 0, 0]);
  account(5, 7000, [6_000_000, 300_000, 0]);
  header(7, d("2026-10-31"));
  account(8, 7100, [1_000_000, 50_000, 20_000]);
  account(9, 7200, [500_000, 0, 0]);
  account(10, "8100", [0, 0, 30_000]);

  // Деньги
  if (!options.omitCash) {
    ["B", "C", "D"].forEach((c) => set(`${c}8`, "ДС"));
    set("E8", "Всего");
    set("F8", "ТМЦ");
    set("B9", "Банк Один");
    set("C9", "Банк Два");
    set("D9", "Касса");
    set("E9", "Всего");
    set("F9", "ТМЦ");
    const cash = [
      ["Альфа", 1_000_000, 200_000, 0, 9_000_000],
      ["Бета", 0, 300_000, 0.27, 1_000_000],
      ["Гамма", 50_000, 0, 0, 0]
    ] as const;
    cash.forEach(([name, a, b, c, inv], i) => {
      const r = 10 + i;
      set(`A${r}`, name);
      set(`B${r}`, a);
      set(`C${r}`, b);
      set(`D${r}`, c);
      set(`E${r}`, f(a + b + c));
      set(`F${r}`, inv);
    });
    set("A13", "Итого");
    set("B13", f(1_050_000));
    set("C13", f(500_000));
    set("D13", f(0.27));
    set("E13", f(1_550_000.27));
    set("F13", f(10_000_000));
  }

  // Текущий период
  header(14, d("2026-11-16"));
  account(15, 6000, [6_000_000, 0, 0]);
  account(16, 6100, [0, 0, 0]);
  account(18, 7000, [4_000_000, 0, 0]);
  header(20, d("2026-11-16"));
  account(21, 7100, [500_000, 10_000, 0]);
  account(22, 7200, [100_000, 0, 5_000]);
  header(27, d("2026-11-16"));
  account(28, 1210, [8_100_000, 2_000_000, 0]);
  account(29, 3310, [4_000_000, 100_000, 0]);

  // Поступления за день: плательщики — колонки
  set("B19", "Поступления");
  set("C19", "Поступления");
  set("D19", "Поступления");
  set("E19", "Всего");
  set("B20", "Плательщик Один");
  set("C20", "Плательщик Два");
  set("E20", "Всего");
  set("A21", "Альфа");
  set("B21", 700_000);
  set("C21", 100_000);
  set("A22", "Бета");
  set("A23", "Гамма");
  set("C23", 50_000);
  set("A24", "Итого");
  set("E24", f(850_000));

  // Движение денег за день (под шапкой «Вал.При»)
  header(32, "Вал.При");
  set("J33", d("1899-12-30"));
  set("J36", d("2026-11-16"));
  set("K36", 2_000_000);
  set("J37", d("2026-11-17"));
  set("K37", f(options.cashFlowToday ?? 1_550_000.27));
  set("J38", "Без поступлении");
  set("K38", f(700_000.27));
  set("J39", "Потрачено");
  set("K39", f(1_299_999.73));

  // КПН
  header(42, d("2026-11-11"));
  set("J43", "НОД");
  set("K43", 3_000_000);
  set("J44", "КПН");
  set("K44", f(600_000));
  set("L44", f(20_000));
  set("N44", f(620_000));

  // Платёжный календарь (колонки F–I рядом с дебиторами)
  set("G31", "Календарь");
  set("H31", "Сумма");
  set("I31", "Основание (за что?)");
  set("F32", "А1");
  set("G32", "Поставщик Север");
  set("H32", 1_500_000);
  set("I32", "ТМЦ");
  set("F33", "А1");
  set("G33", "Поставщик Юг");
  set("H33", 700_000);
  set("I33", "Лицензия");
  set("H34", f(2_200_000));
  set("G36", "КПН к оплате");
  set("H36", "Сумма");
  set("G37", "Альфа");
  set("H37", f(600_000));
  set("H38", f(600_000));

  // Дебиторы и проблемные долги
  let r = 31;
  if (!options.omitDebtors) {
    set("A31", "Дебиторы");
    set("B31", "Альфа");
    set("C31", "Бета");
    set("D31", "Дата реализации ");
    set("E31", "ИТОГО");
    const debtors = options.debtors ?? DEFAULT_DEBTORS;
    const alpha = debtors.filter((x) => x.company === 0).reduce((s, x) => s + x.amount, 0);
    const beta = debtors.filter((x) => x.company === 1).reduce((s, x) => s + x.amount, 0);
    set("A32", "1210");
    set("B32", f(options.alphaDebtorsTotal ?? alpha));
    set("C32", f(beta));
    set("E32", f(alpha + beta));
    r = 33;
    for (const x of debtors) {
      set(`A${r}`, x.name);
      set(`${x.company === 0 ? "B" : "C"}${r}`, x.amount);
      set(`D${r}`, d(x.date));
      if (x.note) set(`E${r}`, x.note);
      r++;
    }
    // Проблемные: та же шапка без подписи слева
    set(`B${r}`, "Альфа");
    set(`C${r}`, "Бета");
    set(`E${r}`, "ИТОГО");
    set(`B${r + 1}`, f(400_000));
    set(`C${r + 1}`, f(300_000));
    set(`A${r + 2}`, "ТОО Должник");
    set(`B${r + 2}`, 400_000);
    set(`D${r + 2}`, d("2024-03-01"));
    set(`E${r + 2}`, "Решение суда 01.04.2025");
    set(`A${r + 3}`, "ИП Пропавший");
    set(`C${r + 3}`, 300_000);
    set(`D${r + 3}`, d("2025-01-10"));
    r += 5;
  }
  set(`A${r}`, "Кредиторы");
  set(`B${r}`, f(4_000_000));
  set(`C${r}`, f(100_000));
  set(`E${r}`, f(4_100_000));
  set(`A${r + 1}`, "Кредит Банк Один");
  set(`B${r + 1}`, f(12_000_000));
  set(`E${r + 1}`, f(12_000_000));

  // Прочие платежи и «Топ» ниже
  const p = Math.max(r + 8, 60);
  set(`F${p}`, "А1");
  set(`G${p}`, "Аренда офиса (1-е)");
  set(`H${p}`, 300_000);
  set(`F${p + 1}`, "А1");
  set(`G${p + 2}`, "Зарплата (1-е число)");
  set(`H${p + 2}`, f(900_000));
  set(`G${p + 3}`, "Топ-3 расходов с бюджета");
  set(`G${p + 4}`, "\nПодрядчик Один\nДоговор №1");
  set(`H${p + 4}`, 50_000);
  set(`G${p + 5}`, "Подрядчик Два");
  set(`H${p + 5}`, 20_000);
  set(`G${p + 6}`, "Итого");
  set(`H${p + 6}`, f(70_000));
  return wb;
}

export async function financeWorkbookBuffer(options?: FinanceWorkbookOptions): Promise<Buffer> {
  return Buffer.from(await financeWorkbook(options).xlsx.writeBuffer());
}
