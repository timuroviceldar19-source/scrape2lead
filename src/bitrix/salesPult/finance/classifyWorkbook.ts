// Классификация .xlsx-файлов из чата «Финансовый отчет» без падения на особенностях 1С-выгрузок.
// ExcelJS падает на drawing.anchors в выгрузках 1С («Отчет о реализации»), поэтому определение типа
// делается через @e965/xlsx, который читает и 1С, и ручные книги Excel без ошибок.

import * as XLSX from "@e965/xlsx";
import { labelKey } from "./parseReport.js";

export type FinanceWorkbookKind =
  | "daily"
  | "opiu"
  | "realization-client-tmc"
  | "realization-tmc-client"
  | "unknown";

function sheetHeaderRows(ws: XLSX.WorkSheet, maxRows = 12): string[][] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
  return rows.slice(0, maxRows).map((r) => (Array.isArray(r) ? r.map((v) => labelKey(String(v ?? ""))) : []));
}

function isHiddenSheet(wb: XLSX.WorkBook, index: number): boolean {
  const hidden = wb.Workbook?.Sheets?.[index]?.Hidden;
  return hidden === 1 || hidden === 2;
}

function isOpiuSheetKey(key: string): boolean {
  return key === "опиу" || key.startsWith("опиу_") || key.startsWith("опиу ");
}

/**
 * Определяет вид финансового файла по листам и шапке.
 * Не пишет содержимое файла в ошибки и не падает на нестандартной разметке.
 */
export function classifyFinanceWorkbook(buffer: Buffer | Uint8Array): FinanceWorkbookKind {
  // Быстрая проверка только по именам листов (не читает содержимое десятков скрытых листов в больших книгах ОПиУ).
  let metaWb: XLSX.WorkBook;
  try {
    metaWb = XLSX.read(buffer, { type: "buffer", bookSheets: true });
  } catch {
    return "unknown";
  }

  const visibleMeta = metaWb.SheetNames
    .map((name, i) => ({ name, key: labelKey(name), hidden: isHiddenSheet(metaWb, i) }))
    .filter((s) => !s.hidden);

  // 1. Ежедневный отчёт финансиста — лист «Ежед.»
  if (visibleMeta.some((s) => s.key === "ежед" || s.key.startsWith("ежед "))) {
    return "daily";
  }

  // 2. Финансовая отчётность (ОПиУ / ОПиУ_<компания> + Расш. ОПиУ*)
  if (visibleMeta.some((s) => isOpiuSheetKey(s.key))) {
    return "opiu";
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellStyles: false, cellFormula: false, sheetRows: 15 });
  } catch {
    return "unknown";
  }

  const visibleNames = wb.SheetNames
    .map((name, i) => ({ name, key: labelKey(name), hidden: isHiddenSheet(wb, i) }))
    .filter((s) => !s.hidden);

  // 3. Отчёт о реализации 1С (ТМЦ-Клиент или Клиент-ТМЦ)
  for (const sheet of visibleNames) {
    const ws = wb.Sheets[sheet.name];
    if (!ws) continue;
    const rows = sheetHeaderRows(ws, 12);
    const hasTitle = rows.some((r) => r.some((cell) => cell.includes("отчет о реализации")));
    if (!hasTitle) continue;
    for (const r of rows) {
      const first = r[0] ?? "";
      if (first === "контрагент") return "realization-client-tmc";
      if (first.includes("номенклатурн") && first.includes("групп")) return "realization-tmc-client";
    }
    // Если шапка «Отчет о реализации» есть, но заголовок первого столбца нестандартный — смотрим строки ниже
    for (const r of rows) {
      const first = r[0] ?? "";
      if (first.includes("номенклатура")) return "realization-tmc-client";
    }
  }

  // 4. Запасная проверка для ежедневного отчёта с переименованным листом (как в parseFinanceExcel)
  for (const sheet of visibleNames) {
    const ws = wb.Sheets[sheet.name];
    if (!ws) continue;
    const rows = sheetHeaderRows(ws, 15);
    const flat = rows.flat();
    if (flat.some((c) => c === "дс") && flat.some((c) => c === "тмц")) {
      return "daily";
    }
  }

  return "unknown";
}
