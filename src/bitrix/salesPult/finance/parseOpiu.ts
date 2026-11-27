// Разбор отчёта о прибылях и убытках (листы «ОПиУ» и «Расш. ОПиУ») из книги финансовой отчётности.
//
// Как устроена книга:
// - Лист «ОПиУ»: годовые столбцы («2023», «2024», «2025», «9 мес. 2026») и скрытые помесячные
//   столбцы (даты 2023-01-01 … 2026-12-01). Строки с расшифровкой ссылаются формулой на строку
//   итога раздела на листе «Расш. ОПиУ» (запасной путь — сопоставление по коду/названию).
// - Лист «Расш. ОПиУ»: блоки расшифровок («Расшифровка Доходов…», «Расшифровка Расходов по
//   реализации…», «Расшифровка Административных расходов…» и т.д.). В двухуровневых разделах
//   жирные строки (font.bold) — это статьи/группы расходов, а обычные строки сразу под ними —
//   детализация (контрагенты, договоры, сотрудники).
//
// В сообщениях об ошибках и предупреждениях нет сумм и названий контрагентов (лог Actions публичный).

import type ExcelJS from "exceljs";
import { labelKey } from "./parseReport.js";
import type {
  OpiuBreakdownItem,
  OpiuBreakdownSection,
  OpiuReport,
  OpiuRow,
  OpiuYearColumn
} from "./opiuTypes.js";

export class OpiuParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpiuParseError";
  }
}

const DAY_MS = 86_400_000;
const YEAR_HEADER_RE = /^(?:.*\s)?(20\d{2})$/;
const RASH_FORMULA_RE = /['"]?Расш\.?\s*ОПиУ(?:_[^'"!]+)?['"]?!\$?[A-Z]+\$?(\d+)/i;
const SECTION_CODE_RE = /строка\s*(\d{3})\s*опиу/i;
const OPIU_SHEET_RE = /^опиу(?:_(.+))?$/i;

function isoMonthFromValue(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const rounded = new Date(Math.round(v.getTime() / DAY_MS) * DAY_MS);
    const y = rounded.getUTCFullYear();
    if (y >= 2000 && y <= 2100) return rounded.toISOString().slice(0, 7);
    return null;
  }
  if (typeof v === "string") {
    const m = v.trim().match(/^(20\d{2})-(0[1-9]|1[0-2])(?:-\d{2})?$/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return isoMonthFromValue(o.result);
  }
  return null;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellText(o.result);
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("").replace(/\s+/g, " ").trim();
    }
    if (typeof o.text === "string") return o.text.replace(/\s+/g, " ").trim();
  }
  return "";
}

/** Возвращает число или null, если ячейка пуста / без кэшированного результата. */
function cellNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) {
      return typeof o.result === "number" && Number.isFinite(o.result) ? o.result : null;
    }
  }
  return null;
}

function cellFormula(v: unknown): string {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.formula === "string") return o.formula;
  }
  return "";
}

function roundMoney(n: number): number {
  const r = Math.round(n);
  return Object.is(r, -0) ? 0 : r;
}

function roundRatio(n: number): number {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

function isPercentRow(label: string, numFmt: string | undefined): boolean {
  if (numFmt && /%/.test(numFmt)) return true;
  const k = labelKey(label);
  return (
    k === "наценка" ||
    k === "маржа" ||
    k === "ros" ||
    k === "roa" ||
    k.startsWith("рентабельность")
  );
}

interface YearColMeta {
  col: number;
  year: string;
  label: string;
}

interface MonthColMeta {
  col: number;
  ym: string;
  year: string;
}

function extractPeriodColumns(row: ExcelJS.Row, fromCol: number, maxCol: number): {
  years: YearColMeta[];
  months: MonthColMeta[];
} {
  const years: YearColMeta[] = [];
  const months: MonthColMeta[] = [];
  const seenYears = new Set<string>();
  const seenMonths = new Set<string>();

  for (let c = fromCol; c <= maxCol; c++) {
    const raw = row.getCell(c).value;
    const ym = isoMonthFromValue(raw);
    if (ym) {
      if (!seenMonths.has(ym)) {
        seenMonths.add(ym);
        months.push({ col: c, ym, year: ym.slice(0, 4) });
      }
      continue;
    }
    const text = cellText(raw);
    if (!text) continue;
    const match = text.match(YEAR_HEADER_RE);
    if (match) {
      const year = match[1];
      if (!seenYears.has(year)) {
        seenYears.add(year);
        years.push({ col: c, year, label: text });
      }
    }
  }

  years.sort((a, b) => a.year.localeCompare(b.year));
  months.sort((a, b) => a.ym.localeCompare(b.ym));
  return { years, months };
}

function findHeaderRow(ws: ExcelJS.Worksheet, predicate: (key: string) => boolean, maxScan = 30): { row: number; col: number } | null {
  const limit = Math.min(ws.rowCount, maxScan);
  for (let r = 1; r <= limit; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= Math.min(ws.columnCount, 15); c++) {
      const k = labelKey(cellText(row.getCell(c).value));
      if (k && predicate(k)) return { row: r, col: c };
    }
  }
  return null;
}

