// ОПиУ из книги «ФО» (финансовая отчётность), которую финансисты кладут в тот же чат, что и
// ежедневный отчёт.
//
// Лист «ОПиУ» — форма отчёта о прибылях и убытках: подписи статей, «Код строки», месяцы
// (свёрнуты в группы) и итоги лет. Лист «Расш. ОПиУ» — под каждой статьёй свёрнутые строки
// расшифровки, итог статьи — формула SUM по ним. Ячейка ОПиУ ссылается на итог статьи формулой
// ('Расш. ОПиУ'!C4) — по ней статья и связывается с расшифровкой. Если формул нет (книгу
// сохранили значениями), ищем статью по коду в заголовке («строка 010») и берём её, только когда
// суммы сходятся: код в заголовках бывает неверным (у «Доходов от финансирования» стоит 022).
//
// В сообщениях об ошибках нет сумм и названий из файла: они попадают в публичный лог Actions.

import type ExcelJS from "exceljs";
import { FinanceParseError, labelKey } from "./parseReport.js";
import type {
  FinanceIncomeStatement,
  FinanceStatementBreakdown,
  FinanceStatementBreakdownRow,
  FinanceStatementLine,
  FinanceStatementLineKind,
  FinanceStatementPeriod
} from "./types.js";

const DAY_MS = 86_400_000;
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const fmt = (n: number) => `${nf.format(Math.round(n)).replace(/[  ]/g, " ")} ₸`;
const monthName = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

const isStatementSheet = (name: string) => ["опиу", "опу"].includes(labelKey(name));
const isBreakdownSheet = (name: string) => {
  const k = labelKey(name);
  return k.startsWith("расш") && /опи?у/.test(k);
};
const isDailySheet = (name: string) => labelKey(name).startsWith("ежед");

/** Книга ФО: есть лист «ОПиУ» и нет листа «Ежед.» (ежедневный отчёт разбирается как раньше). */
export function isIncomeStatementWorkbook(workbook: ExcelJS.Workbook): boolean {
  const names = workbook.worksheets.map((ws) => ws.name);
  return names.some(isStatementSheet) && !names.some(isDailySheet);
}

/* ---------- ячейки ---------- */

function isFormulaValue(v: unknown): v is { result?: unknown } {
  return !!v && typeof v === "object" && !(v instanceof Date) && ("formula" in v || "sharedFormula" in v);
}

function rawOf(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  return isFormulaValue(v) ? v.result : v;
}

function numberOf(cell: ExcelJS.Cell): number | null {
  const v = rawOf(cell);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function textOf(cell: ExcelJS.Cell): string | null {
  let v = rawOf(cell);
  if (v && typeof v === "object" && Array.isArray((v as { richText?: unknown }).richText)) {
    v = (v as { richText: Array<{ text?: string }> }).richText.map((t) => t.text ?? "").join("");
  }
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t || null;
}

/** Формула ячейки; у копий общей формулы exceljs возвращает её сдвинутый текст. */
function formulaOf(cell: ExcelJS.Cell): string | null {
  if (!isFormulaValue(cell.value)) return null;
  try {
    const f = (cell as unknown as { formula?: unknown }).formula;
    return typeof f === "string" && f ? f : null;
  } catch {
    return null;
  }
}

function monthOf(cell: ExcelJS.Cell): string | null {
  const v = rawOf(cell);
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return null;
  const d = new Date(Math.round(v.getTime() / DAY_MS) * DAY_MS);
  return d.getUTCFullYear() >= 2000 ? d.toISOString().slice(0, 7) : null;
}

function yearOf(cell: ExcelJS.Cell): { year: number; label: string } | null {
  const v = rawOf(cell);
  if (typeof v === "number" && Number.isInteger(v) && v >= 2000 && v <= 2100) return { year: v, label: String(v) };
  const t = textOf(cell);
  const m = t?.match(/(?:^|\D)(20\d{2})(?:\D|$)/);
  return t && m ? { year: Number(m[1]), label: t } : null;
}

/* ---------- шапка ---------- */

interface Header {
  row: number;
  labelCol: number;
  codeCol?: number;
  months: Array<{ col: number; key: string }>;
  years: Array<{ col: number; year: number; label: string }>;
  firstPeriodCol: number;
}

/** Строка с подписью-шапкой и хотя бы одним месяцем (датой) в ней же. */
function findHeader(ws: ExcelJS.Worksheet, isLabel: (key: string) => boolean): Header | null {
  const maxRow = Math.min(ws.rowCount, 80);
  const maxCol = ws.columnCount;
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    let labelCol = 0;
    for (let c = 1; c <= maxCol && !labelCol; c++) {
      const t = textOf(row.getCell(c));
      if (t && isLabel(labelKey(t))) labelCol = c;
    }
    if (!labelCol) continue;
    const months: Header["months"] = [];
    const years: Header["years"] = [];
    let codeCol: number | undefined;
    for (let c = labelCol + 1; c <= maxCol; c++) {
      const cell = row.getCell(c);
      const key = monthOf(cell);
      if (key) {
        months.push({ col: c, key });
        continue;
      }
      if (labelKey(textOf(cell)) === "код строки") {
        codeCol = c;
        continue;
      }
      const y = yearOf(cell);
      if (y && !years.some((x) => x.year === y.year)) years.push({ col: c, ...y });
    }
    if (!months.length) continue;
    const firstPeriodCol = Math.min(...months.map((x) => x.col), ...years.map((x) => x.col));
    return { row: r, labelCol, codeCol, months, years, firstPeriodCol };
  }
  return null;
}

