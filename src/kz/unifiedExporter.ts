import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { dedupeEnrichErrors, isStatGovMissingForCard } from "./enrichErrors.js";
import { scoreCompanyCards } from "./kzLeadScore.js";
import { KzStorage } from "./kzStorage.js";
import { mergeLeadsWithKz, writeKzToLeads, type LeadKzMatch, type LeadKzMergeStats } from "./leadKzMerge.js";
import type { EnrichError, TenderRecord } from "./tenderTypes.js";

export interface UnifiedExportOptions {
  databasePath?: string;
  outPath?: string;
  priority?: string;
  bins?: string[];
}

export interface UnifiedExportResult {
  xlsxPath: string;
  leads: number;
  tenders: number;
  errors: number;
  mergeStats: LeadKzMergeStats;
}

const LEAD_COLUMNS = [
  { header: "Приоритет KZ", key: "lead_priority", width: 14 },
  { header: "High volume", key: "high_volume", width: 14 },
  { header: "Stat missing", key: "stat_missing", width: 14 },
  { header: "Match type", key: "match_type", width: 20 },
  { header: "Match score", key: "match_score", width: 12 },
  { header: "Компания (lead)", key: "company_name", width: 42 },
  { header: "БИН (lead)", key: "bin", width: 16 },
  { header: "БИН (KZ)", key: "kz_bin", width: 16 },
  { header: "Всего закупок", key: "tender_count_total", width: 16 },
  { header: "Активные закупки", key: "tender_count_active", width: 18 },
  { header: "Сумма закупок", key: "tender_budget_sum", width: 18 },
  { header: "Сумма активных", key: "tender_active_budget_sum", width: 18 },
  { header: "Телефон (2GIS)", key: "phone", width: 22 },
  { header: "Телефон (registry)", key: "registry_phone", width: 22 },
  { header: "Email (registry)", key: "registry_email", width: 28 },
  { header: "Сайт (registry)", key: "registry_website", width: 28 },
  { header: "Адрес (2GIS)", key: "address", width: 46 },
  { header: "Адрес (stat)", key: "stat_address", width: 46 },
  { header: "Директор", key: "director", width: 32 },
  { header: "ОКЭД", key: "oked", width: 12 },
  { header: "ОКЭД название", key: "oked_name", width: 46 },
  { header: "Дата регистрации", key: "registration_date", width: 18 },
  { header: "Статус юрлица", key: "legal_status", width: 18 },
  { header: "Возраст (лет)", key: "company_age_years", width: 14 },
  { header: "CRM-статус", key: "crm_status", width: 20 },
  { header: "Lead score", key: "lead_score", width: 12 },
  { header: "Источник", key: "source", width: 16 },
  { header: "Внешний ID", key: "external_id", width: 20 }
];

export async function exportUnifiedReport(options: UnifiedExportOptions = {}): Promise<UnifiedExportResult> {
  const dbPath = options.databasePath ?? "data/scrape2lead.db";
  const db = new Database(dbPath);
  const kzStorage = new KzStorage({ db });

  try {
    const cards = scoreCompanyCards(kzStorage.getCompanyCards(options.bins));
    const { matches, stats } = mergeLeadsWithKz(db, cards);

    const filteredMatches = options.priority
      ? matches.filter((m) => m.company_card?.lead_priority === options.priority)
      : matches;

    const leadBins = new Set(filteredMatches.map((m) => m.kz_bin).filter(Boolean) as string[]);
    const tenders = kzStorage.getTendersByBins(Array.from(leadBins));
    const errors = dedupeEnrichErrors(kzStorage.getEnrichErrors(), Array.from(leadBins));

    const xlsxPath = options.outPath ?? defaultOutputPath();
    fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Scrape2Lead";
    workbook.created = new Date();

    addLeadsSheet(workbook, filteredMatches);
    addTendersSheet(workbook, tenders, filteredMatches);
    addSummarySheet(workbook, filteredMatches, tenders, stats);
    addErrorsSheet(workbook, errors);

    await workbook.xlsx.writeFile(xlsxPath);

    return {
      xlsxPath,
      leads: filteredMatches.length,
      tenders: tenders.length,
      errors: errors.length,
      mergeStats: stats
    };
  } finally {
    kzStorage.close();
  }
}

