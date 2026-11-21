// Разбор ежедневного финансового отчёта (лист «Ежед.»).
//
// Файл собран руками: список дебиторов каждый день разной длины, и всё, что ниже, сдвигается.
// Поэтому блоки ищутся по подписям («Дебиторы», «Календарь», «Поступления», «Всего | ТМЦ»,
// шапка с компаниями и «ИТОГО»), а не по адресам ячеек. Итоги сверяются: расхождение идёт
// в `warnings` и показывается на странице, а пропавший блок останавливает разбор —
// лучше показать вчерашний отчёт, чем неверные цифры.
//
// В сообщениях об ошибках нет сумм и названий из файла: они попадают в публичный лог Actions.

import type ExcelJS from "exceljs";
import type {
  FinanceBalanceLine,
  FinanceCash,
  FinanceCashFlow,
  FinanceCompanyValues,
  FinanceDebtor,
  FinanceDebtorColumn,
  FinanceDebtors,
  FinanceIncoming,
  FinanceLiability,
  FinancePayment,
  FinancePaymentList,
  FinancePnl,
  FinanceRate,
  FinanceReport,
  FinanceSnapshot,
  FinanceStock,
  FinanceStockItem,
  FinanceStockSums,
  FinanceStockWarehouse,
  FinanceTax
} from "./types.js";

export class FinanceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceParseError";
  }
}

type Cell = number | string | Date | null;

const DAY_MS = 86_400_000;

function normalizeValue(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.replace(/\s+/g, " ").trim();
    return t ? t : null;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o || "formula" in o || "sharedFormula" in o) return normalizeValue(o.result);
    if (Array.isArray(o.richText)) {
      return normalizeValue((o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join(""));
    }
    if ("text" in o) return normalizeValue(o.text);
  }
  return null;
}

/** Подпись для сравнения: регистр, «ё», точки, двоеточия и лишние пробелы не важны. */
export function labelKey(s: string | null | undefined): string {
  return String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[\s.:]+/g, " ").trim();
}

function isoDay(d: Date): string | null {
  const rounded = new Date(Math.round(d.getTime() / DAY_MS) * DAY_MS);
  return rounded.getUTCFullYear() >= 2000 ? rounded.toISOString().slice(0, 10) : null;
}

class Grid {
  constructor(private readonly cells: Cell[][], readonly maxRow: number, readonly maxCol: number) {}

  get(r: number, c: number): Cell {
    if (r < 1 || c < 1) return null;
    return this.cells[r]?.[c] ?? null;
  }

  text(r: number, c: number): string | null {
    const v = this.get(r, c);
    return typeof v === "string" ? v : null;
  }

  num(r: number, c: number): number | null {
    const v = this.get(r, c);
    return typeof v === "number" ? v : null;
  }

  date(r: number, c: number): string | null {
    const v = this.get(r, c);
    return v instanceof Date ? isoDay(v) : null;
  }

  key(r: number, c: number): string {
    return labelKey(this.text(r, c));
  }

  /** Первая ячейка, чья подпись проходит проверку (по строкам сверху вниз). */
  find(test: (key: string) => boolean, fromRow = 1): { r: number; c: number } | null {
    for (let r = fromRow; r <= this.maxRow; r++) {
      for (let c = 1; c <= this.maxCol; c++) {
        const t = this.text(r, c);
        if (t && test(labelKey(t))) return { r, c };
      }
    }
    return null;
  }
}

function gridFromSheet(ws: ExcelJS.Worksheet): Grid {
  const maxRow = ws.rowCount;
  const maxCol = ws.columnCount;
  const cells: Cell[][] = [];
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    const out: Cell[] = [];
    for (let c = 1; c <= maxCol; c++) out[c] = normalizeValue(row.getCell(c).value);
    cells[r] = out;
  }
  return new Grid(cells, maxRow, maxCol);
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const differs = (a: number, b: number) => Math.abs(a - b) > 1;
const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const fmt = (n: number) => `${nf.format(Math.round(n))} ₸`;

/* ---------- блоки счетов: шапка «дата | компании… | ИТОГО» ---------- */

interface CompanyHeader {
  keyCol: number;
  cols: number[];
  totalCol: number;
  names: string[];
}

interface AccountRow {
  row: number;
  /** Дата шапки блока или null, если в шапке подпись (например «Вал.При»). */
  date: string | null;
  code?: string;
  label?: string;
  values: number[];
  total: number;
}

function findCompanyHeader(g: Grid): CompanyHeader {
  for (let r = 1; r <= g.maxRow; r++) {
    for (let c = 2; c <= g.maxCol; c++) {
      if (g.key(r, c) !== "итого") continue;
      const names: string[] = [];
      let k = c - 1;
      while (k >= 1 && g.text(r, k)) {
        names.unshift(g.text(r, k)!);
        k--;
      }
      if (names.length >= 2 && k >= 1 && g.date(r, k) && new Set(names.map(labelKey)).size === names.length) {
        return { keyCol: k, cols: names.map((_, i) => k + 1 + i), totalCol: c, names };
      }
    }
  }
  throw new FinanceParseError("не найдена шапка блоков счетов (дата, компании, «ИТОГО»)");
}

