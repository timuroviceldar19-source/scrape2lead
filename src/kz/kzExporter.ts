import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { KzStorage } from "./kzStorage.js";
import type { CompanyCard, EnrichError, TenderRecord } from "./tenderTypes.js";

export interface KzExportOptions {
  databasePath?: string;
  bins?: string[];
  outPath?: string;
}

export interface KzExportResult {
  xlsxPath: string;
  companies: number;
  tenders: number;
  errors: number;
}

const COMPANY_COLUMNS: Array<{ header: string; key: keyof CompanyCard; width: number }> = [
  { header: "БИН", key: "bin", width: 16 },
  { header: "Компания", key: "name", width: 42 },
  { header: "Дата регистрации", key: "registration_date", width: 18 },
  { header: "ОКЭД", key: "oked", width: 12 },
  { header: "ОКЭД название", key: "oked_name", width: 46 },
  { header: "Адрес", key: "address", width: 46 },
  { header: "Директор", key: "director", width: 32 },
  { header: "Статус юрлица", key: "legal_status", width: 18 },
  { header: "КРП", key: "krp_name", width: 24 },
  { header: "КФС", key: "kfs_name", width: 30 },
  { header: "Сектор", key: "sector_name", width: 30 },
  { header: "Всего закупок", key: "tender_count_total", width: 16 },
  { header: "Активные закупки", key: "tender_count_active", width: 18 },
  { header: "Сумма закупок", key: "tender_budget_sum", width: 18 },
  { header: "Источники закупок", key: "tender_sources", width: 24 },
  { header: "Последняя дата окончания", key: "last_tender_end_date", width: 24 },
  { header: "Обновлено", key: "updated_at", width: 24 }
];

const TENDER_COLUMNS: Array<{ header: string; key: keyof TenderRecord | "company_name"; width: number }> = [
  { header: "Источник", key: "source", width: 18 },
  { header: "БИН", key: "bin", width: 16 },
  { header: "Компания", key: "company_name", width: 42 },
  { header: "Номер закупки", key: "tender_number", width: 20 },
  { header: "Название закупки", key: "tender_name", width: 52 },
  { header: "Заказчик", key: "customer_name", width: 42 },
  { header: "Бюджет", key: "budget_amount", width: 16 },
  { header: "Валюта", key: "currency", width: 10 },
  { header: "Дата начала", key: "start_date", width: 18 },
  { header: "Дата окончания", key: "end_date", width: 18 },
  { header: "Статус", key: "status", width: 18 },
  { header: "Метод", key: "method", width: 18 },
  { header: "URL", key: "url", width: 42 },
  { header: "Спарсено", key: "parsed_at", width: 24 }
];

export async function exportKzReport(options: KzExportOptions = {}): Promise<KzExportResult> {
  const storage = new KzStorage({ databasePath: options.databasePath });
  try {
    const cards = storage.getCompanyCards(options.bins);
    const cardBins = cards.map((card) => card.bin);
    const binsForTenders = options.bins && options.bins.length > 0 ? options.bins : cardBins;
    const tenders = storage.getTendersByBins(binsForTenders);
    const errors = filterErrors(storage.getEnrichErrors(), options.bins);
    const xlsxPath = options.outPath ?? defaultOutputPath();

    fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Scrape2Lead";
    workbook.created = new Date();

    addCompaniesSheet(workbook, cards);
    addTendersSheet(workbook, tenders, cards);
    addSummarySheet(workbook, cards, tenders);
    addErrorsSheet(workbook, errors);

    await workbook.xlsx.writeFile(xlsxPath);
    return {
      xlsxPath,
      companies: cards.length,
      tenders: tenders.length,
      errors: errors.length
    };
  } finally {
    storage.close();
  }
}

function addCompaniesSheet(workbook: ExcelJS.Workbook, cards: CompanyCard[]): void {
  const sheet = workbook.addWorksheet("Companies");
  sheet.columns = COMPANY_COLUMNS;
  sheet.addRows(cards.map((card) => ({ ...card })));
  styleSheet(sheet);
  const budgetCol = COMPANY_COLUMNS.findIndex((col) => col.key === "tender_budget_sum") + 1;
  sheet.getColumn(budgetCol).numFmt = "#,##0.00";
}

function addTendersSheet(workbook: ExcelJS.Workbook, tenders: TenderRecord[], cards: CompanyCard[]): void {
  const sheet = workbook.addWorksheet("Tenders");
  const companyNames = new Map(cards.map((card) => [card.bin, card.name]));
  sheet.columns = TENDER_COLUMNS;
  sheet.addRows(tenders.map((tender) => ({
    ...tender,
    company_name: companyNames.get(tender.bin) ?? tender.customer_name ?? ""
  })));
  styleSheet(sheet);
  const budgetCol = TENDER_COLUMNS.findIndex((col) => col.key === "budget_amount") + 1;
  sheet.getColumn(budgetCol).numFmt = "#,##0.00";
}

function addSummarySheet(workbook: ExcelJS.Workbook, cards: CompanyCard[], tenders: TenderRecord[]): void {
  const sheet = workbook.addWorksheet("Summary");
  sheet.columns = [
    { header: "Метрика", key: "metric", width: 36 },
    { header: "Значение", key: "value", width: 24 }
  ];

  const withTenders = cards.filter((card) => card.tender_count_total > 0).length;
  sheet.addRows([
    { metric: "Компаний всего", value: cards.length },
    { metric: "Компаний с закупками", value: withTenders },
    { metric: "Закупок всего", value: tenders.length },
    { metric: "Активных закупок", value: cards.reduce((sum, card) => sum + card.tender_count_active, 0) },
    { metric: "Сумма бюджетов", value: cards.reduce((sum, card) => sum + (card.tender_budget_sum ?? 0), 0) }
  ]);

  sheet.addRow({});
  sheet.addRow({ metric: "По источникам" });
  for (const [source, count] of countBy(tenders, (tender) => tender.source)) {
    sheet.addRow({ metric: source, value: count });
  }

  sheet.addRow({});
  sheet.addRow({ metric: "По статусам закупок" });
  for (const [status, count] of countBy(tenders, (tender) => tender.status ?? "unknown")) {
    sheet.addRow({ metric: status, value: count });
  }

  styleSheet(sheet);
  sheet.getColumn(2).numFmt = "#,##0.00";
}

function addErrorsSheet(workbook: ExcelJS.Workbook, errors: EnrichError[]): void {
  const sheet = workbook.addWorksheet("Errors");
  sheet.columns = [
    { header: "ID", key: "id", width: 10 },
    { header: "БИН", key: "bin", width: 16 },
    { header: "Этап", key: "stage", width: 18 },
    { header: "Ошибка", key: "message", width: 72 },
    { header: "Создано", key: "created_at", width: 24 }
  ];
  sheet.addRows(errors);
  styleSheet(sheet);
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
  for (const column of sheet.columns) {
    column.alignment = { vertical: "top", wrapText: true };
  }
}

function countBy<T>(items: T[], getKey: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function filterErrors(errors: EnrichError[], bins?: string[]): EnrichError[] {
  if (!bins || bins.length === 0) return errors;
  const allowed = new Set(bins);
  return errors.filter((error) => allowed.has(error.bin));
}

function defaultOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join("exports", `kz-${stamp}.xlsx`);
}
