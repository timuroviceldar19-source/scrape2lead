import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { scoreCompanyCards } from "./kzLeadScore.js";
import { KzStorage } from "./kzStorage.js";
import { formatLeadPhone, mergeLeadsWithKz } from "./leadKzMerge.js";
import { groupMatchesByKzBin } from "./unifiedExporter.js";

export interface SalesExportOptions {
  databasePath?: string;
  batchCsv?: string;
  topACsv?: string;
  outPath?: string;
}

export interface SalesExportResult {
  xlsxPath: string;
  companies: number;
  withRegistryPhone: number;
  with2gisPhone: number;
}

const SALES_COLUMNS = [
  { header: "№", key: "rank", width: 6 },
  { header: "БИН", key: "bin", width: 16 },
  { header: "Компания", key: "name", width: 46 },
  { header: "Приоритет", key: "lead_priority", width: 12 },
  { header: "Активные закупки", key: "tender_count_active", width: 18 },
  { header: "Сумма активных, ₸", key: "tender_active_budget_sum", width: 20 },
  { header: "Всего закупок", key: "tender_count_total", width: 16 },
  { header: "Телефон (registry)", key: "registry_phone", width: 22 },
  { header: "Email", key: "registry_email", width: 28 },
  { header: "Сайт", key: "registry_website", width: 28 },
  { header: "Директор", key: "director", width: 32 },
  { header: "2GIS match", key: "has_2gis", width: 12 },
  { header: "Телефон (2GIS)", key: "gis_phone", width: 22 },
  { header: "2GIS компании", key: "gis_company_names", width: 36 }
];

export async function exportSalesTopAReport(options: SalesExportOptions = {}): Promise<SalesExportResult> {
  const dbPath = options.databasePath ?? "data/scrape2lead.db";
  const batchCsv = options.batchCsv ?? "bins-batch-100.csv";
  const topACsv = options.topACsv ?? "bins-top-a.csv";
  const outPath = options.outPath ?? "exports/kz-top-a-sales.xlsx";

  const batchBins = readBinsCsv(batchCsv);
  const topABins = new Set(readBinsCsv(topACsv));

  const db = new Database(dbPath);
  const storage = new KzStorage({ db });
  try {
    const cards = scoreCompanyCards(storage.getCompanyCards(batchBins))
      .filter((card) => topABins.has(card.bin) && card.lead_priority === "A")
      .sort((a, b) => (b.tender_active_budget_sum ?? 0) - (a.tender_active_budget_sum ?? 0));

    const { matches } = mergeLeadsWithKz(db, cards);
    const matchesByBin = groupMatchesByKzBin(matches);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Scrape2Lead";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Sales Top-A");
    sheet.columns = SALES_COLUMNS;

    const rows = cards.map((card, index) => {
      const gisMatches = matchesByBin.get(card.bin) ?? [];
      const gisPhone = gisMatches.map((match) => formatLeadPhone(match)).filter(Boolean).join("; ");
      return {
        rank: index + 1,
        bin: card.bin,
        name: card.name,
        lead_priority: card.lead_priority,
        tender_count_active: card.tender_count_active,
        tender_active_budget_sum: card.tender_active_budget_sum,
        tender_count_total: card.tender_count_total,
        registry_phone: card.registry_phone ?? "",
        registry_email: card.registry_email ?? "",
        registry_website: card.registry_website ?? "",
        director: card.director ?? "",
        has_2gis: gisMatches.length > 0,
        gis_phone: gisPhone,
        gis_company_names: [...new Set(gisMatches.map((match) => match.company_name))].join("; ")
      };
    });

    sheet.addRows(rows);
    styleSheet(sheet);
    sheet.getColumn(6).numFmt = "#,##0.00";

    await workbook.xlsx.writeFile(outPath);

    return {
      xlsxPath: outPath,
      companies: rows.length,
      withRegistryPhone: rows.filter((row) => row.registry_phone.trim()).length,
      with2gisPhone: rows.filter((row) => row.gis_phone.trim()).length
    };
  } finally {
    storage.close();
    db.close();
  }
}

function readBinsCsv(csvPath: string): string[] {
  const text = fs.readFileSync(csvPath, "utf8").trim();
  const lines = text.split(/\r?\n/).slice(1);
  return lines.map((line) => line.trim()).filter(Boolean);
}

function styleSheet(sheet: ExcelJS.Worksheet): void {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns.length }
  };
}