function extractInlineOrganization(text: string): string | undefined {
  const m = text.match(/наименование\s+организации\s*[:：\-–—]\s*(.+)$/i);
  if (!m) return undefined;
  let value = m[1].trim();
  // Убираем хвост вида «. Период: январь 2023 – ...» (сохраняя точки внутри имени вроде «Тест.kz»).
  // В JS `\b` не работает с кириллицей, поэтому проверяем разделитель явно.
  value = value.replace(/[.;,]?\s*период(?=\s*[:：]|\s|$).*$/i, "").trim();
  value = value.replace(/[.,;:\s]+$/, "").trim();
  return value || undefined;
}

function findOrganization(ws: ExcelJS.Worksheet, headerRow: number): string | undefined {
  for (let r = 1; r < headerRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= Math.min(ws.columnCount, 20); c++) {
      const raw = cellText(row.getCell(c).value);
      if (labelKey(raw).includes("наименование организации")) {
        const inline = extractInlineOrganization(raw);
        if (inline) return inline;
        for (let k = c + 1; k <= Math.min(ws.columnCount, c + 12); k++) {
          const val = cellText(row.getCell(k).value);
          if (val && !labelKey(val).includes("наименование организации")) return val;
        }
      }
    }
  }
  return undefined;
}

function fallbackCodeForSection(title: string): string | null {
  const explicit = title.match(SECTION_CODE_RE);
  const k = labelKey(title);
  // В реальной книге у «Доходов от финансирования» в скобках опечатка «строка 022», хотя в ОПиУ это 021.
  // Поэтому смысловые ключевые слова для финансовых доходов/расходов и реализации проверяем раньше.
  if (k.includes("расходов по реализации")) return "013";
  if (k.includes("административных расходов")) return "014";
  if (k.includes("доходов от финансирования") || k.includes("финансовых доходов")) return "021";
  if (k.includes("расходов на фина")) return "022";
  if (k.includes("прочих доходов")) return "024";
  if (k.includes("прочих расходов")) return "025";
  if (k.includes("себестоимости")) return "011";
  if (k.includes("доходов")) return "010";
  return explicit ? explicit[1] : null;
}

interface ParsedRashSection {
  startRow: number;
  title: string;
  years: number[];
  months: Record<string, number>;
  hasGroups: boolean;
  items: OpiuBreakdownItem[];
}

function readRowSeries(
  row: ExcelJS.Row,
  targetYears: YearColMeta[],
  rashYearCols: Map<string, number>,
  monthCols: MonthColMeta[]
): { years: number[]; months: Record<string, number>; hasNonZero: boolean } {
  const months: Record<string, number> = {};
  const monthSumByYear = new Map<string, number>();

  for (const mc of monthCols) {
    const raw = cellNumber(row.getCell(mc.col).value);
    if (raw === null || Math.abs(raw) < 0.5) continue;
    const rounded = roundMoney(raw);
    if (rounded !== 0) {
      months[mc.ym] = rounded;
      monthSumByYear.set(mc.year, (monthSumByYear.get(mc.year) ?? 0) + raw);
    }
  }

  const years = targetYears.map((ty) => {
    const col = rashYearCols.get(ty.year);
    const direct = col !== undefined ? cellNumber(row.getCell(col).value) : null;
    if (direct !== null) return roundMoney(direct);
    const fromMonths = monthSumByYear.get(ty.year);
    return fromMonths !== undefined ? roundMoney(fromMonths) : 0;
  });

  const hasNonZero = years.some((v) => v !== 0) || Object.keys(months).length > 0;
  return { years, months, hasNonZero };
}

