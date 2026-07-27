import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProcurementWorkbookModel } from "../../src/kz/procurement/workbookModel.js";
import { writeProcurementWorkbook } from "../../src/kz/procurement/workbookWriter.js";
import type { ClassifiedProcurement } from "../../src/kz/procurement/types.js";
import { EMPTY_PLAN_PERIOD } from "../../src/kz/procurement/planPeriod.js";

describe("procurement workbook model", () => {
  it("creates separate business sheets and control sheets with reconciled counts", () => {
    const model = buildProcurementWorkbookModel({
      data: [item("data", null)],
      review: [item("review", "missing_bin")],
      rejected: [item("rejected", "stop_word")]
    }, { complete: true, planYears: [{ year: 2026, planYearId: 12 }], pageLimit: 500, pagesFetched: 17,
      incompleteReasons: [], warnings: [] });
    expect(model.sheets.map((sheet) => sheet.name)).toEqual(["Планы", "Тендеры", "Review", "Rejected", "Summary"]);
    expect(model.summary).toMatchObject({ total: 3, data: 1, review: 1, rejected: 1 });
    expect(model.sheets.find((sheet) => sheet.name === "Summary")?.rows).toContainEqual(["stop_word", 1]);
    expect(model.sheets.find((sheet) => sheet.name === "Summary")?.rows).toContainEqual(["source:mitwork", 3]);
    expect(model.sheets.find((sheet) => sheet.name === "Summary")?.rows).toContainEqual(["collection:complete", "yes"]);
    expect(model.sheets.find((sheet) => sheet.name === "Summary")?.rows).toContainEqual(["collection:plan_year:2026", 12]);
    expect(model.sheets.find((sheet) => sheet.name === "Summary")?.rows).toContainEqual(["collection:year_conflicts", 0]);
    expect(model.sheets.find((sheet) => sheet.name === "Планы")?.rows[0]).toEqual(expect.arrayContaining([
      "БИН Заказчика", "Дата акта, которым утвержден план", "Код товара/работы/услуги (СТРУ)",
      "Единица измерения", "Кол-во", "Цена за ед.", "КАТО", "Количество по адресам", "Источник обогащения"
    ]));
    const plans = model.sheets.find((sheet) => sheet.name === "Планы");
    const customerLinkColumn = plans?.rows[0].indexOf("Ссылка на заказчика") ?? -1;
    expect(plans?.rows[1][customerLinkColumn]).toBe("https://zakup.gov.kz/registry/pipp/117476");
  });

  it("writes a styled, filterable workbook with five sheets and joined delivery places", async () => {
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "procurement-xlsx-")), "result.xlsx");
    const classification = { data: [item("ok", null)], review: [item("review", "missing_bin")], rejected: [] };
    await writeProcurementWorkbook(target, buildProcurementWorkbookModel(classification));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(target);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Планы", "Тендеры", "Review", "Rejected", "Summary"]);
    const plans = workbook.getWorksheet("Планы");
    expect(plans?.autoFilter).toBeTruthy();
    expect(plans?.getColumn(1).numFmt).toBe("@");
    expect(plans?.getColumn(18).numFmt).toBe("@");
    const headerValues = plans?.getRow(1).values;
    const placeHeader = Array.isArray(headerValues) ? headerValues.findIndex((value) => value === "Место поставки") : -1;
    expect(plans?.getCell(2, placeHeader).value).toBe("Астана\nАлматы");
    expect(plans?.getRow(2).height).toBeGreaterThan(20);
    expect(workbook.getWorksheet("Summary")?.getCell("B2").value).toBe(2);
  });
});

function item(id: string, reason: ClassifiedProcurement["reason"]): ClassifiedProcurement {
  return {
    product: "pk",
    reason,
    record: {
      source: "mitwork", recordKind: "plan", externalId: id, parentExternalId: null,
      customerSourceId: "117476",
      status: "Утвержден", productName: "Ноутбук", description: "", truCode: "262011.100.000002",
      customerName: "Customer", customerBin: id === "review" ? null : "123456789012", amount: 1_000_000,
      currency: "KZT", startDate: null, endDate: null, url: `https://example.kz/${id}`,
      purchaseMethod: null, ...EMPTY_PLAN_PERIOD, collectedAt: "2026-07-21T00:00:00.000Z"
      , planDetail: { approvedAt: "2026-04-15", financialYear: 2026, planYearId: 12, planMonth: null, nameRu: "Ноутбук", nameKk: "Ноутбук",
        shortDescriptionRu: "Описание", shortDescriptionKk: null, extraDescription: null, unitName: "Штука",
        quantity: 4, unitPrice: 250_000, prepaymentPercent: null, deliveryDeadline: null, itemType: "Товар",
        deliveries: [{ address: "Астана", kato: "710000000", quantity: 2 }, { address: "Алматы", kato: "750000000", quantity: 2 }] }
    }
  };
}
