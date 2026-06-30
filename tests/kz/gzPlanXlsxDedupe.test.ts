import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { dedupeGzPlansXlsx, findExactDuplicateRows } from "../../src/kz/gzPlanXlsxDedupe.js";

function makeRow(overrides: Record<number, string> = {}): string[] {
  const row = Array.from({ length: 23 }, (_, index) => `c${index + 1}`);
  row[0] = "000240001420";
  row[10] = "Панель интерактивная";
  row[16] = "Панель интерактивная";
  row[18] = "4792853";
  row[19] = "Июнь";
  row[21] = "4 105 172.00";
  row[22] = "Открытый конкурс";

  for (const [columnIndex, value] of Object.entries(overrides)) {
    row[Number(columnIndex) - 1] = value;
  }

  return row;
}

async function writeWorkbook(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Планы ГЗ");
  sheet.addRow(Array.from({ length: 23 }, (_, index) => `h${index + 1}`));
  sheet.addRow(makeRow());
  sheet.addRow(makeRow());
  sheet.addRow(makeRow({ 22: "3 715 897.00" }));
  sheet.addRow(makeRow({ 17: "Панель жидкокристаллическая" }));
  sheet.getRow(2).getCell(25).value = {
    text: "https://goszakup.gov.kz/ru/registry/show_plan/1",
    hyperlink: "https://goszakup.gov.kz/ru/registry/show_plan/1"
  };
  await workbook.xlsx.writeFile(filePath);
}

describe("gz plan XLSX dedupe", () => {
  it("finds only exact duplicate rows by the configured signature", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gz-plan-dedupe-"));
    const inputPath = path.join(dir, "input.xlsx");
    await writeWorkbook(inputPath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);
    const sheet = workbook.getWorksheet("Планы ГЗ");

    expect(findExactDuplicateRows(sheet!)).toEqual([3]);
  });

  it("writes a deduped workbook preserving non-exact repeats", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gz-plan-dedupe-"));
    const inputPath = path.join(dir, "input.xlsx");
    const outputPath = path.join(dir, "output.xlsx");
    await writeWorkbook(inputPath);

    const result = await dedupeGzPlansXlsx(inputPath, outputPath);

    expect(result.originalRows).toBe(4);
    expect(result.removedRows).toBe(1);
    expect(result.finalRows).toBe(3);
    expect(result.uniquePlanPointIds).toBe(1);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.getWorksheet("Планы ГЗ");
    expect(sheet?.rowCount).toBe(4);
    expect(sheet?.getRow(2).getCell(25).value).toEqual({
      text: "https://goszakup.gov.kz/ru/registry/show_plan/1",
      hyperlink: "https://goszakup.gov.kz/ru/registry/show_plan/1"
    });
  });
});
