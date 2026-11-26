// Выдуманная книга «ФО» той же формы, что у финансистов: лист «ОПиУ» (форма отчёта о прибылях
// и убытках, месяцы свёрнуты в группы, видны итоги по годам) и лист «Расш. ОПиУ» (под каждой
// статьёй — свёрнутые строки расшифровки, итог статьи — формула SUM по ним). Строка ОПиУ
// ссылается на итог статьи формулой `'Расш. ОПиУ'!C4`, как в настоящем файле.
// Компания, контрагенты, договоры и суммы придуманы.
import ExcelJS from "exceljs";

export const IS_SHEET = "ОПиУ";
export const IS_BREAKDOWN_SHEET = "Расш. ОПиУ";
export const IS_COMPANY = "ТОО «Альфа Тест»";

/** Месяцы с данными: весь 2025 и девять месяцев 2026 (октябрь–декабрь 2026 пустые, как в файле). */
const YEARS = [2025, 2026] as const;
const LAST_MONTH: Record<number, number> = { 2025: 12, 2026: 9 };
export const IS_MONTHS: string[] = YEARS.flatMap((y) =>
  Array.from({ length: LAST_MONTH[y] }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`)
);

export interface BreakdownRowFixture {
  label: string;
  /** Суммы по месяцам `YYYY-MM`; остальные месяцы пустые. */
  values: Record<string, number>;
}

export interface BreakdownSectionFixture {
  key: string;
  title: string;
  rows: BreakdownRowFixture[];
  /** Строки группы не свёрнуты (как «Расходы по реализации» в файле). */
  expanded?: boolean;
}

const at = (pairs: Array<[string, number]>) => Object.fromEntries(pairs);

/** 24 выдуманных покупателя: проверка «показать все» и сортировки по сумме. */
function revenueRows(): BreakdownRowFixture[] {
  const rows: BreakdownRowFixture[] = [
    { label: "ТОО «Школа Пример» Договор № 1/2026 от 10.01.2026 г", values: at([["2026-01", 9_000_000], ["2026-03", 4_000_000], ["2025-11", 2_000_000]]) },
    { label: "КГУ «Гимназия Тест №5» договор № 7 от 01.02.2025", values: at([["2025-02", 6_000_000], ["2026-02", 1_500_000]]) },
    { label: "ИП Образцов договор № 3 от 05.03.2026", values: at([["2026-03", 2_500_000], ["2026-04", -300_000]]) },
    { label: "<b>ТОО «Скобки & Ко»</b> договор № 9 от 01.09.2026", values: at([["2026-09", 700_000]]) }
  ];
  for (let i = 1; i <= 20; i++) {
    const m = String(((i * 5) % 9) + 1).padStart(2, "0");
    rows.push({ label: `ТОО «Покупатель ${String(i).padStart(2, "0")}» договор № ${100 + i} от 01.${m}.2026`, values: at([[`2026-${m}`, 100_000 * i], [`2025-${m}`, 50_000 * i]]) });
  }
  return rows;
}

export function defaultSections(): BreakdownSectionFixture[] {
  return [
    { key: "revenue", title: "Расшифровка Доходов (строка 010 ОПиУ)", rows: revenueRows() },
    { key: "cost", title: "Расшифровка Себестоимости (строка 011 ОПиУ)", rows: [
      { label: "Ноутбуки учебные", values: at([["2026-01", 6_000_000], ["2026-03", 4_200_000], ["2025-02", 4_000_000], ["2025-11", 1_500_000]]) },
      { label: "Мониторы", values: at([["2026-02", 1_000_000], ["2026-05", 300_000], ["2025-05", 200_000]]) },
      { label: "Доставка до заказчика", values: at([["2026-03", 300_000], ["2026-09", 250_000]]) }
    ] },
    { key: "other-income", title: "Расшифровка Прочих доходов (строка 024 ОПиУ)", rows: [
      { label: "Курсовая разница", values: at([["2026-02", 40_000]]) }
    ] },
    { key: "other-expense", title: "Расшифровка Прочих расходов (строка 025 ОПиУ)", rows: [
      { label: "Списание ТМЦ", values: at([["2026-06", 90_000]]) },
      { label: "Штрафы и пени", values: at([["2025-08", 15_000]]) }
    ] },
    { key: "admin", title: "Расшифровка Административных расходов (строка 014 ОПиУ)*", rows: [
      { label: "Заработная плата АУП", values: at(IS_MONTHS.map((m) => [m, 800_000])) },
      { label: "Аренда офиса", values: at(IS_MONTHS.map((m) => [m, 300_000])) },
      { label: "Услуги связи", values: at([["2026-01", 25_000], ["2026-07", 25_000]]) }
    ] },
    // Код строки в заголовке указан неверно (у «Финансовых доходов» в ОПиУ код 021) — как в настоящем файле.
    { key: "fin-income", title: "Расшифровка Доходов от финансирования (строка 022 ОПиУ)", rows: [
      { label: "Вознаграждение по депозиту АО «Банк Пример»", values: at([["2026-04", 60_000], ["2026-05", 61_000]]) }
    ] },
    { key: "fin-expense", title: "Расшифровка Расходов на финасирование (строка ОПиУ)", rows: [
      { label: "Проценты по займу АО «Банк Пример»", values: at([["2026-04", 120_000]]) }
    ] },
    { key: "selling", title: "Расшифровка Расходов по реализации (строка ОПиУ)", expanded: true, rows: [
      { label: "Транспортные услуги Реализация", values: at([["2026-03", 110_000], ["2025-10", 80_000]]) }
    ] }
  ];
}

export interface IncomeStatementWorkbookOptions {
  sections?: BreakdownSectionFixture[];
  /** ОПиУ без формул — только значения (файл «сохранён как значения»). */
  valuesOnly?: boolean;
  /** Выручка в ОПиУ за март 2026 больше суммы строк расшифровки на это число. */
  revenueMismatch?: number;
  /** Без листа «Расш. ОПиУ». */
  noBreakdownSheet?: boolean;
  /** Имя листа ОПиУ (по умолчанию «ОПиУ»). */
  sheetName?: string;
}

// ОПиУ: колонки как в файле — подписи в B, код в N, месяцы года подряд, пустая колонка, итог года.
const OPIU_FIRST_MONTH_COL = 17; // Q
// Расш. ОПиУ: подписи в B, месяцы с C.
const BD_FIRST_MONTH_COL = 3; // C

function colLetter(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

interface YearCols { year: number; months: number[]; total: number }

/** Колонки: для каждого года 12 месяцев, пропуск, итог года, пропуск. */
function yearColumns(first: number): YearCols[] {
  const out: YearCols[] = [];
  let c = first;
  for (const year of YEARS) {
    const months = Array.from({ length: 12 }, (_, i) => c + i);
    c += 12;
    out.push({ year, months, total: c + 1 });
    c += 3;
  }
  return out;
}

const monthKey = (year: number, idx: number) => `${year}-${String(idx + 1).padStart(2, "0")}`;
const hasData = (key: string) => IS_MONTHS.includes(key);

export function incomeStatementWorkbook(options: IncomeStatementWorkbookOptions = {}): ExcelJS.Workbook {
  const sections = options.sections ?? defaultSections();
  const wb = new ExcelJS.Workbook();
  // Лишний лист впереди: книгу узнаём по именам листов, а не по порядку.
  wb.addWorksheet("Фин. анализ").getCell("A1").value = "Анализ";

  const sum = (rows: BreakdownRowFixture[], key: string) => rows.reduce((s, r) => s + (r.values[key] ?? 0), 0);
  const bySection = new Map(sections.map((s) => [s.key, s]));
  const sectionSum = (key: string, month: string) => {
    const s = bySection.get(key);
    return s ? sum(s.rows, month) : 0;
  };

  /* ---------- Расш. ОПиУ ---------- */
  const sectionRow = new Map<string, number>();
  const bdCols = yearColumns(BD_FIRST_MONTH_COL);
  if (!options.noBreakdownSheet) {
    const bd = wb.addWorksheet(IS_BREAKDOWN_SHEET);
    bd.getCell("B1").value = "тенге без НДС";
    const hidden2 = bd.getRow(2);
    hidden2.hidden = true;
    for (const y of bdCols) y.months.forEach((c, i) => { hidden2.getCell(c).value = i + 1; });
    const head = bd.getRow(3);
    head.getCell(2).value = "Наименование статьи";
    for (const y of bdCols) {
      y.months.forEach((c, i) => {
        head.getCell(c).value = new Date(Date.UTC(y.year, i, 1));
        bd.getColumn(c).hidden = true;
        bd.getColumn(c).outlineLevel = 1;
      });
      // у первого года в файле итог — число, у остальных — текст
      head.getCell(y.total).value = y.year === YEARS[0] ? y.year : String(y.year);
    }
    const allTotal = bdCols[bdCols.length - 1].total + 2;
    head.getCell(allTotal).value = "Всего";

    let r = 4;
    for (const s of sections) {
      const top = r;
      sectionRow.set(s.key, top);
      const first = top + 1, last = top + s.rows.length;
      const hr = bd.getRow(top);
      hr.getCell(2).value = s.title;
      hr.getCell(2).font = { bold: true };
      for (const y of bdCols) {
        y.months.forEach((c, i) => {
          const L = colLetter(c);
          const key = monthKey(y.year, i);
          hr.getCell(c).value = { formula: `SUM(${L}${first}:${L}${last})`, result: hasData(key) ? sum(s.rows, key) : undefined } as ExcelJS.CellValue;
        });
      }
      s.rows.forEach((row, k) => {
        const rr = bd.getRow(first + k);
        rr.outlineLevel = 1;
        rr.hidden = !s.expanded;
        rr.getCell(2).value = row.label;
        for (const y of bdCols) {
          y.months.forEach((c, i) => {
            const v = row.values[monthKey(y.year, i)];
            if (v !== undefined) rr.getCell(c).value = v;
          });
          // итог года — формула без сохранённого результата, как у части строк файла
          const a = colLetter(y.months[0]), b = colLetter(y.months[11]);
          rr.getCell(y.total).value = { formula: `SUM(${a}${first + k}:${b}${first + k})` } as ExcelJS.CellValue;
        }
      });
      r = last + 3;
      // повтор шапки месяцев перед следующей статьёй, как в файле
      const rep = bd.getRow(r - 1);
      rep.getCell(2).value = "Наименование статьи";
      rep.getCell(3).value = { formula: "C3", result: new Date(Date.UTC(YEARS[0], 0, 1)) } as ExcelJS.CellValue;
    }
    bd.getRow(r + 1).getCell(2).value = "Руководитель";
  }

  /* ---------- ОПиУ ---------- */
  const ws = wb.addWorksheet(options.sheetName ?? IS_SHEET);
  ws.getCell("D2").value = "Отчет о прибылях и убытках";
  ws.getCell("D4").value = "Индекс:";
  ws.getCell("I4").value = "№2 - ОПУ";
  ws.getCell("D17").value = "Наименование организации";
  ws.getCell("I17").value = IS_COMPANY;
  const cols = yearColumns(OPIU_FIRST_MONTH_COL);
  const head = ws.getRow(20);
  head.getCell(2).value = "Наименование показателей";
  head.getCell(14).value = "Код строки";
  for (const y of cols) {
    y.months.forEach((c, i) => {
      head.getCell(c).value = new Date(Date.UTC(y.year, i, 1));
      ws.getColumn(c).hidden = true;
      ws.getColumn(c).outlineLevel = 1;
    });
    head.getCell(y.total).value = y.year === 2026 ? "9 мес. 2026" : String(y.year);
  }

  type Line = { row: number; label: string; code?: string };
  const L = {
    revenue: { row: 22, label: "Выручка", code: "010" },
    cost: { row: 23, label: "Себестоимость реализованных товаров и услуг", code: "011" },
    gross: { row: 24, label: "Валовая прибыль (строка 010 – строка 011)", code: "012" },
    markup: { row: 25, label: "Наценка" },
    margin: { row: 26, label: "Маржа" },
    selling: { row: 27, label: "Расходы по реализации", code: "013" },
    admin: { row: 28, label: "Административные расходы", code: "014" },
    op: { row: 29, label: "Итого операционная прибыль (убыток) (+/- строки с 012 по 014)", code: "020" },
    opMargin: { row: 30, label: "Рентабельность операционной прибыли" },
    finIncome: { row: 31, label: "Финансовые доходы", code: "021" },
    finExpense: { row: 32, label: "Финансовые расходы", code: "022" },
    otherIncome: { row: 33, label: "Прочие доходы", code: "024" },
    otherExpense: { row: 34, label: "Прочие расходы", code: "025" },
    amort: { row: 35, label: "Амортизация" },
    pretax: { row: 36, label: "Прибыль (убыток) до налогообложения (+/- строки с 020 по 025)", code: "100" },
    tax: { row: 37, label: "Расходы (-) (доходы (+)) по подоходному налогу", code: "101" },
    net: { row: 38, label: "Прибыль (убыток) после налогообложения от продолжающейся деятельности (строка 100 + строка 101)", code: "200" },
    owners: { row: 39, label: "собственников материнской организации" },
    total: { row: 40, label: "Общий совокупный доход (строка 300 + строка 400)", code: "500" },
    netMargin: { row: 41, label: "" }
  } satisfies Record<string, Line>;
  for (const x of Object.values(L)) {
    if (x.label) ws.getRow(x.row).getCell(2).value = x.label;
    if ("code" in x && x.code) ws.getRow(x.row).getCell(14).value = x.code;
  }
  ws.getRow(L.owners.row).hidden = true;

  const linked: Array<[keyof typeof L, string]> = [
    ["revenue", "revenue"], ["cost", "cost"], ["selling", "selling"], ["admin", "admin"],
    ["finIncome", "fin-income"], ["finExpense", "fin-expense"], ["otherIncome", "other-income"], ["otherExpense", "other-expense"]
  ];
  const taxFor = (month: string) => (month.endsWith("-12") ? 400_000 : 0);

  const value = (line: keyof typeof L, month: string): number => {
    const v = (k: keyof typeof L) => value(k, month);
    switch (line) {
      case "revenue": return sectionSum("revenue", month) + (options.revenueMismatch && month === "2026-03" ? options.revenueMismatch : 0);
      case "cost": return sectionSum("cost", month);
      case "selling": return sectionSum("selling", month);
      case "admin": return sectionSum("admin", month);
      case "finIncome": return sectionSum("fin-income", month);
      case "finExpense": return sectionSum("fin-expense", month);
      case "otherIncome": return sectionSum("other-income", month);
      case "otherExpense": return sectionSum("other-expense", month);
      case "gross": return v("revenue") - v("cost");
      case "op": return v("gross") - v("selling") - v("admin");
      case "pretax": return v("op") + v("finIncome") - v("finExpense") + v("otherIncome") - v("otherExpense");
      case "tax": return taxFor(month);
      case "net": return v("pretax") - v("tax");
      case "total": return v("net");
      default: return 0;
    }
  };
  const ratio = (a: number, b: number) => (b ? a / b : undefined);

  for (const y of cols) {
    const months = y.months.map((_, i) => monthKey(y.year, i));
    const yearSum = (line: keyof typeof L) => months.filter(hasData).reduce((s, m) => s + value(line, m), 0);
    y.months.forEach((c, i) => {
      const m = months[i];
      const C = colLetter(c);
      const set = (line: keyof typeof L, formula: string, result: number | undefined, pct = false) => {
        const cell = ws.getRow(L[line].row).getCell(c);
        cell.value = options.valuesOnly ? (result ?? null) : ({ formula, result } as ExcelJS.CellValue);
        if (pct) cell.numFmt = "0%";
      };
      const data = hasData(m);
      for (const [line, key] of linked) {
        const ref = sectionRow.get(key) ?? 4;
        const bdCol = colLetter(bdCols.find((b) => b.year === y.year)!.months[i]);
        const adj = line === "admin" ? `-${C}${L.amort.row}` : "";
        set(line, `'${IS_BREAKDOWN_SHEET}'!${bdCol}${ref}${adj}`, data ? value(line, m) : undefined);
      }
      set("gross", `${C}22-${C}23`, data ? value("gross", m) : undefined);
      set("markup", `${C}24/${C}23`, data ? ratio(value("gross", m), value("cost", m)) : undefined, true);
      set("margin", `${C}24/${C}22`, data ? ratio(value("gross", m), value("revenue", m)) : undefined, true);
      set("op", `${C}24-${C}27-${C}28`, data ? value("op", m) : undefined);
      set("opMargin", `${C}29/${C}22`, data ? ratio(value("op", m), value("revenue", m)) : undefined, true);
      set("pretax", `${C}29+${C}31-${C}32+${C}33-${C}34-${C}35`, data ? value("pretax", m) : undefined);
      if (data && taxFor(m)) ws.getRow(L.tax.row).getCell(c).value = taxFor(m);
      set("net", `${C}36-${C}37`, data ? value("net", m) : undefined);
      set("total", `${C}38`, data ? value("total", m) : undefined);
      set("netMargin", `${C}40/${C}22`, data ? ratio(value("total", m), value("revenue", m)) : undefined, true);
      ws.getRow(L.owners.row).getCell(c).value = "-";
    });
    // итоги года
    const T = y.total;
    const a = colLetter(y.months[0]), b = colLetter(y.months[11]), TL = colLetter(T);
    const setY = (line: keyof typeof L, formula: string, result: number | undefined, pct = false) => {
      const cell = ws.getRow(L[line].row).getCell(T);
      cell.value = options.valuesOnly ? (result ?? null) : ({ formula, result } as ExcelJS.CellValue);
      if (pct) cell.numFmt = "0%";
    };
    for (const line of ["revenue", "cost", "selling", "admin", "finIncome", "finExpense", "otherIncome", "otherExpense", "tax"] as const) {
      setY(line, `SUM(${a}${L[line].row}:${b}${L[line].row})`, yearSum(line));
    }
    setY("amort", `SUM(${a}${L.amort.row}:${b}${L.amort.row})`, undefined);
    setY("gross", `${TL}22-${TL}23`, yearSum("gross"));
    setY("markup", `${TL}24/${TL}23`, ratio(yearSum("gross"), yearSum("cost")), true);
    setY("margin", `${TL}24/${TL}22`, ratio(yearSum("gross"), yearSum("revenue")), true);
    setY("op", `${TL}24-${TL}27-${TL}28`, yearSum("op"));
    setY("opMargin", `${TL}29/${TL}22`, ratio(yearSum("op"), yearSum("revenue")), true);
    setY("pretax", `${TL}29+${TL}31-${TL}32+${TL}33-${TL}34-${TL}35`, yearSum("pretax"));
    setY("net", `${TL}36-${TL}37`, yearSum("net"));
    setY("total", `${TL}38`, yearSum("total"));
    setY("netMargin", `${TL}40/${TL}22`, ratio(yearSum("total"), yearSum("revenue")), true);
  }
  return wb;
}

export async function incomeStatementWorkbookBuffer(options?: IncomeStatementWorkbookOptions): Promise<Buffer> {
  return Buffer.from(await incomeStatementWorkbook(options).xlsx.writeBuffer());
}

/** Ожидаемые суммы фикстуры (для проверок без пересчёта в тестах). */
export function fixtureSectionMonthSum(key: string, month: string, sections = defaultSections()): number {
  const s = sections.find((x) => x.key === key);
  return s ? s.rows.reduce((acc, r) => acc + (r.values[month] ?? 0), 0) : 0;
}