function readAccountRows(g: Grid, h: CompanyHeader): AccountRow[] {
  const headerKeys = h.names.map(labelKey);
  const isHeader = (r: number) => g.key(r, h.totalCol) === "итого" && h.cols.every((c, i) => g.key(r, c) === headerKeys[i]);
  const rows: AccountRow[] = [];
  let current: { date: string | null } | null = null;
  for (let r = 1; r <= g.maxRow; r++) {
    if (isHeader(r)) {
      current = { date: g.date(r, h.keyCol) };
      continue;
    }
    if (!current) continue;
    const keyCell = g.get(r, h.keyCol);
    let code: string | undefined;
    let label: string | undefined;
    if (typeof keyCell === "number" && Number.isInteger(keyCell) && keyCell >= 1000 && keyCell <= 9999) code = String(keyCell);
    else if (typeof keyCell === "string" && /^\d{4}$/.test(keyCell)) code = keyCell;
    else if (typeof keyCell === "string") label = keyCell;
    else continue;
    const values = h.cols.map((c) => g.num(r, c) ?? 0);
    rows.push({ row: r, date: current.date, code, label, values, total: g.num(r, h.totalCol) ?? sum(values) });
  }
  return rows;
}

function companyValues(values: number[]): FinanceCompanyValues {
  return { values, total: sum(values) };
}

function pnlFor(rows: AccountRow[], date: string, size: number): FinancePnl | undefined {
  const own = rows.filter((x) => x.date === date && x.code);
  const pick = (test: (code: number) => boolean) => {
    const out = new Array<number>(size).fill(0);
    for (const x of own) if (test(Number(x.code))) x.values.forEach((v, i) => (out[i] += v));
    return out;
  };
  if (!own.some((x) => Number(x.code) >= 6000 && Number(x.code) < 7000)) return undefined;
  const revenue = pick((c) => c >= 6000 && c < 7000);
  const cost = pick((c) => c === 7000);
  const expenses = pick((c) => c > 7000 && c < 9000);
  const profit = revenue.map((v, i) => v - cost[i] - expenses[i]);
  return { date, revenue: companyValues(revenue), cost: companyValues(cost), expenses: companyValues(expenses), profit: companyValues(profit) };
}

const BALANCE_LABELS: Record<string, string> = {
  "1210": "Дебиторка покупателей",
  "1710": "Долгосрочная дебиторка",
  "3310": "Долги поставщикам",
  "3510": "Авансы полученные"
};

/* ---------- деньги: «Всего | ТМЦ» ---------- */

function parseCash(g: Grid, warnings: string[]): FinanceCash {
  for (let r = 1; r <= g.maxRow; r++) {
    for (let c = 3; c <= g.maxCol; c++) {
      if (g.key(r, c) !== "тмц" || g.key(r, c - 1) !== "всего") continue;
      const totalCol = c - 1;
      // Компании — ближайшая слева колонка, где под шапкой текст (названия), у банков там числа.
      // Между ней и «Всего» — банки; пустые колонки (финансист скрывает ненужные банки) пропускаются.
      let companyCol = 0;
      for (let k = totalCol - 1; k >= 1 && !companyCol; k--) if (g.text(r + 1, k)) companyCol = k;
      if (!companyCol) continue;
      const bankCols: number[] = [];
      for (let k = companyCol + 1; k < totalCol; k++) if (g.text(r, k)) bankCols.push(k);
      if (!bankCols.length || bankCols.every((k) => g.key(r, k) === "дс")) continue;
      const banks = bankCols.map((k) => g.text(r, k)!);
      const rows: FinanceCash["rows"] = [];
      let totalsRow: number | null = null;
      for (let rr = r + 1; rr <= Math.min(g.maxRow, r + 40); rr++) {
        const company = g.text(rr, companyCol);
        if (!company) break;
        if (labelKey(company) === "итого") {
          totalsRow = rr;
          break;
        }
        const byBank = bankCols.map((k) => g.num(rr, k) ?? 0);
        rows.push({ company, byBank, total: g.num(rr, totalCol) ?? sum(byBank), inventory: g.num(rr, c) ?? 0 });
      }
      if (!rows.length) throw new FinanceParseError("в блоке денег нет строк по компаниям");
      const rowsTotal = sum(rows.map((x) => x.total));
      const rowsInventory = sum(rows.map((x) => x.inventory));
      let byBank = banks.map((_, i) => sum(rows.map((x) => x.byBank[i])));
      let total = rowsTotal;
      let inventory = rowsInventory;
      if (totalsRow) {
        byBank = bankCols.map((k, i) => g.num(totalsRow!, k) ?? byBank[i]);
        total = g.num(totalsRow, totalCol) ?? rowsTotal;
        inventory = g.num(totalsRow, c) ?? rowsInventory;
        if (differs(total, rowsTotal)) warnings.push(`Деньги: итог в файле ${fmt(total)}, сумма строк ${fmt(rowsTotal)}`);
        // деньги в колонке без названия банка не попадут в таблицу — сверка по банкам это покажет
        if (differs(total, sum(byBank))) warnings.push(`Деньги: «Всего» ${fmt(total)}, сумма по банкам ${fmt(sum(byBank))}`);
        if (differs(inventory, rowsInventory)) warnings.push(`ТМЦ: итог в файле ${fmt(inventory)}, сумма строк ${fmt(rowsInventory)}`);
      } else {
        warnings.push("Деньги: в файле нет строки «Итого», итог посчитан по строкам");
      }
      return { banks, rows, byBank, total, inventory };
    }
  }
  throw new FinanceParseError("не найден блок денег (шапка «Всего | ТМЦ» с банками)");
}

