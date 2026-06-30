import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const HEADER_ROW = 1;
const DATA_START_ROW = 2;

const COL_CUSTOMER_BIN = 1;
const COL_STRU_NAME = 11;
const COL_KEYWORD = 17;
const COL_PLAN_POINT_ID = 19;
const COL_PLANNED_MONTH = 20;
const COL_PLANNED_AMOUNT = 22;
const COL_METHOD = 23;

const SIGNATURE_COLUMNS = [
  COL_KEYWORD,
  COL_PLAN_POINT_ID,
  COL_PLANNED_MONTH,
  COL_PLANNED_AMOUNT,
  COL_STRU_NAME,
  COL_CUSTOMER_BIN,
  COL_METHOD
];

export interface GzPlanXlsxDedupeResult {
  inputPath: string;
  outputPath: string;
  originalRows: number;
  removedRows: number;
  finalRows: number;
  uniquePlanPointIds: number;
}

export async function dedupeGzPlansXlsx(inputPath: string, outputPath: string): Promise<GzPlanXlsxDedupeResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`Workbook has no worksheets: ${inputPath}`);
  }

  const originalRows = Math.max(sheet.rowCount - HEADER_ROW, 0);
  const duplicateRows = findExactDuplicateRows(sheet);

  for (const rowNumber of duplicateRows.sort((a, b) => b - a)) {
    sheet.spliceRows(rowNumber, 1);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  return {
    inputPath,
    outputPath,
    originalRows,
    removedRows: duplicateRows.length,
    finalRows: Math.max(sheet.rowCount - HEADER_ROW, 0),
    uniquePlanPointIds: countUniquePlanPointIds(sheet)
  };
}

export function findExactDuplicateRows(sheet: ExcelJS.Worksheet): number[] {
  const seen = new Set<string>();
  const duplicateRows: number[] = [];

  for (let rowNumber = DATA_START_ROW; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const signature = buildDedupeSignature(row);
    if (seen.has(signature)) {
      duplicateRows.push(rowNumber);
      continue;
    }
    seen.add(signature);
  }

  return duplicateRows;
}

export function buildDedupeSignature(row: ExcelJS.Row): string {
  return SIGNATURE_COLUMNS.map((columnIndex) => cellToText(row.getCell(columnIndex).value)).join("|");
}

function countUniquePlanPointIds(sheet: ExcelJS.Worksheet): number {
  const ids = new Set<string>();
  for (let rowNumber = DATA_START_ROW; rowNumber <= sheet.rowCount; rowNumber++) {
    const id = cellToText(sheet.getRow(rowNumber).getCell(COL_PLAN_POINT_ID).value);
    if (id) ids.add(id);
  }
  return ids.size;
}

function cellToText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value && value.result != null) return String(value.result).trim();
    if (value instanceof Date) return value.toISOString();
  }
  return String(value).trim();
}
