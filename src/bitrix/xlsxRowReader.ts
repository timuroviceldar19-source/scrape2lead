import ExcelJS from "exceljs";
import type { ImportConfig } from "./importConfig.js";
import type { ImportRow } from "./importPlanner.js";

export async function readImportRows(inputPath: string, config: ImportConfig): Promise<ImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  if (inputPath.toLowerCase().endsWith(".csv")) {
    await workbook.csv.readFile(inputPath);
  } else {
    await workbook.xlsx.readFile(inputPath);
  }

  const worksheet = pickWorksheet(workbook, config.sheet, inputPath);
  const columnIndexes = resolveColumnIndexes(worksheet, config);

  const rows: ImportRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= config.headerRow) return;
    const values: Record<string, string> = {};
    for (const [key, index] of columnIndexes) {
      values[key] = cellText(row.getCell(index));
    }
    if (Object.values(values).every((value) => !value)) return;
    rows.push({ rowNumber, values });
  });

  return rows;
}

function pickWorksheet(
  workbook: ExcelJS.Workbook,
  sheet: ImportConfig["sheet"],
  inputPath: string
): ExcelJS.Worksheet {
  const worksheet = sheet === undefined
    ? workbook.worksheets[0]
    : typeof sheet === "number"
      ? workbook.worksheets[sheet - 1]
      : workbook.getWorksheet(sheet);
  if (!worksheet) {
    throw new Error(`worksheet ${sheet === undefined ? "(first)" : JSON.stringify(sheet)} not found in ${inputPath}`);
  }
  return worksheet;
}

function resolveColumnIndexes(worksheet: ExcelJS.Worksheet, config: ImportConfig): Map<string, number> {
  const headerCells = new Map<string, number>();
  worksheet.getRow(config.headerRow).eachCell((cell, colNumber) => {
    const header = cellText(cell).toLowerCase();
    if (header && !headerCells.has(header)) headerCells.set(header, colNumber);
  });

  const indexes = new Map<string, number>();
  const missingHeaders: string[] = [];
  for (const column of config.columns) {
    if (column.index !== undefined) {
      indexes.set(column.key, column.index);
      continue;
    }
    const index = headerCells.get(column.header!.trim().toLowerCase());
    if (index === undefined) {
      missingHeaders.push(column.header!);
      continue;
    }
    indexes.set(column.key, index);
  }

  if (missingHeaders.length > 0) {
    throw new Error(`header row ${config.headerRow} is missing column(s): ${missingHeaders.join(", ")}`);
  }
  return indexes;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((part) => part.text ?? "").join("").trim();
    if ("result" in value) return String(value.result ?? "").trim();
  }
  return String(value).trim();
}