/* ---------- движение денег за день ---------- */

function parseCashFlow(accountRows: AccountRow[], g: Grid, h: CompanyHeader, cash: FinanceCash, warnings: string[]): FinanceCashFlow | undefined {
  const noIncoming = accountRows.find((x) => x.label && labelKey(x.label).startsWith("без поступлен"));
  if (!noIncoming) return undefined;
  const firstCol = h.cols[0];
  const dated = [noIncoming.row - 2, noIncoming.row - 1].map((r) => ({ r, date: g.date(r, h.keyCol), value: g.num(r, firstCol) }));
  if (dated.some((d) => !d.date || d.value === null)) return undefined;
  const [prev, today] = dated;
  if (differs(today.value!, cash.total)) {
    warnings.push(`Движение денег за день: остаток ${fmt(today.value!)} не равен деньгам на счетах ${fmt(cash.total)}, блок не показан`);
    return undefined;
  }
  const spentRow = accountRows.find((x) => x.label && labelKey(x.label).startsWith("потрачено"));
  return {
    prevDate: prev.date!,
    prev: prev.value!,
    today: today.value!,
    withoutIncoming: g.num(noIncoming.row, firstCol) ?? undefined,
    spent: spentRow ? g.num(spentRow.row, firstCol) ?? undefined : undefined
  };
}

/* ---------- поступления за день ---------- */

function parseIncoming(g: Grid, warnings: string[]): { items: FinanceIncoming[]; total: number } {
  const start = g.find((k) => k === "поступления");
  if (!start) {
    warnings.push("Не найден блок «Поступления»");
    return { items: [], total: 0 };
  }
  const { r, c } = start;
  let totalCol = 0;
  for (const rr of [r, r + 1]) {
    for (let k = c + 1; k <= g.maxCol && !totalCol; k++) if (g.key(rr, k) === "всего") totalCol = k;
  }
  if (!totalCol) {
    warnings.push("В блоке «Поступления» нет колонки «Всего»");
    return { items: [], total: 0 };
  }
  const companyCol = c - 1;
  const payerCols = Array.from({ length: totalCol - c }, (_, i) => c + i);
  const items: FinanceIncoming[] = [];
  let fileTotal: number | null = null;
  for (let rr = r + 2; rr <= Math.min(g.maxRow, r + 40); rr++) {
    const company = g.text(rr, companyCol);
    if (!company) break;
    if (labelKey(company) === "итого") {
      fileTotal = g.num(rr, totalCol);
      break;
    }
    for (const k of payerCols) {
      const amount = g.num(rr, k);
      if (amount) items.push({ payer: g.text(r + 1, k) ?? "без названия", company, amount });
    }
  }
  const total = sum(items.map((x) => x.amount));
  if (fileTotal !== null && differs(fileTotal, total)) warnings.push(`Поступления: итог в файле ${fmt(fileTotal)}, сумма строк ${fmt(total)}`);
  return { items, total };
}

/* ---------- дебиторы и проблемные долги ---------- */

interface DebtorLayout {
  nameCol: number;
  companyCols: number[];
  companies: string[];
  dateCol: number;
  totalCol: number;
  /** Необязательные колонки между датой реализации и «ИТОГО», найденные по подписи. */
  extra: Partial<Record<FinanceDebtorColumn, number>>;
}

// Подписи необязательных колонок. С 20.11.2026 их четыре; раньше были только две про иск
// (скрытые). Незнакомая колонка просто пропускается.
const DEBTOR_COLUMNS: Array<[FinanceDebtorColumn, (key: string) => boolean]> = [
  ["paymentDate", (k) => k.startsWith("дата оплат")],
  ["daysToPay", (k) => k.startsWith("дней до оплат") || k.startsWith("дни до оплат")],
  ["claimDate", (k) => k.startsWith("дата подачи иска") || k.startsWith("дата иска")],
  ["claimNumber", (k) => k.startsWith("номер иска") || k.startsWith("№ иска")]
];
/** Сколько колонок после даты реализации может занять шапка до «ИТОГО». */
const DEBTOR_MAX_EXTRA = 10;

