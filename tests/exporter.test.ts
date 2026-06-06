import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportLeads } from "../src/export/exporter.js";
import type { Lead } from "../src/types.js";
import ExcelJS from "exceljs";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-export-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

describe("Exporter", () => {
  let ws: ReturnType<typeof makeWorkspace>;
  beforeEach(() => { ws = makeWorkspace(); });
  afterEach(() => { ws.cleanup(); });

  const mockLeads: Lead[] = [
    {
      source: "2gis", external_id: "1", company_name: "A Company", category: "Test", city: "Moscow", address: "Addr",
      phones: ["123"], email: null, website: null, social_links: [], messenger_links: [], parsed_at: "2023-01-01", incomplete: false,
      crm_status: "Needs manual review", priority: "B", lead_score: 50, confidence_score: 0.8, enrichment_status: "manual_review", enrichment_error: "Some error",
      phone_status: "valid", address_status: "valid", website_status: "valid"
    } as Lead,
    {
      source: "2gis", external_id: "2", company_name: "B Company", category: "Test", city: "Moscow", address: "Addr",
      phones: ["123"], email: null, website: null, social_links: [], messenger_links: [], parsed_at: "2023-01-01", incomplete: false,
      crm_status: "Ready to contact", priority: "A", lead_score: 90, confidence_score: 0.95, phone_status: "valid", address_status: "valid", website_status: "valid", product_count: 5000, review_count: 100
    } as Lead,
    {
      source: "2gis", external_id: "3", company_name: "C Company", category: "Test", city: "Moscow", address: "Addr",
      phones: [], email: null, website: null, social_links: [], messenger_links: [], parsed_at: "2023-01-01", incomplete: false,
      crm_status: "Not enough data", lead_score: 10, enrichment_status: "failed", enrichment_error: "Blocked"
    } as Lead
  ];

  it("generates CSV and XLSX with sorted leads and new columns", async () => {
    const result = await exportLeads(mockLeads, ws.root);
    expect(fs.existsSync(result.csvPath)).toBe(true);
    expect(fs.existsSync(result.xlsxPath)).toBe(true);

    const csvContent = fs.readFileSync(result.csvPath, "utf-8");
    expect(csvContent).toContain("priority,crm_status,lead_score,confidence_score,company_name");
    
    const lines = csvContent.trim().split("\n");
    // Check sorting: A (Ready) should be first, then B (Manual), then undefined (Not enough)
    expect(lines[1]).toContain("A,Ready to contact,90");
    expect(lines[2]).toContain("B,Needs manual review,50");
    expect(lines[3]).toContain(",Not enough data,10");
  });

  it("handles null/undefined fields without crashing", async () => {
    const badLead = { 
      ...mockLeads[0], 
      priority: null as unknown as undefined, 
      lead_score: undefined, 
      enrichment_error: null as unknown as undefined 
    } as Lead;
    
    const result = await exportLeads([badLead], ws.root);
    const csvContent = fs.readFileSync(result.csvPath, "utf-8");
    // lead_score and priority should be empty, but row should exist
    expect(csvContent).toContain(",Needs manual review,");
  });

  it("creates multiple sheets in XLSX with Russian headers", async () => {
    const result = await exportLeads(mockLeads, ws.root);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.xlsxPath);

    expect(workbook.worksheets.map(w => w.name)).toEqual([
      "Все лиды",
      "Готовы к контакту",
      "Нужно проверить вручную",
      "Нужно дообогатить",
      "Ошибки enrichment",
      "Справочник полей"
    ]);

    const allSheet = workbook.getWorksheet("Все лиды");
    expect(allSheet?.getRow(1).getCell(1).value).toBe("Приоритет");
    expect(allSheet?.getRow(1).getCell(5).value).toBe("Компания");
    expect(allSheet?.getRow(1).getCell(10).value).toBe("Телефон");
    expect(allSheet?.getRow(1).getCell(11).value).toBe("Статус телефона");
  });

  it("includes dictionary sheet with explanations", async () => {
    const result = await exportLeads(mockLeads, ws.root);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.xlsxPath);

    const dictSheet = workbook.getWorksheet("Справочник полей");
    const descriptions: string[] = [];
    dictSheet?.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        descriptions.push(row.getCell(2).value as string);
      }
    });
    
    expect(descriptions).toContain("Оценка уверенности совпадения компании (0.0 - 1.0).");
    expect(descriptions).toContain("Статус валидации телефона (valid, invalid, empty).");
    expect(descriptions).toContain("Статус валидации сайта (valid, invalid, empty).");
    expect(descriptions).toContain("Статус валидации адреса (valid, invalid, empty).");
  });

  it("preserves enrichment_error in export", async () => {
    const result = await exportLeads(mockLeads, ws.root);
    const csvContent = fs.readFileSync(result.csvPath, "utf-8");
    expect(csvContent).toContain("Blocked");
    expect(csvContent).toContain("Some error");
  });
});
