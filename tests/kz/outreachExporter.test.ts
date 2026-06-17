import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutreachProspect, OutreachWinner } from "../../src/kz/outreachDigest.js";
import { exportOutreachQueue, exportWinnersDigest } from "../../src/kz/outreachExporter.js";
import type { ScoredCompanyCard } from "../../src/kz/kzLeadScore.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-outreach-export-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function makeCard(overrides: Partial<ScoredCompanyCard> = {}): ScoredCompanyCard {
  return {
    bin: "061040006408",
    name: 'ТОО "ALAU"',
    director: "Иванов И.И.",
    registry_phone: "+7 (777) 123-45-67",
    registry_email: "alau@mail.kz",
    registry_website: null,
    lead_priority: "A",
    tender_count_active: 2,
    tender_active_budget_sum: 50_000_000,
    tender_count_total: 5,
    ...overrides
  } as ScoredCompanyCard;
}

function headerMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => {
    if (cell.value) headers.set(String(cell.value), col);
  });
  return headers;
}

describe("outreachExporter", () => {
  let ws: ReturnType<typeof makeWorkspace>;
  beforeEach(() => { ws = makeWorkspace(); });
  afterEach(() => { ws.cleanup(); });

  it("queue export writes CRM-статус and CRM-заметка from prospect", async () => {
    const prospect: OutreachProspect = {
      card: makeCard(),
      new_active_tenders: [{
        tender_number: "T-1",
        tender_name: "Закупка",
        customer_name: "Заказчик",
        amount: 10_000_000,
        status: "Опубликовано",
        url: null,
        crm_status: "contacted",
        crm_note: "called buyer"
      }],
      gis_phone: "",
      gis_company_names: "",
      crm_status: "contacted",
      crm_note: "called buyer"
    };

    const outPath = path.join(ws.root, "queue.xlsx");
    await exportOutreachQueue([prospect], outPath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    const sheet = workbook.getWorksheet("Outreach Queue")!;
    const headers = headerMap(sheet);
    expect(headers.has("CRM-статус")).toBe(true);
    expect(headers.has("CRM-заметка")).toBe(true);

    const row = sheet.getRow(2);
    expect(row.getCell(headers.get("CRM-статус")!).value).toBe("contacted");
    expect(row.getCell(headers.get("CRM-заметка")!).value).toBe("called buyer");
  });

  it("winners digest includes CRM columns and contract status header", async () => {
    const winner: OutreachWinner = {
      bin: "061040006408",
      company_name: 'ТОО "ALAU"',
      director: "Иванов И.И.",
      phone: "+7 (777) 123-45-67",
      email: "alau@mail.kz",
      gis_phone: "",
      contract_number: "CT-100",
      contract_name: "Договор CT-100",
      customer_name: "ГУ Заказчик",
      amount: 60_000_000,
      amount_raw: "60000000",
      contract_date: "2026-06-05",
      status: "Действует",
      url: "https://example.com",
      crm_status: "interested",
      crm_note: "wants follow-up"
    };

    const outPath = path.join(ws.root, "winners.xlsx");
    await exportWinnersDigest([winner], outPath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    const sheet = workbook.getWorksheet("Winners")!;
    const headers = headerMap(sheet);
    expect(headers.get("Статус контракта")).toBeDefined();
    expect(headers.get("CRM-статус")).toBeDefined();
    expect(headers.get("CRM-заметка")).toBeDefined();

    const row = sheet.getRow(2);
    expect(row.getCell(headers.get("Статус контракта")!).value).toBe("Действует");
    expect(row.getCell(headers.get("CRM-статус")!).value).toBe("interested");
    expect(row.getCell(headers.get("CRM-заметка")!).value).toBe("wants follow-up");
  });
});