function addLeadsSheet(workbook: ExcelJS.Workbook, matches: LeadKzMatch[]): void {
  const sheet = workbook.addWorksheet("Leads");
  sheet.columns = LEAD_COLUMNS;

  const rows = matches.map((m) => ({
    lead_priority: m.company_card?.lead_priority ?? "",
    high_volume: m.company_card?.high_volume ?? false,
    stat_missing: isStatGovMissingForCard({
      participant_id: m.registry?.participant_id,
      registry_phone: m.registry?.phone,
      oked: m.stat_gov?.oked
    }),
    match_type: m.match_type,
    match_score: m.match_score > 0 ? m.match_score.toFixed(2) : "",
    company_name: m.company_name,
    bin: m.bin ?? "",
    kz_bin: m.kz_bin ?? "",
    tender_count_total: m.company_card?.tender_count_total ?? 0,
    tender_count_active: m.company_card?.tender_count_active ?? 0,
    tender_budget_sum: m.company_card?.tender_budget_sum ?? null,
    tender_active_budget_sum: m.company_card?.tender_active_budget_sum ?? null,
    phone: "",
    registry_phone: m.registry?.phone ?? "",
    registry_email: m.registry?.email ?? "",
    registry_website: m.registry?.website ?? "",
    address: "",
    stat_address: m.stat_gov?.address ?? "",
    director: m.stat_gov?.director ?? m.registry?.director_name ?? "",
    oked: m.stat_gov?.oked ?? "",
    oked_name: m.stat_gov?.oked_name ?? "",
    registration_date: m.stat_gov?.registration_date ?? m.registry?.registration_date ?? "",
    legal_status: m.stat_gov?.legal_status ?? "",
    company_age_years: "",
    crm_status: "",
    lead_score: "",
    source: m.source,
    external_id: m.external_id
  }));

  sheet.addRows(rows);
  styleSheet(sheet);

  for (const key of ["tender_budget_sum", "tender_active_budget_sum"] as const) {
    const col = LEAD_COLUMNS.findIndex((c) => c.key === key) + 1;
    if (col > 0) sheet.getColumn(col).numFmt = "#,##0.00";
  }
}

function addTendersSheet(workbook: ExcelJS.Workbook, tenders: TenderRecord[], matches: LeadKzMatch[]): void {
  const sheet = workbook.addWorksheet("Tenders");
  const companyNames = new Map(matches.map((m) => [m.kz_bin, m.company_name]));

  sheet.columns = [
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

  sheet.addRows(tenders.map((t) => ({
    ...t,
    company_name: companyNames.get(t.bin) ?? t.customer_name ?? ""
  })));
  styleSheet(sheet);

  const budgetCol = 7;
  sheet.getColumn(budgetCol).numFmt = "#,##0.00";
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  matches: LeadKzMatch[],
  tenders: TenderRecord[],
  mergeStats: LeadKzMergeStats
): void {
  const sheet = workbook.addWorksheet("Summary");
  sheet.columns = [
    { header: "Метрика", key: "metric", width: 42 },
    { header: "Значение", key: "value", width: 24 }
  ];

  const withTenders = matches.filter((m) => m.company_card && m.company_card.tender_count_total > 0).length;
  const priorityA = matches.filter((m) => m.company_card?.lead_priority === "A").length;
  const highVolume = matches.filter((m) => m.company_card?.high_volume).length;
  const statMissing = matches.filter((m) => isStatGovMissingForCard({
    participant_id: m.registry?.participant_id,
    registry_phone: m.registry?.phone,
    oked: m.stat_gov?.oked
  })).length;
  const totalBudget = matches.reduce((sum, m) => sum + (m.company_card?.tender_budget_sum ?? 0), 0);
  const activeBudget = matches.reduce((sum, m) => sum + (m.company_card?.tender_active_budget_sum ?? 0), 0);

  sheet.addRows([
    { metric: "Лидов всего", value: matches.length },
    { metric: "Лидов с БИН", value: mergeStats.with_bin },
    { metric: "% лидов с БИН", value: matches.length > 0 ? pct(mergeStats.with_bin, matches.length) : "0%" },
    { metric: "Совпало по БИН (exact)", value: mergeStats.matched_exact },
    { metric: "Совпало по имени (stat)", value: mergeStats.matched_fuzzy_stat },
    { metric: "Совпало по имени (registry)", value: mergeStats.matched_fuzzy_registry },
    { metric: "Не совпало", value: mergeStats.unmatched },
    { metric: "Лидов с закупками", value: withTenders },
    { metric: "% лидов с закупками", value: matches.length > 0 ? pct(withTenders, matches.length) : "0%" },
    { metric: "Закупок всего", value: tenders.length },
    { metric: "Сумма бюджетов", value: totalBudget },
    { metric: "Сумма активных бюджетов", value: activeBudget },
    { metric: "Приоритет A", value: priorityA },
    { metric: "High volume", value: highVolume },
    { metric: "Stat missing (registry без stat)", value: statMissing }
  ]);

  sheet.addRow({});
  sheet.addRow({ metric: "По источникам закупок" });
  const sourceCounts = countBy(tenders, (t) => t.source);
  for (const [source, count] of sourceCounts) {
    sheet.addRow({ metric: source, value: count });
  }

  sheet.addRow({});
  sheet.addRow({ metric: "По статусам закупок" });
  const statusCounts = countBy(tenders, (t) => t.status ?? "unknown");
  for (const [status, count] of statusCounts) {
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

function pct(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function defaultOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join("exports", `unified-${stamp}.xlsx`);
}
