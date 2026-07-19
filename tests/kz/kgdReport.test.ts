import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { writeCounterpartyExcel, writeCounterpartyPdf } from "../../src/kz/kgdReport.js";
import type { CounterpartyCheck } from "../../src/kz/kgdCounterpartyTypes.js";

const result: CounterpartyCheck = { bin: "000240001420", name: "ТОО Тест", validBin: true, vat: { status: "never_registered" }, bankruptcy: false, liquidation: { active: false }, esfRestricted: false, unreliable: false, unreliableReasons: [], bulkChecks: [{ source: "insolvent", status: "complete", matched: false, cacheAgeHours: 1, sourceUrl: "https://kgd.gov.kz/list", listDate: "2026-07-10" }], stages: { counterparty: "complete", liquidation: "complete", bulk: "complete" }, checkedAt: "2026-07-19T00:00:00Z", links: ["https://portal.kgd.gov.kz"], color: "green", explanations: ["не плательщик НДС"] };

describe("KGD report artifacts", () => {
  it("writes a styled/filterable Excel workbook with source dates", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kgd-report-")), "report.xlsx");
    await writeCounterpartyExcel([result], file);
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file); const sheet = book.worksheets[0];
    expect(sheet.autoFilter).toBeTruthy(); expect(sheet.views[0].state).toBe("frozen");
    expect(sheet.getRow(2).fill).toMatchObject({ type: "pattern", fgColor: { argb: "FFC6EFCE" } });
    expect(sheet.getRow(2).values.join(" ")).toContain("2026-07-10");
  });

  it("creates a non-empty ReportLab PDF with Cyrillic content", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kgd-pdf-")), "report.pdf");
    await writeCounterpartyPdf([result], file);
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
    expect(fs.readFileSync(file).subarray(0, 4).toString()).toBe("%PDF");
  });
});