function findRightOf(ws: ExcelJS.Worksheet, isLabel: (key: string) => boolean, maxRow = 40): string | undefined {
  for (let r = 1; r <= Math.min(ws.rowCount, maxRow); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      if (!isLabel(labelKey(textOf(row.getCell(c))))) continue;
      const label = textOf(row.getCell(c));
      for (let k = c + 1; k <= ws.columnCount; k++) {
        const t = textOf(row.getCell(k));
        if (t && t !== label) return t;
      }
    }
  }
  return undefined;
}

/* ---------- лист расшифровки ---------- */

interface Section {
  title: string;
  rows: FinanceStatementBreakdownRow[];
  /** Неокруглённые суммы строк по месяцам — для сверки с ОПиУ. */
  sums: Map<string, number>;
}

class BreakdownSheet {
  private readonly cache = new Map<number, Section | null>();
  readonly byCode = new Map<string, number>();

  constructor(
    readonly ws: ExcelJS.Worksheet,
    private readonly header: Header,
    private readonly monthKeys: Set<string>
  ) {
    for (let r = header.row + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (row.outlineLevel) continue;
      const code = textOf(row.getCell(header.labelCol))?.match(/строк\S*\s*(\d{3})/i)?.[1];
      if (code && !this.byCode.has(code)) this.byCode.set(code, r);
    }
  }

  get name(): string {
    return this.ws.name;
  }

  /** Строки статьи под строкой-итогом: по диапазону её SUM, иначе по группировке, иначе до пустой подписи. */
  private childRows(top: number): number[] {
    const row = this.ws.getRow(top);
    for (const { col } of this.header.months) {
      const m = formulaOf(row.getCell(col))?.replace(/\$/g, "").match(/^SUM\([A-Z]{1,3}(\d+):[A-Z]{1,3}(\d+)\)$/i);
      if (m) {
        const a = Number(m[1]), b = Number(m[2]);
        if (a > top && b >= a && b - a < 20_000) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
      }
    }
    const out: number[] = [];
    const grouped = !!this.ws.getRow(top + 1).outlineLevel;
    for (let r = top + 1; r <= this.ws.rowCount; r++) {
      const next = this.ws.getRow(r);
      if (grouped ? !next.outlineLevel : !textOf(next.getCell(this.header.labelCol))) break;
      out.push(r);
    }
    return out;
  }

