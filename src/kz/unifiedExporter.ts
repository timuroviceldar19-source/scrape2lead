import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { dedupeEnrichErrors, isStatGovMissingForCard } from "./enrichErrors.js";
import { enrichMissingLeadBins } from "./enrichMissing.js";
import { scoreCompanyCards } from "./kzLeadScore.js";
import { KzStorage } from "./kzStorage.js";
import { formatLeadAddress, formatLeadPhone, mergeLeadsWithKz, type LeadKzMatch, type LeadKzMergeStats } from "./leadKzMerge.js";
import type { EnrichError, TenderRecord } from "./tenderTypes.js";
import type { ScoredCompanyCard } from "./kzLeadScore.js";

export interface UnifiedExportOptions {
  databasePath?: string;
  outPath?: string;
  priority?: string;
  bins?: string[];
  enrichMissing?: boolean;
}

export interface UnifiedExportResult {
  xlsxPath: string;
  leads: number;
  kzOnly: number;
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

const KZ_ONLY_COLUMNS = [
  { header: "Приоритет KZ", key: "lead_priority", width: 14 },
  { header: "High volume", key: "high_volume", width: 14 },
  { header: "Stat missing", key: "stat_missing", width: 14 },
  { header: "БИН", key: "bin", width: 16 },
  { header: "Компания (KZ)", key: "name", width: 46 },
  { header: "Всего закупок", key: "tender_count_total", width: 16 },
  { header: "Активные закупки", key: "tender_count_active", width: 18 },
  { header: "Сумма закупок", key: "tender_budget_sum", width: 18 },
  { header: "Сумма активных", key: "tender_active_budget_sum", width: 18 },
  { header: "Телефон (registry)", key: "registry_phone", width: 22 },
  { header: "Email (registry)", key: "registry_email", width: 28 },
  { header: "Сайт (registry)", key: "registry_website", width: 28 },
  { header: "Адрес (stat)", key: "address", width: 46 },
  { header: "Директор", key: "director", width: 32 },
  { header: "ОКЭД", key: "oked", width: 12 },
  { header: "ОКЭД название", key: "oked_name", width: 46 },
  { header: "Дата регистрации", key: "registration_date", width: 18 },
  { header: "Статус юрлица", key: "legal_status", width: 18 },
  { header: "№ участника goszakup", key: "participant_id", width: 22 },
  { header: "2GIS match", key: "has_2gis", width: 12 },
  { header: "2GIS компании", key: "gis_company_names", width: 42 },
  { header: "Match type", key: "match_type", width: 20 },
  { header: "Match score", key: "match_score", width: 12 },
  { header: "Телефон (2GIS)", key: "gis_phone", width: 22 },
  { header: "Адрес (2GIS)", key: "gis_address", width: 46 }
];

export async function exportUnifiedReport(options: UnifiedExportOptions = {}): Promise<UnifiedExportResult> {
  const dbPath = options.databasePath ?? "data/scrape2lead.db";

  if (options.enrichMissing) {
    const enrich = await enrichMissingLeadBins({
      databasePath: dbPath,
      cardBins: options.bins
    });
    console.log(
      `enrich-missing done: lead_bins=${enrich.leadBins} missing=${enrich.missingBins.length} enriched=${enrich.enrichedBins} merge=${enrich.mergeStatMatched} writeKz=${enrich.writeKzToLeads}`
    );
  }

  const db = new Database(dbPath);
  const kzStorage = new KzStorage({ db });

  try {
    const cards = scoreCompanyCards(kzStorage.getCompanyCards(options.bins));
    const { matches, stats } = mergeLeadsWithKz(db, cards);

    const filteredMatches = options.priority
      ? matches.filter((m) => m.company_card?.lead_priority === options.priority)
      : matches;

    const kzOnlyCards = selectKzOnlyCards(cards, options.priority, options.bins);
    const matchesByKzBin = groupMatchesByKzBin(matches);

    const leadBins = new Set(filteredMatches.map((m) => m.kz_bin).filter(Boolean) as string[]);
    for (const card of kzOnlyCards) leadBins.add(card.bin);

    const tenders = kzStorage.getTendersByBins(Array.from(leadBins));
    const errors = dedupeEnrichErrors(kzStorage.getEnrichErrors(), Array.from(leadBins));

    const xlsxPath = options.outPath ?? defaultOutputPath();
    fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Scrape2Lead";
    workbook.created = new Date();

    if (kzOnlyCards.length > 0) {
      addKzOnlySheet(workbook, kzOnlyCards, matchesByKzBin);
    }
    addLeadsSheet(workbook, filteredMatches);
    addTendersSheet(workbook, tenders, filteredMatches, kzOnlyCards);
    addSummarySheet(workbook, filteredMatches, tenders, stats, kzOnlyCards, matchesByKzBin);
    addErrorsSheet(workbook, errors);

    await workbook.xlsx.writeFile(xlsxPath);

    return {
      xlsxPath,
      leads: filteredMatches.length,
      kzOnly: kzOnlyCards.length,
      tenders: tenders.length,
      errors: errors.length,
      mergeStats: stats
    };
  } finally {
    kzStorage.close();
  }
}

export function selectKzOnlyCards(
  cards: ScoredCompanyCard[],
  priority?: string,
  bins?: string[]
): ScoredCompanyCard[] {
  let selected = cards;
  if (bins?.length) {
    const binSet = new Set(bins);
    selected = selected.filter((card) => binSet.has(card.bin));
  }
  if (priority) {
    selected = selected.filter((card) => card.lead_priority === priority);
  }
  return [...selected].sort(
    (a, b) => (b.tender_active_budget_sum ?? 0) - (a.tender_active_budget_sum ?? 0)
  );
}

export function groupMatchesByKzBin(matches: LeadKzMatch[]): Map<string, LeadKzMatch[]> {
  const grouped = new Map<string, LeadKzMatch[]>();
  for (const match of matches) {
    if (!match.kz_bin || match.match_type === "none") continue;
    const list = grouped.get(match.kz_bin) ?? [];
    list.push(match);
    grouped.set(match.kz_bin, list);
  }
  return grouped;
}

function addKzOnlySheet(
  workbook: ExcelJS.Workbook,
  cards: ScoredCompanyCard[],
  matchesByKzBin: Map<string, LeadKzMatch[]>
): void {
  const sheet = workbook.addWorksheet("KZ-only");
  sheet.columns = KZ_ONLY_COLUMNS;

  const rows = cards.map((card) => {
    const gisMatches = matchesByKzBin.get(card.bin) ?? [];
    const best = gisMatches.reduce<LeadKzMatch | null>(
      (current, candidate) => (!current || candidate.match_score > current.match_score ? candidate : current),
      null
    );
    const gisNames = [...new Set(gisMatches.map((m) => m.company_name))];
    const gisPhone = gisMatches.map((m) => formatLeadPhone(m)).filter(Boolean).join("; ");
    const gisAddress = gisMatches.map((m) => formatLeadAddress(m)).filter(Boolean).join("; ");

    return {
      lead_priority: card.lead_priority,
      high_volume: card.high_volume,
      stat_missing: card.stat_missing,
      bin: card.bin,
      name: card.name,
      tender_count_total: card.tender_count_total,
      tender_count_active: card.tender_count_active,
      tender_budget_sum: card.tender_budget_sum,
      tender_active_budget_sum: card.tender_active_budget_sum,
      registry_phone: card.registry_phone ?? "",
      registry_email: card.registry_email ?? "",
      registry_website: card.registry_website ?? "",
      address: card.address ?? "",
      director: card.director ?? "",
      oked: card.oked ?? "",
      oked_name: card.oked_name ?? "",
      registration_date: card.registration_date ?? "",
      legal_status: card.legal_status ?? "",
      participant_id: card.participant_id ?? "",
      has_2gis: gisMatches.length > 0,
      gis_company_names: gisNames.join("; "),
      match_type: best?.match_type ?? "",
      match_score: best && best.match_score > 0 ? best.match_score.toFixed(2) : "",
      gis_phone: gisPhone,
      gis_address: gisAddress
    };
  });

  sheet.addRows(rows);
  styleSheet(sheet);

  for (const key of ["tender_budget_sum", "tender_active_budget_sum"] as const) {
    const col = KZ_ONLY_COLUMNS.findIndex((c) => c.key === key) + 1;
    if (col > 0) sheet.getColumn(col).numFmt = "#,##0.00";
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
    phone: formatLeadPhone(m),
    registry_phone: m.registry?.phone ?? "",
    registry_email: m.registry?.email ?? "",
    registry_website: m.registry?.website ?? "",
    address: formatLeadAddress(m),
    stat_address: m.stat_gov?.address ?? "",
    director: m.stat_gov?.director ?? m.registry?.director_name ?? "",
    oked: m.stat_gov?.oked ?? "",
    oked_name: m.stat_gov?.oked_name ?? "",
    registration_date: m.stat_gov?.registration_date ?? m.registry?.registration_date ?? m.registration_date ?? "",
    legal_status: m.stat_gov?.legal_status ?? "",
    company_age_years: m.company_age_years ?? "",
    crm_status: m.crm_status ?? "",
    lead_score: m.lead_score ?? "",
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

function addTendersSheet(
  workbook: ExcelJS.Workbook,
  tenders: TenderRecord[],
  matches: LeadKzMatch[],
  kzOnlyCards: ScoredCompanyCard[] = []
): void {
  const sheet = workbook.addWorksheet("Tenders");
  const companyNames = new Map(matches.map((m) => [m.kz_bin, m.company_name]));
  for (const card of kzOnlyCards) {
    if (!companyNames.has(card.bin)) companyNames.set(card.bin, card.name);
  }

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
  mergeStats: LeadKzMergeStats,
  kzOnlyCards: ScoredCompanyCard[] = [],
  matchesByKzBin: Map<string, LeadKzMatch[]> = new Map()
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
  const withPhone = matches.filter((m) => formatLeadPhone(m).length > 0).length;
  const kzWith2gis = kzOnlyCards.filter((card) => (matchesByKzBin.get(card.bin)?.length ?? 0) > 0).length;
  const totalBudget = matches.reduce((sum, m) => sum + (m.company_card?.tender_budget_sum ?? 0), 0);
  const activeBudget = matches.reduce((sum, m) => sum + (m.company_card?.tender_active_budget_sum ?? 0), 0);

  sheet.addRows([
    { metric: "KZ-only компаний (лист KZ-only)", value: kzOnlyCards.length },
    { metric: "KZ-only с 2GIS match", value: kzWith2gis },
    { metric: "% KZ-only с 2GIS", value: kzOnlyCards.length > 0 ? pct(kzWith2gis, kzOnlyCards.length) : "0%" },
    { metric: "Лидов всего (лист Leads)", value: matches.length },
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
    { metric: "Stat missing (registry без stat)", value: statMissing },
    { metric: "Лидов с телефоном (2GIS)", value: withPhone },
    { metric: "% лидов с телефоном (2GIS)", value: matches.length > 0 ? pct(withPhone, matches.length) : "0%" }
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
