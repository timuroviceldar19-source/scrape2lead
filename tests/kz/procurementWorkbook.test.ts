import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProcurementWorkbookModel } from "../../src/kz/procurement/workbookModel.js";
import { writeProcurementWorkbook } from "../../src/kz/procurement/workbookWriter.js";
import type { ClassifiedProcurement } from "../../src/kz/procurement/types.js";

describe("procurement workbook model", () => {
  it("creates Data, Review, Rejected and Summary with reconciled counts", () => {
    const model = buildProcurementWorkbookModel({
      data: [item("data", null)],
      review: [item("review", "missing_bin")],
      rejected: [item("rejected", "stop_word")]
    });
    expect(model.sheets.map((sheet) => sheet.name)).toEqual(["Data", "Review", "Rejected", "Summary"]);
    expect(model.summary).toMatchObject({ total: 3, data: 1, review: 1, rejected: 1 });
    expect(model.sheets.find((sheet) => sheet.name === "Summary")?.rows).toContainEqual(["stop_word", 1]);
  });

  it("writes a styled, filterable workbook with all four sheets", async () => {
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "procurement-xlsx-")), "result.xlsx");
    const classification = { data: [item("ok", null)], review: [item("review", "missing_bin")], rejected: [] };
    await writeProcurementWorkbook(target, buildProcurementWorkbookModel(classification));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(target);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Data", "Review", "Rejected", "Summary"]);
    expect(workbook.getWorksheet("Data")?.autoFilter).toBe("A1:T2");
    expect(workbook.getWorksheet("Summary")?.getCell("B2").value).toBe(2);
  });
});

function item(id: string, reason: ClassifiedProcurement["reason"]): ClassifiedProcurement {
  return {
    product: "pk",
    reason,
    record: {
      source: "mitwork", recordKind: "plan", externalId: id, parentExternalId: null,
      status: "Утвержден", productName: "Ноутбук", description: "", truCode: "262011.100.000002",
      customerName: "Customer", customerBin: id === "review" ? null : "123456789012", amount: 1_000_000,
      currency: "KZT", startDate: null, endDate: null, url: `https://example.kz/${id}`,
      purchaseMethod: null, collectedAt: "2026-07-21T00:00:00.000Z"
    }
  };
}
