import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { ProcurementWorkbookModel } from "./workbookModel.js";

const HEADER_FILL = "1F4E78";
const HEADER_FONT = "FFFFFF";
const TAB_COLORS: Record<string, string> = {
  Data: "70AD47", Review: "FFC000", Rejected: "C00000", Summary: "5B9BD5"
};

export async function writeProcurementWorkbook(targetPath: string, model: ProcurementWorkbookModel): Promise<void> {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Scrape2Lead";
  workbook.created = new Date();
  workbook.modified = new Date();

  for (const source of model.sheets) {
    const sheet = workbook.addWorksheet(source.name, {
      views: [{ state: "frozen", ySplit: 1 }],
      properties: { tabColor: { argb: TAB_COLORS[source.name] ?? "5B9BD5" } }
    });
    sheet.addRows(source.rows);
    styleSheet(sheet, source.name !== "Summary");
  }
  await workbook.xlsx.writeFile(targetPath);
}

function styleSheet(sheet: ExcelJS.Worksheet, filterable: boolean): void {
  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { bold: true, color: { argb: HEADER_FONT } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.eachCell((cell) => { cell.border = border(); });

  const widthByHeader: Record<string, number> = {
    Source: 12, Kind: 10, "Source record ID": 18, "External ID": 20, "Parent ID": 18,
    Product: 12, Reason: 22, Status: 20, Name: 42, Description: 48, "TRU code": 22,
    Customer: 34, BIN: 16, Amount: 17, Currency: 10, Start: 20, End: 20, Method: 24, URL: 18,
    "Collected at": 22, "Enrichment source": 22, Confidence: 14, "Candidate BIN": 18,
    "Candidate TRU code": 22, Metric: 42, Count: 18, Value: 18
  };
  sheet.columns.forEach((column, index) => {
    const label = String(sheet.getCell(1, index + 1).value ?? "");
    column.width = widthByHeader[label] ?? 16;
  });

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (rowNumber % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "EAF2F8" } };
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell) => { cell.border = border("D9E2F3"); });
  }

  if (filterable && sheet.columnCount > 0) {
    sheet.autoFilter = { from: "A1", to: `${columnLetter(sheet.columnCount)}${Math.max(1, sheet.rowCount)}` };
    const urlColumn = findHeader(sheet, "URL");
    if (urlColumn) {
      for (let row = 2; row <= sheet.rowCount; row++) {
        const cell = sheet.getCell(row, urlColumn);
        const value = String(cell.value ?? "");
        if (value) cell.value = { text: "Открыть", hyperlink: value };
      }
    }
    const amountColumn = findHeader(sheet, "Amount");
    if (amountColumn) sheet.getColumn(amountColumn).numFmt = "#,##0 [$₸-kk-KZ]";
  }
}

function findHeader(sheet: ExcelJS.Worksheet, name: string): number | null {
  for (let column = 1; column <= sheet.columnCount; column++) if (sheet.getCell(1, column).value === name) return column;
  return null;
}

function columnLetter(column: number): string {
  let result = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

function border(color = "B4C6E7"): Partial<ExcelJS.Borders> {
  const side: Partial<ExcelJS.Border> = { style: "thin", color: { argb: color } };
  return { top: side, left: side, bottom: side, right: side };
}
