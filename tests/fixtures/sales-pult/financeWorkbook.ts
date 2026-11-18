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
  /** Между банками две пустые колонки (финансист скрывает ненужные банки). */
  cashGap?: boolean;
  /** Добавить листы материальных ведомостей: «Альфа» с приходом/расходом и «Итого», «Бета» без них. */
  stockSheets?: boolean;
  /** Итог «Склада Один» в ведомости «Альфы» больше суммы товаров на 1 000. */
  stockMismatch?: boolean;
}

/** Выдуманная выгрузка 1С «Материальная ведомость» той же формы. */
function addStockSheet(wb: ExcelJS.Workbook, kind: "alpha" | "beta", mismatch = false, name?: string): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name ?? (kind === "alpha" ? "Мат вед Альфа" : "Мат вед Бета"));
  const set = (addr: string, value: unknown) => {
    ws.getCell(addr).value = value as ExcelJS.CellValue;
  };
  const moves = kind === "alpha";
  const company = kind === "alpha" ? "ТОО «Альфа»" : "ТОО \"Бета\"";
  "ABCDEFG".split("").forEach((c) => set(`${c}1`, company));
  "ABCDEFG".split("").forEach((c) => set(`${c}2`, "Материальная ведомость  за Ноябрь 2026 г.\nпо счетам: 1310; 1330"));
  // группы и подписи: [колонка, группа, подпись]
  const layout: Array<[string, string, string]> = moves
    ? [["A", "Склад", "№ п/п"], ["B", "Склад", "Номенклатура"], ["C", "Склад", "Номенклатура"], ["D", "Склад", "Счет учета"], ["E", "Склад", "Код"], ["F", "Склад", "Ед.изм."],
       ["G", "Начальный остаток", "Учетная цена"], ["H", "Начальный остаток", "Учетная цена"], ["I", "Начальный остаток", "Количество"], ["J", "Начальный остаток", "Сумма"],
       ["K", "Итого приход", "Количество"], ["L", "Итого приход", "Сумма"], ["M", "Итого расход", "Количество"], ["N", "Итого расход", "Сумма"],
       ["O", "Конечный остаток", "Учетная цена"], ["P", "Конечный остаток", "Количество"], ["Q", "Конечный остаток", "Сумма"]]
    : [["A", "Склад", "№ п/п"], ["B", "Склад", "Номенклатура"], ["C", "Склад", "Номенклатура"], ["D", "Склад", "Счет учета"], ["E", "Склад", "Код"], ["F", "Склад", "Ед.изм."],
       ["G", "Начальный остаток", "Учетная цена"], ["H", "Начальный остаток", "Учетная цена"], ["I", "Начальный остаток", "Количество"], ["J", "Начальный остаток", "Сумма"],
       ["K", "Конечный остаток", "Учетная цена"], ["L", "Конечный остаток", "Количество"], ["M", "Конечный остаток", "Сумма"]];
  for (const [c, group, sub] of layout) {
    set(`${c}7`, group);
    set(`${c}8`, sub);
  }
  const col = moves
    ? { sQ: "I", sS: "J", iQ: "K", iS: "L", oQ: "M", oS: "N", eQ: "P", eS: "Q" }
    : { sQ: "I", sS: "J", eQ: "L", eS: "M" } as Record<string, string>;
  let r = 9;
  let n = 0;
  const warehouse = (name: string, s: { start: number; in?: number; out?: number; end: number }) => {
    "ABCDEF".split("").forEach((c) => set(`${c}${r}`, name));
    set(`${col.sS}${r}`, s.start);
    if (moves) {
      if (s.in) set(`${col.iS}${r}`, s.in);
      if (s.out) set(`${col.oS}${r}`, s.out);
    }
    set(`${col.eS}${r}`, s.end);
    r++;
  };
  const item = (name: string, unit: string, v: { sQ?: number; sS?: number; iQ?: number; iS?: number; oQ?: number; oS?: number; eQ?: number; eS?: number }) => {
    set(`A${r}`, ++n);
    set(`B${r}`, name);
    set(`C${r}`, name);
    set(`D${r}`, 1310);
    set(`E${r}`, String(n).padStart(11, "0"));
    set(`F${r}`, unit);
    for (const [k, value] of Object.entries(v)) if (value && col[k]) set(`${col[k]}${r}`, value);
    r++;
  };
  if (moves) {
    warehouse("Склад Один", { start: 655_250, in: 600_000, out: 450_000, end: 805_250 + (mismatch ? 1_000 : 0) });
    item("Ноутбук Тест 15", "шт", { sQ: 2, sS: 400_000, iQ: 3, iS: 600_000, oQ: 1, oS: 200_000, eQ: 4, eS: 800_000 });
    item("Монитор Пример 24", "шт", { sQ: 5, sS: 250_000, oQ: 5, oS: 250_000 });
    item("Кабель тестовый", "м", { sQ: 10.5, sS: 5_250, eQ: 10.5, eS: 5_250 });
    warehouse("Склад Два", { start: 150_000, end: 150_000 });
    item("Ноутбук Образец 14", "шт", { sQ: 1, sS: 150_000, eQ: 1, eS: 150_000 });
    "ABCDEF".split("").forEach((c) => set(`${c}${r}`, "Итого"));
    set(`J${r}`, 805_250);
    set(`L${r}`, 600_000);
    set(`N${r}`, 450_000);
    set(`Q${r}`, 955_250);
  } else {
    warehouse("Витрина", { start: 100_000, end: 200_000 });
    item("Ноутбук Демо", "шт", { sQ: 1, sS: 100_000, eQ: 2, eS: 200_000 });
  }
  return ws;
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
    // с пробелом: банки B, C, (D, E пустые), Касса F, Всего G, ТМЦ H
    const [b1, b2, b3] = options.cashGap ? ["B", "C", "F"] : ["B", "C", "D"];
    const [tot, inv] = options.cashGap ? ["G", "H"] : ["E", "F"];
    (options.cashGap ? ["B", "C", "D", "E", "F"] : ["B", "C", "D"]).forEach((c) => set(`${c}8`, "ДС"));
    set(`${tot}8`, "Всего");
    set(`${inv}8`, "ТМЦ");
    set(`${b1}9`, "Банк Один");
    set(`${b2}9`, "Банк Два");
    set(`${b3}9`, "Касса");
    set(`${tot}9`, "Всего");
    set(`${inv}9`, "ТМЦ");
    const cash = [
      ["Альфа", 1_000_000, 200_000, 0, 9_000_000],
      ["Бета", 0, 300_000, 0.27, 1_000_000],
      ["Гамма", 50_000, 0, 0, 0]
    ] as const;
    cash.forEach(([name, a, b, c, stock], i) => {
      const r = 10 + i;
      set(`A${r}`, name);
      set(`${b1}${r}`, a);
      set(`${b2}${r}`, b);
      set(`${b3}${r}`, c);
      set(`${tot}${r}`, f(a + b + c));
      set(`${inv}${r}`, stock);
    });
    set("A13", "Итого");
    set(`${b1}13`, f(1_050_000));
    set(`${b2}13`, f(500_000));
    set(`${b3}13`, f(0.27));
    set(`${tot}13`, f(1_550_000.27));
    set(`${inv}13`, f(10_000_000));
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
  if (options.stockSheets) {
    addStockSheet(wb, "beta");
    addStockSheet(wb, "alpha", options.stockMismatch);
    // скрытый лист той же формы не читается
    addStockSheet(wb, "beta", false, "Мат вед старая").state = "hidden";
    // лист с «Номенклатурой», но без остатков — не ведомость, пропускается молча
    const other = wb.addWorksheet("Прайс");
    other.getCell("A1").value = "Прайс-лист";
    other.getCell("A3").value = "Код";
    other.getCell("B3").value = "Номенклатура";
    other.getCell("C3").value = "Цена";
    other.getCell("B4").value = "Ноутбук Прайс";
    other.getCell("C4").value = 1;
  }
  return wb;
}

export async function financeWorkbookBuffer(options?: FinanceWorkbookOptions): Promise<Buffer> {
  return Buffer.from(await financeWorkbook(options).xlsx.writeBuffer());
}