function parseRashSheet(
  ws: ExcelJS.Worksheet,
  targetYears: YearColMeta[]
): { unitLabel?: string; sections: ParsedRashSection[] } {
  const unitLabel = cellText(ws.getRow(1).getCell(2).value) || cellText(ws.getRow(1).getCell(1).value) || undefined;
  const header = findHeaderRow(ws, (k) => k === "наименование статьи", 15);
  if (!header) return { unitLabel, sections: [] };

  const headerRow = ws.getRow(header.row);
  const { years: rashYears, months: rashMonths } = extractPeriodColumns(headerRow, header.col + 1, ws.columnCount);
  const rashYearCols = new Map(rashYears.map((y) => [y.year, y.col]));
  const nameCol = header.col;

  // Находим все строки начала разделов («Расшифровка …») и разделители («Наименование статьи»).
  const starts: Array<{ row: number; title: string }> = [];
  const headerRows = new Set<number>();
  for (let r = header.row; r <= ws.rowCount; r++) {
    const text = cellText(ws.getRow(r).getCell(nameCol).value);
    if (!text) continue;
    const k = labelKey(text);
    if (k === "наименование статьи") {
      headerRows.add(r);
    } else if (k.startsWith("расшифровка")) {
      starts.push({ row: r, title: text });
    }
  }

  const sections: ParsedRashSection[] = [];
  for (let i = 0; i < starts.length; i++) {
    const secStart = starts[i];
    const nextStartRow = i + 1 < starts.length ? starts[i + 1].row : ws.rowCount + 1;
    let endRow = nextStartRow - 1;
    while (endRow > secStart.row && headerRows.has(endRow)) endRow--;

    const secTotals = readRowSeries(ws.getRow(secStart.row), targetYears, rashYearCols, rashMonths);

    // Проверяем, есть ли в разделе и жирные подзаголовки, и обычные строки под ними.
    let boldCount = 0;
    let regularCount = 0;
    for (let r = secStart.row + 1; r <= endRow; r++) {
      if (headerRows.has(r)) break;
      const row = ws.getRow(r);
      const label = cellText(row.getCell(nameCol).value);
      if (!label) continue;
      if (row.getCell(nameCol).font?.bold) boldCount++;
      else regularCount++;
    }
    const hasGroups = boldCount > 0 && regularCount > 0;

    const items: OpiuBreakdownItem[] = [];
    let currentGroup: OpiuBreakdownItem | null = null;

    for (let r = secStart.row + 1; r <= endRow; r++) {
      if (headerRows.has(r)) break;
      const row = ws.getRow(r);
      const label = cellText(row.getCell(nameCol).value);
      if (!label) continue;

      const isBold = Boolean(row.getCell(nameCol).font?.bold);
      const series = readRowSeries(row, targetYears, rashYearCols, rashMonths);

      if (hasGroups) {
        if (isBold) {
          currentGroup = { label, years: series.years, months: series.months, children: [] };
          items.push(currentGroup);
        } else if (series.hasNonZero) {
          const leaf: OpiuBreakdownItem = { label, years: series.years, months: series.months };
          if (currentGroup) {
            currentGroup.children!.push(leaf);
          } else {
            items.push(leaf);
          }
        }
      } else if (series.hasNonZero) {
        items.push({ label, years: series.years, months: series.months });
      }
    }

    // Очищаем нулевые группы и убираем пустой массив children у листовых жирных строк.
    const cleaned: OpiuBreakdownItem[] = [];
    for (const item of items) {
      const hasVal = item.years.some((v) => v !== 0) || Object.keys(item.months).length > 0;
      const hasKids = Boolean(item.children && item.children.length > 0);
      if (!hasVal && !hasKids) continue;
      if (hasKids) {
        cleaned.push(item);
      } else {
        cleaned.push({ label: item.label, years: item.years, months: item.months });
      }
    }

    sections.push({
      startRow: secStart.row,
      title: secStart.title,
      years: secTotals.years,
      months: secTotals.months,
      hasGroups: cleaned.some((x) => Boolean(x.children?.length)),
      items: cleaned
    });
  }

  return { unitLabel, sections };
}

