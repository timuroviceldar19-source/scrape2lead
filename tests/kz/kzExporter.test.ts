import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { exportKzReport } from "../../src/kz/kzExporter.js";
import { KzStorage } from "../../src/kz/kzStorage.js";
import type { StatGovRecord, TenderRecord } from "../../src/kz/tenderTypes.js";

describe("exportKzReport", () => {
  it("creates XLSX with Companies, Tenders, Summary and Errors sheets", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kz-export-"));
    const dbPath = path.join(tmp, "kz.db");
    const outPath = path.join(tmp, "report.xlsx");
    const storage = new KzStorage({ databasePath: dbPath });
    storage.upsertStatGov(company("220540025781"));
    storage.upsertTenders([tender("220540025781")]);
    storage.recordEnrichError("220540025781", "zakup", "search timeout");
    storage.close();

    const result = await exportKzReport({ databasePath: dbPath, outPath });

    expect(result).toMatchObject({ xlsxPath: outPath, companies: 1, tenders: 1, errors: 1 });
    expect(fs.existsSync(outPath)).toBe(true);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Companies",
      "Tenders",
      "Summary",
      "Errors"
    ]);
    expect(workbook.getWorksheet("Companies")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("Tenders")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("Errors")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("Companies")?.getRow(2).getCell(12).value).toBe(1);
  });
});

function company(bin: string): StatGovRecord {
  return {
    bin,
    name: "API-KZ",
    registration_date: "2022-05-18",
    oked: "46610",
    oked_name: "Trade",
    address: "Almaty",
    director: "Director",
    legal_status: "unknown",
    krp_code: null,
    krp_name: null,
    kfs_code: null,
    kfs_name: null,
    sector_code: null,
    sector_name: null,
    updated_at: "2026-06-07T00:00:00.000Z",
    raw_snapshot_path: null
  };
}

function tender(bin: string): TenderRecord {
  return {
    source: "zakup.sk.kz",
    bin,
    tender_number: "T-1",
    tender_name: "Tender",
    customer_name: "API-KZ",
    budget_amount: "1000",
    currency: "KZT",
    start_date: "2026-06-01",
    end_date: "2026-06-10",
    status: "PUBLISHED",
    method: "auction",
    url: "https://example.test",
    parsed_at: "2026-06-07T00:00:00.000Z"
  };
}