/** Дата из ячейки: настоящая дата или текст «дд.мм.гггг». */
function dateLike(g: Grid, r: number, c: number): string | undefined {
  const asDate = g.date(r, c);
  if (asDate) return asDate;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(g.text(r, c) ?? "");
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : undefined;
}

function textLike(g: Grid, r: number, c: number): string | undefined {
  const v = g.get(r, c);
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function readDebtorRows(g: Grid, layout: DebtorLayout, headerRow: number, title: string, warnings: string[]): { list: FinanceDebtors; endRow: number } {
  const totalsRow = headerRow + 1;
  const rows: FinanceDebtor[] = [];
  const { extra } = layout;
  // С 20.11.2026 дебиторы компаний разделены пустой строкой. Пустую строку перешагиваем, только
  // если за ней снова должник: есть дата реализации и сумма по компании. Так список не
  // захватывает «Кредиторы» и строки ниже (у них даты нет).
  const isDebtorRow = (row: number) => {
    const name = g.text(row, layout.nameCol);
    return !!name && !labelKey(name).startsWith("кредит") && !!g.date(row, layout.dateCol) && layout.companyCols.some((col) => !!g.num(row, col));
  };
  let r = headerRow + 2;
  for (; r <= g.maxRow; r++) {
    let name = g.text(r, layout.nameCol);
    if (!name) {
      const blank = (row: number) => layout.companyCols.every((col) => g.get(row, col) === null) && g.get(row, layout.dateCol) === null;
      let next = r;
      while (next <= Math.min(g.maxRow, r + 1) && !g.text(next, layout.nameCol) && blank(next)) next++;
      if (next === r || next > g.maxRow || !isDebtorRow(next)) break;
      r = next;
      name = g.text(r, layout.nameCol)!;
    }
    const saleDate = g.date(r, layout.dateCol) ?? undefined;
    const paymentDate = extra.paymentDate ? dateLike(g, r, extra.paymentDate) : undefined;
    const claimDate = extra.claimDate ? dateLike(g, r, extra.claimDate) : undefined;
    const claimNumber = extra.claimNumber ? textLike(g, r, extra.claimNumber) : undefined;
    const note = g.text(r, layout.totalCol) ?? undefined;
    layout.companyCols.forEach((col, i) => {
      const amount = g.num(r, col);
      if (amount) {
        rows.push({
          name,
          company: layout.companies[i],
          amount,
          ...(saleDate ? { saleDate } : {}),
          ...(paymentDate ? { paymentDate } : {}),
          ...(claimDate ? { claimDate } : {}),
          ...(claimNumber ? { claimNumber } : {}),
          ...(note ? { note } : {})
        });
      }
    });
  }
  const totals = layout.companies.map((company) => sum(rows.filter((x) => x.company === company).map((x) => x.amount)));
  layout.companyCols.forEach((col, i) => {
    const fileTotal = g.num(totalsRow, col);
    if (fileTotal !== null && differs(fileTotal, totals[i])) {
      warnings.push(`${title}, ${layout.companies[i]}: итог в файле ${fmt(fileTotal)}, сумма строк ${fmt(totals[i])}`);
    }
  });
  return { list: { companies: layout.companies, rows, totals, total: sum(totals) }, endRow: r };
}

function parseDebtors(g: Grid, warnings: string[]): { debtors: FinanceDebtors; problem?: FinanceDebtors; layout: DebtorLayout } {
  const start = g.find((k) => k === "дебиторы");
  if (!start) throw new FinanceParseError("не найден блок «Дебиторы»");
  const { r, c } = start;
  const companyCols: number[] = [];
  let k = c + 1;
  for (; k <= g.maxCol && g.text(r, k) && !g.key(r, k).startsWith("дата"); k++) companyCols.push(k);
  if (!companyCols.length || !g.key(r, k).startsWith("дата")) throw new FinanceParseError("в шапке «Дебиторы» нет компаний и «Даты реализации»");
  const dateCol = k;
  let totalCol = 0;
  const extra: DebtorLayout["extra"] = {};
  for (let t = dateCol + 1; t <= Math.min(g.maxCol, dateCol + 1 + DEBTOR_MAX_EXTRA) && !totalCol; t++) {
    const key = g.key(r, t);
    if (key === "итого") {
      totalCol = t;
      break;
    }
    const known = DEBTOR_COLUMNS.find(([id, test]) => !extra[id] && test(key));
    if (known) extra[known[0]] = t;
  }
  if (!totalCol) throw new FinanceParseError("в шапке «Дебиторы» нет «ИТОГО»");
  const layout: DebtorLayout = { nameCol: c, companyCols, companies: companyCols.map((col) => g.text(r, col)!), dateCol, totalCol, extra };
  const columns = DEBTOR_COLUMNS.map(([id]) => id).filter((id) => extra[id]);

  const main = readDebtorRows(g, layout, r, "Дебиторы", warnings);
  if (!main.list.rows.length) throw new FinanceParseError("в блоке «Дебиторы» нет строк");
  if (columns.length) main.list.columns = columns;

  // Ниже, без подписи слева, — второй список с той же шапкой: долги в суде и у юристов.
  const companyKeys = layout.companies.map(labelKey);
  let problem: FinanceDebtors | undefined;
  for (let rr = main.endRow; rr <= Math.min(g.maxRow, main.endRow + 6); rr++) {
    const same = g.key(rr, totalCol) === "итого" && companyCols.every((col, i) => g.key(rr, col) === companyKeys[i]);
    if (same) {
      problem = readDebtorRows(g, layout, rr, "Проблемные долги", warnings).list;
      if (columns.length) problem.columns = columns;
      break;
    }
  }
  return { debtors: main.list, problem, layout };
}

function parseLiabilities(g: Grid, layout: DebtorLayout): FinanceLiability[] {
  const out: FinanceLiability[] = [];
  for (let r = 1; r <= g.maxRow; r++) {
    const label = g.text(r, layout.nameCol);
    if (!label || !labelKey(label).startsWith("кредит")) continue;
    const values = layout.companyCols.map((col) => g.num(r, col) ?? 0);
    if (values.every((v) => v === 0) && g.num(r, layout.totalCol) === null) continue;
    out.push({ label, values, total: g.num(r, layout.totalCol) ?? sum(values) });
  }
  return out;
}

/* ---------- платёжный календарь ---------- */

function parsePayments(g: Grid, warnings: string[]): FinancePaymentList[] {
  const start = g.find((k) => k === "календарь");
  if (!start) {
    warnings.push("Не найден блок «Календарь»");
    return [];
  }
  // Колонки списка считаются от колонки получателя: слева пометка, справа сумма и основание.
  // Основание есть, только если над ним в шапке «Календаря» подпись «Основание…»: правее
  // сдвинутых списков начинаются блоки счетов, их подписи основанием не считаются.
  interface PayCols {
    tag: number;
    payee: number;
    amount: number;
    basis: number | null;
  }
  const colsAt = (payee: number): PayCols => ({
    tag: payee - 1,
    payee,
    amount: payee + 1,
    basis: g.key(start.r, payee + 2).startsWith("основание") ? payee + 2 : null
  });
  const calendarCols = colsAt(start.c);
  const payeeCol = calendarCols.payee;
  const amountCol = calendarCols.amount;
  const item = (r: number, cols: PayCols = calendarCols): FinancePayment => {
    const tag = g.text(r, cols.tag) ?? undefined;
    const basis = cols.basis ? g.text(r, cols.basis) ?? undefined : undefined;
    return { ...(tag ? { tag } : {}), payee: g.text(r, cols.payee)!, amount: g.num(r, cols.amount)!, ...(basis ? { basis } : {}) };
  };
  const finish = (list: FinancePaymentList, fileTotal: number | null) => {
    const total = sum(list.items.map((x) => x.amount));
    if (fileTotal !== null && differs(fileTotal, total)) warnings.push(`${list.label}: итог в файле ${fmt(fileTotal)}, сумма строк ${fmt(total)}`);
    list.total = total;
    return list;
  };

  const lists: FinancePaymentList[] = [];
  const main: FinancePaymentList = { label: "Календарь платежей", items: [], total: 0 };
  let r = start.r + 1;
  let mainTotal: number | null = null;
  for (; r <= g.maxRow; r++) {
    const payee = g.text(r, payeeCol);
    const amount = g.num(r, amountCol);
    if (!payee && amount !== null) {
      mainTotal = amount;
      r++;
      break;
    }
    if (!payee && amount === null) {
      if (main.items.length) break;
      continue;
    }
    if (payee && amount !== null) main.items.push(item(r));
  }
  lists.push(finish(main, mainTotal));

  // Ниже: блок «КПН к оплате» (его берём из блока счетов), прочие платежи и список «Топ-…
  // расходов» со своим «Итого». До 19.11.2026 они шли в колонках календаря, «Прочие платежи»
  // без подписи; с 20.11 у обоих списков подпись, и они сдвинуты на колонку вправо — поэтому
  // колонки списка берутся от его подписи.
  const isTopLabel = (key: string) => /^топ\s*-?\s*\d/.test(key);
  const isOtherLabel = (key: string) => key === "прочие платежи";
  const listLabelAt = (r: number): { c: number; text: string; key: string } | null => {
    for (let c = Math.max(1, payeeCol - 1); c <= Math.min(g.maxCol, payeeCol + 3); c++) {
      const text = g.text(r, c);
      const key = labelKey(text);
      if (text && (isTopLabel(key) || isOtherLabel(key))) return { c, text, key };
    }
    return null;
  };
  let cols = calendarCols;
  let current: FinancePaymentList = { label: "Прочие платежи", items: [], total: 0 };
  let skipping = false;
  const flush = (fileTotal: number | null) => {
    if (current.items.length) lists.push(finish(current, fileTotal));
  };
  for (; r <= g.maxRow; r++) {
    if (skipping) {
      if (!g.text(r, payeeCol) && g.num(r, amountCol) !== null) skipping = false;
      continue;
    }
    const label = listLabelAt(r);
    if (label) {
      flush(null);
      cols = colsAt(label.c);
      current = { label: isOtherLabel(label.key) ? "Прочие платежи" : label.text.trim(), items: [], total: 0 };
      continue;
    }
    const payee = g.text(r, cols.payee);
    const amount = g.num(r, cols.amount);
    const key = labelKey(payee);
    if (!payee) continue;
    if (key.startsWith("кпн")) {
      skipping = true;
      continue;
    }
    if (key === "итого") {
      flush(amount);
      current = { label: "Прочие платежи", items: [], total: 0 };
      continue;
    }
    if (amount !== null && amount !== 0) current.items.push(item(r, cols));
  }
  flush(null);
  return lists;
}

/* ---------- мелочи ---------- */

function parseRates(g: Grid): FinanceRate[] {
  const out: FinanceRate[] = [];
  for (let r = 1; r <= g.maxRow; r++) {
    for (let c = 1; c < g.maxCol; c++) {
      const label = g.text(r, c);
      const value = g.num(r, c + 1);
      if (label && value !== null && labelKey(label).startsWith("курс")) out.push({ label, value });
    }
  }
  return out;
}

function parsePeriodLabel(g: Grid): string | undefined {
  for (let r = 1; r <= g.maxRow; r++) {
    for (let c = 1; c <= g.maxCol; c++) {
      const t = g.text(r, c);
      if (t && /^\d{1,2}\.\d{1,2}\.?\s*[-–—]\s*\d{1,2}\.\d{1,2}\.\d{4}$/.test(t)) return t;
    }
  }
  return undefined;
}

/** Сводка вверху листа («Выручка» | прошлый месяц | текущий период): сверка с расчётом по счетам. */
function checkSummary(g: Grid, h: CompanyHeader, pnl: FinanceReport["pnl"], warnings: string[]): void {
  const at = g.find((k) => k === "выручка");
  if (!at || at.c >= h.keyCol) return;
  const nums: number[] = [];
  for (let c = at.c + 1; c < h.keyCol; c++) {
    const v = g.num(at.r, c);
    if (v !== null) nums.push(v);
  }
  if (pnl.previous && nums.length >= 1 && differs(nums[0], pnl.previous.revenue.total)) {
    warnings.push(`Выручка прошлого периода: по счетам ${fmt(pnl.previous.revenue.total)}, в сводке файла ${fmt(nums[0])}`);
  }
  if (pnl.current && nums.length >= 2 && differs(sum(nums.slice(1)), pnl.current.revenue.total)) {
    warnings.push(`Выручка текущего периода: по счетам ${fmt(pnl.current.revenue.total)}, в сводке файла ${fmt(sum(nums.slice(1)))}`);
  }
}

/* ---------- материальные ведомости 1С (отдельные листы, по компании на лист) ---------- */
//
// Выгрузка 1С «Материальная ведомость»: в первой строке компания, ниже «…за Ноябрь 2026 г.»,
// шапка в две строки — группы («Склад», «Начальный остаток», «Итого приход», «Итого расход»,
// «Конечный остаток») и под ними «№ п/п | Номенклатура | … | Количество | Сумма». Колонки
// прихода и расхода бывают не у всех компаний — зависят от настроек выгрузки, поэтому всё
// ищется по подписям. Строка, где в «№ п/п» текст, — склад с итогами; с числом — товар.

type StockSlot = "start" | "in" | "out" | "end";
const STOCK_GROUPS: Record<string, StockSlot> = {
  "начальный остаток": "start",
  "итого приход": "in",
  "итого расход": "out",
  "конечный остаток": "end"
};
const roundSum = (n: number) => Math.round(n);
const roundQty = (n: number) => Math.round(n * 1000) / 1000;

function stockCompany(g: Grid, beforeRow: number): string {
  for (let r = 1; r < beforeRow; r++) {
    for (let c = 1; c <= Math.min(g.maxCol, 8); c++) {
      const t = g.text(r, c)?.replace(/\s+/g, " ").trim();
      if (!t || labelKey(t).startsWith("материальная ведомость")) continue;
      return t.replace(/^(тоо|ип|ао)\s+/i, "").replace(/^["«]+|["»]+$/g, "").trim() || t;
    }
  }
  return "";
}

function parseStockSheet(ws: ExcelJS.Worksheet, warnings: string[]): FinanceStock | null {
  const g = gridFromSheet(ws);
  const nameHead = g.find((k) => k === "номенклатура");
  if (!nameHead || nameHead.r < 2) return null;
  const hr = nameHead.r;
  const cols: Partial<Record<StockSlot, { qty?: number; sum?: number }>> = {};
  for (let c = 1; c <= g.maxCol; c++) {
    const slot = STOCK_GROUPS[g.key(hr - 1, c)];
    if (!slot) continue;
    const at = (cols[slot] ??= {});
    const sub = g.key(hr, c);
    if (sub === "количество" && !at.qty) at.qty = c;
    if (sub === "сумма" && !at.sum) at.sum = c;
  }
  // без начального и конечного остатка это не ведомость (другой лист с «Номенклатурой»)
  if (!cols.start?.sum || !cols.end?.sum) return null;
  const hasMoves = Boolean(cols.in?.sum && cols.out?.sum);
  let numCol = 1;
  let unitCol = 0;
  for (let c = 1; c <= g.maxCol; c++) {
    const k = g.key(hr, c);
    if (k === "№ п/п") numCol = c;
    if (k === "ед изм" && !unitCol) unitCol = c;
  }
  const company = stockCompany(g, hr - 1) || ws.name;
  const title = g.find((k) => k.startsWith("материальная ведомость"));
  const period = title ? /за\s+(\S+\s+\d{4})/i.exec(g.text(title.r, title.c)!.replace(/\s+/g, " "))?.[1] : undefined;

  const sums = (r: number): FinanceStockSums => ({
    start: g.num(r, cols.start!.sum!) ?? 0,
    ...(hasMoves ? { in: g.num(r, cols.in!.sum!) ?? 0, out: g.num(r, cols.out!.sum!) ?? 0 } : {}),
    end: g.num(r, cols.end!.sum!) ?? 0
  });
  const val = (r: number, c: number | undefined) => (c ? g.num(r, c) ?? 0 : 0);
  const warehouses: FinanceStockWarehouse[] = [];
  let fileTotal: FinanceStockSums | null = null;
  let current: FinanceStockWarehouse | null = null;
  for (let r = hr + 1; r <= g.maxRow; r++) {
    const label = g.text(r, numCol);
    if (label && g.num(r, numCol) === null) {
      if (labelKey(label) === "итого") {
        fileTotal = sums(r);
        break;
      }
      current = { name: label.replace(/\s+/g, " ").trim(), sums: sums(r), items: [] };
      warehouses.push(current);
      continue;
    }
    const name = g.text(r, nameHead.c);
    if (g.num(r, numCol) === null || !name) continue;
    if (!current) {
      current = { name: "Без склада", sums: { start: 0, ...(hasMoves ? { in: 0, out: 0 } : {}), end: 0 }, items: [] };
      warehouses.push(current);
    }
    const unit = unitCol ? g.text(r, unitCol)?.trim() : undefined;
    const item: FinanceStockItem = {
      name: name.replace(/\s+/g, " ").trim().slice(0, 160),
      ...(unit && labelKey(unit) !== "шт" ? { unit } : {}),
      startQty: roundQty(val(r, cols.start.qty)),
      startSum: val(r, cols.start.sum),
      ...(hasMoves
        ? { inQty: roundQty(val(r, cols.in!.qty)), inSum: val(r, cols.in!.sum), outQty: roundQty(val(r, cols.out!.qty)), outSum: val(r, cols.out!.sum) }
        : {}),
      endQty: roundQty(val(r, cols.end.qty)),
      endSum: val(r, cols.end.sum)
    };
    current.items.push(item);
  }
  if (!warehouses.length) return null;

  // Сверка: склад — с суммой своих товаров, «Итого» — с суммой складов. Склад без строк-товаров
  // («Без склада» мы создали сами) берёт итог из товаров.
  for (const w of warehouses) {
    const itemsEnd = sum(w.items.map((x) => x.endSum));
    if (w.name === "Без склада") {
      w.sums = {
        start: sum(w.items.map((x) => x.startSum)),
        ...(hasMoves ? { in: sum(w.items.map((x) => x.inSum ?? 0)), out: sum(w.items.map((x) => x.outSum ?? 0)) } : {}),
        end: itemsEnd
      };
    } else if (differs(w.sums.end, itemsEnd)) {
      warnings.push(`Склад ${company}, «${w.name}»: остаток на конец в файле ${fmt(w.sums.end)}, сумма товаров ${fmt(itemsEnd)}`);
    }
  }
  const whTotal: FinanceStockSums = {
    start: sum(warehouses.map((w) => w.sums.start)),
    ...(hasMoves ? { in: sum(warehouses.map((w) => w.sums.in ?? 0)), out: sum(warehouses.map((w) => w.sums.out ?? 0)) } : {}),
    end: sum(warehouses.map((w) => w.sums.end))
  };
  if (fileTotal && differs(fileTotal.end, whTotal.end)) {
    warnings.push(`Склад ${company}: «Итого» на конец в файле ${fmt(fileTotal.end)}, сумма складов ${fmt(whTotal.end)}`);
  }
  const round = (s: FinanceStockSums): FinanceStockSums => ({
    start: roundSum(s.start),
    ...(s.in !== undefined ? { in: roundSum(s.in) } : {}),
    ...(s.out !== undefined ? { out: roundSum(s.out) } : {}),
    end: roundSum(s.end)
  });
  for (const w of warehouses) {
    w.sums = round(w.sums);
    for (const x of w.items) {
      x.startSum = roundSum(x.startSum);
      x.endSum = roundSum(x.endSum);
      if (x.inSum !== undefined) x.inSum = roundSum(x.inSum);
      if (x.outSum !== undefined) x.outSum = roundSum(x.outSum);
    }
  }
  return { company, ...(period ? { period } : {}), hasMoves, warehouses, total: round(fileTotal ?? whTotal) };
}

/** Все листы-ведомости файла. Сломанный лист не роняет отчёт: он уходит в предупреждения. */
function parseStockSheets(workbook: ExcelJS.Workbook, mainSheet: ExcelJS.Worksheet, warnings: string[]): FinanceStock[] {
  const out: FinanceStock[] = [];
  for (const ws of workbook.worksheets) {
    if (ws === mainSheet || ws.state === "hidden" || ws.state === "veryHidden") continue;
    try {
      const stock = parseStockSheet(ws, warnings);
      if (stock) out.push(stock);
    } catch (e) {
      warnings.push(`Лист «${ws.name}» похож на материальную ведомость, но не разобран: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

function pickSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const byName = workbook.worksheets.find((ws) => labelKey(ws.name).startsWith("ежед"));
  if (byName) return byName;
  throw new FinanceParseError("нет листа «Ежед.»");
}

export function parseFinanceWorkbook(workbook: ExcelJS.Workbook): FinanceReport {
  const mainSheet = pickSheet(workbook);
  const g = gridFromSheet(mainSheet);
  const warnings: string[] = [];

  const header = findCompanyHeader(g);
  const accountRows = readAccountRows(g, header);
  const size = header.names.length;
  const pnlDates = [...new Set(accountRows.filter((x) => x.date && x.code && x.code.startsWith("6")).map((x) => x.date!))].sort();
  if (!pnlDates.length) throw new FinanceParseError("в блоках счетов нет выручки (счета 6xxx) с датой");
  const dataDate = pnlDates[pnlDates.length - 1];
  const monthStart = `${dataDate.slice(0, 7)}-01`;
  const previousDate = pnlDates.filter((d) => d < monthStart).pop();
  const pnl: FinanceReport["pnl"] = {
    current: pnlFor(accountRows, dataDate, size),
    ...(previousDate ? { previous: pnlFor(accountRows, previousDate, size) } : {})
  };

  const balances: FinanceBalanceLine[] = accountRows
    .filter((x) => x.date === dataDate && x.code && Number(x.code) < 6000)
    .map((x) => ({ code: x.code!, label: BALANCE_LABELS[x.code!] ?? `Счёт ${x.code}`, values: x.values, total: x.total }));

  const taxRow = [...accountRows].reverse().find((x) => x.label && labelKey(x.label) === "кпн");
  const tax: FinanceTax | undefined = taxRow
    ? { date: taxRow.date ?? dataDate, label: taxRow.label!, values: taxRow.values, total: taxRow.total }
    : undefined;

  const cash = parseCash(g, warnings);
  const cashFlow = parseCashFlow(accountRows, g, header, cash, warnings);
  const incoming = parseIncoming(g, warnings);
  const { debtors, problem, layout } = parseDebtors(g, warnings);
  const liabilities = parseLiabilities(g, layout);
  const payments = parsePayments(g, warnings);
  checkSummary(g, header, pnl, warnings);
  const stock = parseStockSheets(workbook, mainSheet, warnings);

  return {
    dataDate,
    periodLabel: parsePeriodLabel(g),
    companies: header.names,
    pnl,
    balances,
    ...(tax ? { tax } : {}),
    cash,
    ...(cashFlow ? { cashFlow } : {}),
    incoming: incoming.items,
    incomingTotal: incoming.total,
    debtors,
    ...(problem ? { problemDebts: problem } : {}),
    liabilities,
    payments,
    rates: parseRates(g),
    ...(stock.length ? { stock } : {}),
    warnings
  };
}

export async function parseFinanceExcel(buffer: Buffer): Promise<FinanceReport> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new FinanceParseError("файл не читается как .xlsx");
  }
  return parseFinanceWorkbook(workbook);
}

/** Короткая запись дня для истории. */
export function financeSnapshot(report: FinanceReport): FinanceSnapshot {
  const isLoan = (label: string) => /^кредит(?!ор)/.test(labelKey(label));
  const payablesLine = report.liabilities.find((x) => labelKey(x.label).startsWith("кредитор"));
  const payables = payablesLine?.total ?? report.balances.find((x) => x.code === "3310")?.total;
  return {
    dataDate: report.dataDate,
    cash: report.cash.total,
    inventory: report.cash.inventory,
    debtors: report.debtors.total,
    problemDebts: report.problemDebts?.total ?? 0,
    ...(payables !== undefined ? { payables } : {}),
    loans: sum(report.liabilities.filter((x) => isLoan(x.label)).map((x) => x.total)),
    paymentsDue: report.payments[0]?.total ?? 0,
    ...(report.pnl.current ? { revenue: report.pnl.current.revenue.total, profit: report.pnl.current.profit.total } : {})
  };
}