function fillDerivedMonthlyRatios(rows: OpiuRow[], activeMonths: string[]): void {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const rev = byCode.get("010");
  const cost = byCode.get("011");
  const gross = byCode.get("012");
  const op = byCode.get("020");
  const net = byCode.get("300") ?? byCode.get("200");

  for (const row of rows) {
    if (!row.isPercent || Object.keys(row.months).length > 0) continue;
    const k = labelKey(row.label);
    let numRow: OpiuRow | undefined;
    let denRow: OpiuRow | undefined;
    if (k === "маржа") {
      numRow = gross;
      denRow = rev;
    } else if (k === "наценка") {
      numRow = gross;
      denRow = cost;
    } else if (k.startsWith("рентабельность операционной")) {
      numRow = op;
      denRow = rev;
    } else if (k === "ros") {
      numRow = net;
      denRow = rev;
    }
    if (!numRow || !denRow) continue;
    for (const ym of activeMonths) {
      const n = numRow.months[ym];
      const d = denRow.months[ym];
      if (n !== undefined && d !== undefined && Math.abs(d) >= 0.5) {
        row.months[ym] = roundRatio(n / d);
      }
    }
  }
}

function findPairedRashSheet(
  visibleSheets: ExcelJS.Worksheet[],
  opiuSheetName: string
): ExcelJS.Worksheet | undefined {
  const m = opiuSheetName.trim().match(OPIU_SHEET_RE);
  const suffix = m?.[1]?.trim() ?? "";
  if (suffix) {
    const suffixKey = labelKey(suffix);
    return visibleSheets.find((ws) => {
      const rm = ws.name.trim().match(/^расш\.?\s*опиу_(.+)$/i);
      return Boolean(rm && labelKey(rm[1]) === suffixKey);
    });
  }
  return visibleSheets.find((ws) => {
    const trimmed = ws.name.trim();
    if (/^расш\.?\s*опиу_/i.test(trimmed)) return false;
    const k = labelKey(trimmed);
    return k.startsWith("расш") && k.includes("опиу");
  });
}

function sheetIdFromName(sheetName: string): string {
  const m = sheetName.trim().match(OPIU_SHEET_RE);
  const suffix = m?.[1]?.trim();
  if (!suffix) return "main";
  return suffix.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "company";
}

