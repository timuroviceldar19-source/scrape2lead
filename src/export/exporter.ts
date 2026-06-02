import fs from "node:fs";
import path from "node:path";
import { createObjectCsvWriter } from "csv-writer";
import ExcelJS from "exceljs";
import type { Lead } from "../types.js";

const headers = [
  "source",
  "external_id",
  "company_name",
  "category",
  "city",
  "address",
  "phones",
  "email",
  "website",
  "social_links",
  "messenger_links",
  "parsed_at",
  "incomplete"
] as const;

export async function exportLeads(leads: Lead[], exportDir: string): Promise<{ csvPath: string; xlsxPath: string }> {
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = path.join(exportDir, `leads-${stamp}.csv`);
  const xlsxPath = path.join(exportDir, `leads-${stamp}.xlsx`);
  const rows = leads.map(flattenLead);

  await createObjectCsvWriter({
    path: csvPath,
    header: headers.map((id) => ({ id, title: id }))
  }).writeRecords(rows);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");
  sheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(16, header.length + 2) }));
  sheet.addRows(rows);
  sheet.getRow(1).font = { bold: true };
  await workbook.xlsx.writeFile(xlsxPath);

  return { csvPath, xlsxPath };
}

function flattenLead(lead: Lead): Record<(typeof headers)[number], string | boolean> {
  return {
    ...lead,
    phones: lead.phones.join("; "),
    email: lead.email ?? "",
    website: lead.website ?? "",
    social_links: lead.social_links.join("; "),
    messenger_links: lead.messenger_links.join("; ")
  };
}
