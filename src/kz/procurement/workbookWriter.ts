import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { ProcurementWorkbookModel } from "./workbookModel.js";

const HEADER_FILL = "1F4E78";
const HEADER_FONT = "FFFFFF";
const TAB_COLORS: Record<string, string> = {
  "Планы": "70AD47", "Тендеры": "4472C4", Review: "FFC000", Rejected: "C00000", Summary: "5B9BD5"
};
const LINK_HEADERS = new Set(["Ссылка", "Ссылка на наименование", "Ссылка на заказчика", "Ссылка на пункт плана"]);
const MONEY_HEADERS = new Set(["Сумма", "Плановая сумма", "Цена за ед.", "Цена за единицу"]);
const TEXT_HEADERS = new Set(["БИН", "БИН Заказчика", "Кандидат БИН", "КАТО", "ID карточки", "Внешний ID",
  "Внешний ID тендера", "ID связанного плана", "№ пункта плана", "ID пункта (API)"]);

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
  header.height = 36;
  header.font = { bold: true, color: { argb: HEADER_FONT } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.eachCell((cell) => { cell.border = border(); });

  sheet.columns.forEach((column, index) => {
    const label = String(sheet.getCell(1, index + 1).value ?? "");
    column.width = width(label);
  });

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (rowNumber % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "EAF2F8" } };
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell) => { cell.border = border("D9E2F3"); });
    const rowValues = Array.isArray(row.values) ? row.values : [];
    const lineCounts = Array.from(rowValues.slice(1), (value) => String(value ?? "").split("\n").length);
    const maxLines = Math.max(1, ...lineCounts);
    row.height = Math.min(90, Math.max(20, maxLines * 15));
  }

  if (!filterable || sheet.columnCount === 0) return;
  sheet.autoFilter = { from: "A1", to: `${columnLetter(sheet.columnCount)}${Math.max(1, sheet.rowCount)}` };
  for (let column = 1; column <= sheet.columnCount; column++) {
    const label = String(sheet.getCell(1, column).value ?? "");
    if (LINK_HEADERS.has(label)) applyLinks(sheet, column);
    if (MONEY_HEADERS.has(label)) sheet.getColumn(column).numFmt = "#,##0 \"₸\"";
    if (TEXT_HEADERS.has(label)) sheet.getColumn(column).numFmt = "@";
  }
}

function applyLinks(sheet: ExcelJS.Worksheet, column: number): void {
  for (let row = 2; row <= sheet.rowCount; row++) {
    const cell = sheet.getCell(row, column);
    const value = String(cell.value ?? "").trim();
    if (value) cell.value = { text: "Открыть", hyperlink: value };
  }
}

function width(label: string): number {
  if (LINK_HEADERS.has(label)) return 18;
  if (["Описание", "Дополнительная характеристика", "Краткая характеристика", "Дополнительное описание", "Место поставки", "Места поставки"].includes(label)) return 48;
  if (["Наименование заказчика", "Наименование", "Наименование закупаемых товаров (СТРУ)", "Наименование (каз.)"].includes(label)) return 38;
  if (["БИН", "БИН Заказчика", "КАТО", "Количество по адресам"].includes(label)) return 18;
  if (label === "Metric") return 48;
  return 20;
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