function parseSingleOpiuSheet(
  opiuSheet: ExcelJS.Worksheet,
  rashSheet: ExcelJS.Worksheet | undefined
): OpiuReport {
  const headerPos = findHeaderRow(opiuSheet, (k) => k.includes("наименование показател"), 35);
  if (!headerPos) throw new OpiuParseError(`на листе «${opiuSheet.name}» не найдена шапка «Наименование показателей»`);

  const headerRow = opiuSheet.getRow(headerPos.row);
  const labelCol = headerPos.col;

  let codeCol = -1;
  for (let c = labelCol + 1; c <= Math.min(opiuSheet.columnCount, labelCol + 20); c++) {
    if (labelKey(cellText(headerRow.getCell(c).value)).includes("код строк")) {
      codeCol = c;
      break;
    }
  }

  const { years: yearCols, months: monthCols } = extractPeriodColumns(headerRow, labelCol + 1, opiuSheet.columnCount);
  if (!yearCols.length) throw new OpiuParseError(`на листе «${opiuSheet.name}» не найдены годовые колонки`);

  const suffixFallback = opiuSheet.name.trim().match(OPIU_SHEET_RE)?.[1]?.trim();
  const organization = findOrganization(opiuSheet, headerPos.row) ?? suffixFallback;
  const rows: OpiuRow[] = [];
  const formulaTargetByRowIndex = new Map<number, number>();
  const activeMonthsSet = new Set<string>();
  const notes: string[] = [];

  for (let r = headerPos.row + 1; r <= opiuSheet.rowCount; r++) {
    const row = opiuSheet.getRow(r);
    if (row.hidden) continue;

    // Останавливаемся на блоке подписей («Руководитель», «Главный бухгалтер»)
    let isSignature = false;
    for (let c = 1; c <= Math.min(opiuSheet.columnCount, 12); c++) {
      const k = labelKey(cellText(row.getCell(c).value));
      if (k === "руководитель" || k.startsWith("главный бухгалтер")) {
        isSignature = true;
        break;
      }
    }
    if (isSignature) break;

    let label = cellText(row.getCell(labelCol).value);
    let code = codeCol > 0 ? cellText(row.getCell(codeCol).value) : "";

    // Примечания внизу листа («Примечание: строки ... не заполнены») не являются строками ОПиУ.
    if (label && labelKey(label).startsWith("примечание")) {
      notes.push(label);
      continue;
    }

    // Строки вроде ROS/ROA иногда подписаны в колонке слева от «Код строки» (C13).
    if (!label && codeCol > 1) {
      const side = cellText(row.getCell(codeCol - 1).value);
      if (side && /^(ros|roa)$/i.test(side)) {
        label = side.toUpperCase();
        code = label;
      }
    }
    if (!label) continue;
    if (!code) code = labelKey(label);

    const isBold = Boolean(row.getCell(labelCol).font?.bold);
    const numFmt = row.getCell(yearCols[0].col).numFmt;
    const isPct = isPercentRow(label, numFmt);

    // Помесячные значения + поиск ссылки формулой на парный лист «Расш. ОПиУ*».
    const months: Record<string, number> = {};
    const monthSumByYear = new Map<string, number>();
    let linkedRashRow: number | null = null;

    for (const mc of monthCols) {
      const val = row.getCell(mc.col).value;
      if (linkedRashRow === null) {
        const f = cellFormula(val);
        const match = f.match(RASH_FORMULA_RE);
        if (match) linkedRashRow = Number(match[1]);
      }
      const n = cellNumber(val);
      if (n === null) continue;
      if (isPct) {
        const rVal = roundRatio(n);
        if (rVal !== 0) months[mc.ym] = rVal;
      } else if (Math.abs(n) >= 0.5) {
        const rVal = roundMoney(n);
        if (rVal !== 0) {
          months[mc.ym] = rVal;
          activeMonthsSet.add(mc.ym);
          monthSumByYear.set(mc.year, (monthSumByYear.get(mc.year) ?? 0) + n);
        }
      }
    }

    const years: Array<number | null> = yearCols.map((yc) => {
      const val = row.getCell(yc.col).value;
      if (linkedRashRow === null) {
        const f = cellFormula(val);
        const match = f.match(RASH_FORMULA_RE);
        if (match) linkedRashRow = Number(match[1]);
      }
      const n = cellNumber(val);
      if (n !== null) return isPct ? roundRatio(n) : roundMoney(n);
      if (!isPct) {
        const fromMonths = monthSumByYear.get(yc.year);
        return fromMonths !== undefined ? roundMoney(fromMonths) : 0;
      }
      return null;
    });

    // Пропускаем чисто вспомогательные пустые строки (например ROA без значений)
    const anyValue = years.some((v) => v !== null && v !== 0) || Object.keys(months).length > 0;
    if (!anyValue && /^(roa|ros)$/i.test(label)) continue;

    const rowIdx = rows.length;
    rows.push({ code, label, isBold, isPercent: isPct, years, months });
    if (linkedRashRow !== null) formulaTargetByRowIndex.set(rowIdx, linkedRashRow);
  }

  if (!rows.length) throw new OpiuParseError(`на листе «${opiuSheet.name}» не найдено ни одной строки показателей`);

  const activeMonths = [...activeMonthsSet].sort();
  fillDerivedMonthlyRatios(rows, activeMonths);

  const yearsOut: OpiuYearColumn[] = yearCols.map((yc) => ({
    year: yc.year,
    label: yc.label,
    months: activeMonths.filter((m) => m.startsWith(`${yc.year}-`))
  }));

  const breakdowns: Record<string, OpiuBreakdownSection> = {};
  const warnings: string[] = [];
  let unitLabel: string | undefined;

  if (rashSheet) {
    const parsedRash = parseRashSheet(rashSheet, yearCols);
    unitLabel = parsedRash.unitLabel;

    const byStartRow = new Map(parsedRash.sections.map((s) => [s.startRow, s]));
    const usedSections = new Set<number>();

    const attach = (row: OpiuRow, sec: ParsedRashSection) => {
      const key = row.code;
      row.breakdownKey = key;
      breakdowns[key] = {
        key,
        title: sec.title,
        years: sec.years,
        months: sec.months,
        hasGroups: sec.hasGroups,
        items: sec.items
      };
      usedSections.add(sec.startRow);

      // Сверка годовых итогов расшифровки со строкой ОПиУ
      for (let i = 0; i < yearCols.length; i++) {
        const opiuVal = row.years[i] ?? 0;
        const secVal = sec.years[i] ?? 0;
        if (Math.abs(opiuVal - secVal) > 100) {
          warnings.push(`строка ${row.code} (${yearCols[i].label}): итог расшифровки отличается от ОПиУ`);
        }
      }
    };

    // 1. Привязка по формульной ссылке ('Расш. ОПиУ*'!C4234)
    for (const [rowIdx, targetRow] of formulaTargetByRowIndex.entries()) {
      const sec = byStartRow.get(targetRow);
      if (sec && !usedSections.has(sec.startRow)) {
        attach(rows[rowIdx], sec);
      }
    }

    // 2. Запасная привязка по коду/названию раздела (если формулы заменены значениями)
    for (const sec of parsedRash.sections) {
      if (usedSections.has(sec.startRow)) continue;
      const code = fallbackCodeForSection(sec.title);
      if (!code) continue;
      const row = rows.find((r) => !r.breakdownKey && r.code === code);
      if (row) attach(row, sec);
    }
  }

  return {
    id: sheetIdFromName(opiuSheet.name),
    sheetName: opiuSheet.name.trim(),
    ...(organization ? { organization } : {}),
    ...(unitLabel ? { unitLabel } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
    periodLabel: yearsOut[yearsOut.length - 1].label,
    years: yearsOut,
    months: activeMonths,
    rows,
    breakdowns,
    warnings
  };
}

/**
 * Разбирает все видимые листы «ОПиУ» и «ОПиУ_<суффикс>» в книге вместе с парными «Расш. ОПиУ*».
 * Основной лист «ОПиУ» (без суффикса) всегда ставится первым, остальные — в порядке следования в книге.
 */
export function parseOpiuWorkbookAll(workbook: ExcelJS.Workbook): OpiuReport[] {
  const visibleSheets = workbook.worksheets.filter((ws) => ws.state !== "hidden" && ws.state !== "veryHidden");
  const matched = visibleSheets.filter((ws) => OPIU_SHEET_RE.test(ws.name.trim()));
  if (!matched.length) throw new OpiuParseError("в книге нет видимого листа «ОПиУ»");

  // Основной лист «ОПиУ» без суффикса — первым; остальные в исходном порядке книги.
  const mainSheets = matched.filter((ws) => labelKey(ws.name) === "опиу");
  const otherSheets = matched.filter((ws) => labelKey(ws.name) !== "опиу");
  const ordered = [...mainSheets, ...otherSheets];

  const seenIds = new Set<string>();
  return ordered.map((sheet) => {
    const rash = findPairedRashSheet(visibleSheets, sheet.name);
    const report = parseSingleOpiuSheet(sheet, rash);
    let id = report.id || "company";
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    seenIds.add(id);
    return { ...report, id };
  });
}

export function parseOpiuWorkbook(workbook: ExcelJS.Workbook): OpiuReport {
  return parseOpiuWorkbookAll(workbook)[0];
}

export async function parseOpiuExcelAll(buffer: Buffer): Promise<OpiuReport[]> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new OpiuParseError("файл ОПиУ не читается как .xlsx");
  }
  return parseOpiuWorkbookAll(workbook);
}

export async function parseOpiuExcel(buffer: Buffer): Promise<OpiuReport> {
  const reports = await parseOpiuExcelAll(buffer);
  return reports[0];
}