  section(top: number): Section | null {
    if (this.cache.has(top)) return this.cache.get(top)!;
    const title = textOf(this.ws.getRow(top).getCell(this.header.labelCol));
    let section: Section | null = null;
    if (title) {
      const sums = new Map<string, number>();
      const rows: FinanceStatementBreakdownRow[] = [];
      for (const r of this.childRows(top)) {
        const row = this.ws.getRow(r);
        const months: Record<string, number> = {};
        let any = false;
        for (const { col, key } of this.header.months) {
          if (!this.monthKeys.has(key)) continue;
          const v = numberOf(row.getCell(col));
          if (v === null || v === 0) continue;
          sums.set(key, (sums.get(key) ?? 0) + v);
          const rounded = Math.round(v);
          if (rounded !== 0) {
            months[key] = rounded;
            any = true;
          }
        }
        if (any) rows.push({ label: textOf(row.getCell(this.header.labelCol)) ?? "без названия", months });
      }
      section = { title, rows, sums };
    }
    this.cache.set(top, section);
    return section;
  }
}

/** Строка листа расшифровки, на которую ссылаются формулы месяцев строки ОПиУ (самая частая). */
function referencedRow(row: ExcelJS.Row, header: Header, breakdownName: string): number | null {
  const want = labelKey(breakdownName);
  const counts = new Map<number, number>();
  const re = /(?:'((?:[^']|'')+)'|([A-Za-zА-Яа-яЁё0-9_.]+))!\$?[A-Z]{1,3}\$?(\d+)/g;
  for (const { col } of header.months) {
    const f = formulaOf(row.getCell(col));
    if (!f) continue;
    for (const m of f.matchAll(re)) {
      const sheet = (m[1] ?? m[2]).replace(/''/g, "'");
      if (labelKey(sheet) !== want) continue;
      const r = Number(m[3]);
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  for (const [r, n] of counts) if (best === null || n > counts.get(best)!) best = r;
  return best;
}

/* ---------- строки ОПиУ ---------- */

const RATIO_LABEL = /наценк|маржа|рентабельн/;
const SUBTOTAL_LABEL = /прибыль|убыток|совокупный доход|^итого/;

function lineKind(row: ExcelJS.Row, header: Header, label: string): FinanceStatementLineKind {
  const cols = [...header.months.map((x) => x.col), ...header.years.map((x) => x.col)];
  const key = labelKey(label);
  if (RATIO_LABEL.test(key) || cols.some((c) => /%/.test(row.getCell(c).numFmt ?? ""))) return "ratio";
  if (SUBTOTAL_LABEL.test(key)) return "subtotal";
  const f = header.months.map((x) => formulaOf(row.getCell(x.col))).find(Boolean);
  return f && !f.includes("!") && /[-+]/.test(f) ? "subtotal" : "item";
}

function lineLabel(row: ExcelJS.Row, header: Header): string | null {
  for (let c = 1; c < header.firstPeriodCol; c++) {
    if (c === header.codeCol) continue;
    const t = textOf(row.getCell(c));
    if (t && !/^[\d\s.,-]+$/.test(t)) return t;
  }
  return null;
}

function lineCode(row: ExcelJS.Row, header: Header): string | undefined {
  if (!header.codeCol) return undefined;
  const cell = row.getCell(header.codeCol);
  const n = numberOf(cell);
  if (n !== null && Number.isInteger(n)) return String(n).padStart(3, "0");
  const t = textOf(cell);
  return t && /^\d{3}$/.test(t) ? t : undefined;
}

/** Месяцы, где сумма строк расшифровки отличается от ОПиУ больше чем на тенге. */
function mismatches(line: FinanceStatementLine, periods: FinanceStatementPeriod[], section: Section): Array<{ key: string; diff: number }> {
  const out: Array<{ key: string; diff: number }> = [];
  periods.forEach((p, i) => {
    if (p.kind !== "month") return;
    const diff = (line.values[i] ?? 0) - (section.sums.get(p.key) ?? 0);
    if (Math.abs(diff) > 1) out.push({ key: p.key, diff });
  });
  return out;
}

export function parseIncomeStatement(workbook: ExcelJS.Workbook): FinanceIncomeStatement {
  const ws = workbook.worksheets.find((x) => isStatementSheet(x.name));
  if (!ws) throw new FinanceParseError("нет листа «ОПиУ»");
  const header = findHeader(ws, (k) => k.startsWith("наименование показател"));
  if (!header) throw new FinanceParseError(`на листе «${ws.name}» нет шапки «Наименование показателей» с месяцами`);

  const allPeriods: Array<FinanceStatementPeriod & { col: number }> = [
    ...header.months.map(({ col, key }) => ({ col, key, kind: "month" as const, year: Number(key.slice(0, 4)) })),
    ...header.years.map(({ col, year, label }) => ({ col, key: String(year), kind: "year" as const, year, label }))
  ].sort((a, b) => a.col - b.col);

  // Строки формы: скрытые (финансист прячет пустые разделы), без подписи и совсем пустые пропускаем.
  const raw: Array<{ row: ExcelJS.Row; label: string; code?: string; kind: FinanceStatementLineKind; values: Array<number | null> }> = [];
  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (row.hidden) continue;
    const label = lineLabel(row, header);
    if (!label) continue;
    const kind = lineKind(row, header, label);
    const values = allPeriods.map((p) => {
      const v = numberOf(row.getCell(p.col));
      if (v === null) return null;
      return kind === "ratio" ? v : Math.round(v);
    });
    if (values.every((v) => v === null)) continue;
    raw.push({ row, label, code: lineCode(row, header), kind, values });
  }
  if (!raw.length) throw new FinanceParseError(`на листе «${ws.name}» нет строк с суммами`);

  // Периоды без единого значения (будущие месяцы года) не показываем.
  const keep = allPeriods.map((_, i) => raw.some((x) => x.values[i] !== null));
  const periods: FinanceStatementPeriod[] = allPeriods.filter((_, i) => keep[i]).map(({ col: _col, ...p }) => p);
  const lines: FinanceStatementLine[] = raw.map((x) => ({
    label: x.label,
    ...(x.code ? { code: x.code } : {}),
    kind: x.kind,
    values: x.values.filter((_, i) => keep[i])
  }));

  const warnings: string[] = [];
  const bdWs = workbook.worksheets.find((x) => isBreakdownSheet(x.name));
  let unit: string | undefined;
  if (bdWs) {
    const bdHeader = findHeader(bdWs, (k) => k.startsWith("наименование стат"));
    for (let r = 1; r <= Math.min(bdWs.rowCount, 5) && !unit; r++) {
      for (let c = 1; c <= Math.min(bdWs.columnCount, 6) && !unit; c++) {
        const t = textOf(bdWs.getRow(r).getCell(c));
        if (t && /тенге|тыс/i.test(t) && t.length <= 40) unit = t;
      }
    }
    if (!bdHeader) {
      warnings.push(`лист «${bdWs.name}» не разобран: нет шапки «Наименование статьи» с месяцами`);
    } else {
      const monthKeys = new Set(periods.filter((p) => p.kind === "month").map((p) => p.key));
      const bd = new BreakdownSheet(bdWs, bdHeader, monthKeys);
      raw.forEach((x, i) => {
        const line = lines[i];
        if (line.kind !== "item") return;
        const linkedRow = referencedRow(x.row, header, bd.name);
        if (linkedRow !== null) {
          const section = bd.section(linkedRow);
          if (!section) return;
          line.breakdown = { title: section.title, rows: section.rows } satisfies FinanceStatementBreakdown;
          const bad = mismatches(line, periods, section);
          if (bad.length) {
            const more = bad.length > 1 ? ` и ещё ${bad.length - 1} мес.` : "";
            warnings.push(`«${line.label}»: сумма строк расшифровки не сходится с ОПиУ за ${monthName(bad[0].key)}${more} (разница ${fmt(Math.abs(bad[0].diff))})`);
          }
          return;
        }
        // Без формулы — по коду строки в заголовке статьи, и только при совпадении сумм.
        const byCode = line.code ? bd.byCode.get(line.code) : undefined;
        const section = byCode !== undefined ? bd.section(byCode) : null;
        if (section && section.rows.length && !mismatches(line, periods, section).length) {
          line.breakdown = { title: section.title, rows: section.rows };
        }
      });
    }
  }

  const company = findRightOf(ws, (k) => k === "наименование организации");
  return {
    ...(company ? { company } : {}),
    ...(unit ? { unit } : {}),
    periods,
    lines,
    warnings
  };
}
