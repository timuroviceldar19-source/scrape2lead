import fs from "node:fs";
import path from "node:path";
import { createObjectCsvWriter } from "csv-writer";
import ExcelJS from "exceljs";
import type { Lead } from "../types.js";

const exportColumns = [
  "priority",
  "crm_status",
  "lead_score",
  "confidence_score",
  "company_name",
  "found_name",
  "found_category",
  "category",
  "source_search_city",
  "phone_normalized",
  "phone_status",
  "phone_raw",
  "address_clean",
  "address_status",
  "address_raw",
  "real_website",
  "website_status",
  "email_raw",
  "email_status",
  "rating",
  "review_count",
  "product_count",
  "enrichment_status",
  "enrichment_source",
  "enrichment_url",
  "enrichment_attempted_at",
  "enrichment_error",
  "next_action",
  "contactability",
  "kaspi_profile_url",
  "messenger_flags",
  "parser_note",
  "source",
  "external_id",
  "parsed_at",
  "incomplete"
] as const;

const ruHeaders: Record<string, string> = {
  priority: "Приоритет",
  crm_status: "CRM-статус",
  lead_score: "Оценка лида",
  confidence_score: "Уверенность совпадения",
  company_name: "Компания",
  found_name: "Найденное название",
  found_category: "Найденная категория",
  category: "Категория",
  source_search_city: "Город",
  phone_normalized: "Телефон",
  phone_status: "Статус телефона",
  phone_raw: "Телефон (исходный)",
  address_clean: "Адрес",
  address_status: "Статус адреса",
  address_raw: "Адрес (исходный)",
  real_website: "Сайт",
  website_status: "Статус сайта",
  email_raw: "Email",
  email_status: "Статус email",
  rating: "Рейтинг",
  review_count: "Количество отзывов",
  product_count: "Количество товаров",
  enrichment_status: "Статус дообогащения",
  enrichment_source: "Источник дообогащения",
  enrichment_url: "Ссылка на источник",
  enrichment_attempted_at: "Дата попытки дообогащения",
  enrichment_error: "Ошибка дообогащения",
  next_action: "Следующее действие",
  contactability: "Контактность",
  kaspi_profile_url: "Ссылка на Kaspi",
  messenger_flags: "Мессенджеры",
  parser_note: "Примечание парсера",
  source: "Источник",
  external_id: "Внешний ID",
  parsed_at: "Дата парсинга",
  incomplete: "Неполные данные"
};

function sortLeads(leads: Lead[]): Lead[] {
  const priorityOrder: Record<string, number> = { "A": 1, "B": 2, "C": 3, "D": 4 };
  const crmStatusOrder: Record<string, number> = {
    "Ready to contact": 1,
    "Needs manual review": 2,
    "Needs enrichment": 3,
    "Not enough data": 4
  };

  return [...leads].sort((a, b) => {
    const pA = priorityOrder[a.priority ?? ""] ?? 5;
    const pB = priorityOrder[b.priority ?? ""] ?? 5;
    if (pA !== pB) return pA - pB;

    const cA = crmStatusOrder[a.crm_status ?? ""] ?? 5;
    const cB = crmStatusOrder[b.crm_status ?? ""] ?? 5;
    if (cA !== cB) return cA - cB;

    const sA = a.lead_score ?? -1;
    const sB = b.lead_score ?? -1;
    if (sA !== sB) return sB - sA;

    const rA = a.review_count ?? -1;
    const rB = b.review_count ?? -1;
    if (rA !== rB) return rB - rA;

    const pA_count = a.product_count ?? -1;
    const pB_count = b.product_count ?? -1;
    if (pA_count !== pB_count) return pB_count - pA_count;

    return 0;
  });
}

function flattenLead(lead: Lead): Record<string, string | boolean | number | undefined> {
  return {
    priority: lead.priority ?? "",
    crm_status: lead.crm_status ?? "",
    lead_score: lead.lead_score ?? "",
    confidence_score: lead.confidence_score ?? "",
    company_name: lead.company_name,
    found_name: lead.found_name ?? "",
    found_category: lead.found_category ?? "",
    category: lead.category,
    source_search_city: lead.source_search_city ?? "",
    phone_normalized: lead.phone_normalized ?? "",
    phone_status: lead.phone_status ?? "",
    phone_raw: lead.phone_raw ?? "",
    address_clean: lead.address_clean ?? "",
    address_status: lead.address_status ?? "",
    address_raw: lead.address_raw ?? "",
    real_website: lead.real_website ?? "",
    website_status: lead.website_status ?? "",
    email_raw: lead.email_raw ?? lead.email ?? "",
    email_status: lead.email_status ?? "",
    rating: lead.rating ?? "",
    review_count: lead.review_count ?? "",
    product_count: lead.product_count ?? "",
    enrichment_status: lead.enrichment_status ?? "",
    enrichment_source: lead.enrichment_source ?? "",
    enrichment_url: lead.enrichment_url ?? "",
    enrichment_attempted_at: lead.enrichment_attempted_at ?? "",
    enrichment_error: lead.enrichment_error ?? "",
    next_action: lead.next_action ?? "",
    contactability: lead.contactability ?? "",
    kaspi_profile_url: lead.kaspi_profile_url ?? "",
    messenger_flags: lead.messenger_flags ?? "",
    parser_note: lead.parser_note ?? "",
    source: lead.source,
    external_id: lead.external_id,
    parsed_at: lead.parsed_at,
    incomplete: lead.incomplete
  };
}

function getColRef(sheet: ExcelJS.Worksheet, key: string, rowCount: number): string | null {
  const index = sheet.columns.findIndex(c => c.key === key);
  if (index === -1) return null;
  const colNum = index + 1;
  let letters = "";
  let temp = colNum;
  while (temp > 0) {
    const remainder = (temp - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    temp = Math.floor((temp - 1) / 26);
  }
  return `${letters}2:${letters}${rowCount + 1}`;
}

async function generateXlsx(leads: Lead[], xlsxPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sortedLeads = sortLeads(leads);

  const sheetsConfig = [
    { name: "Все лиды", filter: () => true },
    { name: "Готовы к контакту", filter: (l: Lead) => l.crm_status === "Ready to contact" },
    { name: "Нужно проверить вручную", filter: (l: Lead) => l.crm_status === "Needs manual review" },
    { name: "Нужно дообогатить", filter: (l: Lead) => l.crm_status === "Needs enrichment" },
    { name: "Ошибки enrichment", filter: (l: Lead) => l.enrichment_status === "failed" || !!l.enrichment_error }
  ];

  for (const config of sheetsConfig) {
    const sheetLeads = sortedLeads.filter(config.filter);
    const sheetRows = sheetLeads.map(flattenLead);
    
    const sheet = workbook.addWorksheet(config.name);
    sheet.columns = exportColumns.map(col => ({
      header: ruHeaders[col] || col,
      key: col,
      width: Math.max(16, (ruHeaders[col] || col).length + 2)
    }));
    
    const actualRowCount = Math.max(1, sheetRows.length);
    if (sheetRows.length > 0) {
      sheet.addRows(sheetRows);
    } else {
      sheet.addRow({});
    }

    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: exportColumns.length } };

    const crmRef = getColRef(sheet, "crm_status", actualRowCount);
    if (crmRef) {
      sheet.addConditionalFormatting({
        ref: crmRef,
        rules: [
          { type: 'cellIs', operator: 'equal', formulae: ['"Ready to contact"'], priority: 1, style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } } } },
          { type: 'cellIs', operator: 'equal', formulae: ['"Needs manual review"'], priority: 2, style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } } } },
          { type: 'cellIs', operator: 'equal', formulae: ['"Needs enrichment"'], priority: 3, style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } } } },
          { type: 'cellIs', operator: 'equal', formulae: ['"Not enough data"', '"failed"'], priority: 4, style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2DCDB' } } } }
        ]
      });
    }

    const priRef = getColRef(sheet, "priority", actualRowCount);
    if (priRef) {
      sheet.addConditionalFormatting({
        ref: priRef,
        rules: [
          { type: 'cellIs', operator: 'equal', formulae: ['"A"'], priority: 1, style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } } } },
          { type: 'cellIs', operator: 'equal', formulae: ['"B"'], priority: 2, style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } } } },
          { type: 'cellIs', operator: 'equal', formulae: ['"C"', '"D"'], priority: 3, style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } } } }
        ]
      });
    }
  }

  const dictSheet = workbook.addWorksheet("Справочник полей");
  dictSheet.columns = [
    { header: "Поле", key: "field", width: 30 },
    { header: "Описание", key: "description", width: 80 }
  ];
  dictSheet.getRow(1).font = { bold: true };
  dictSheet.addRows([
    { field: "Количество товаров", description: "Общее число товарных позиций/карточек, которые продавец выставил на Kaspi." },
    { field: "10 000+ товаров", description: "Крупный сетевик или очень крупный продавец." },
    { field: "3 000–9 999", description: "Крупный продавец." },
    { field: "1 000–2 999", description: "Средний развитый продавец." },
    { field: "100–999", description: "Малый/средний продавец." },
    { field: "<100", description: "Нишевый или малый продавец." },
    { field: "confidence_score", description: "Оценка уверенности совпадения компании (0.0 - 1.0)." },
    { field: "lead_score", description: "Комплексная оценка качества лида." },
    { field: "priority", description: "Приоритет обработки: A (высокий), B (средний), C/D (низкий)." },
    { field: "crm_status", description: "Текущий статус лида в CRM-процессе." },
    { field: "enrichment_status", description: "Статус процесса дообогащения (enriched, manual_review, not_found, failed)." },
    { field: "phone_status", description: "Статус валидации телефона (valid, invalid, empty)." },
    { field: "website_status", description: "Статус валидации сайта (valid, invalid, empty)." },
    { field: "address_status", description: "Статус валидации адреса (valid, invalid, empty)." }
  ]);

  await workbook.xlsx.writeFile(xlsxPath);
}

async function generateCsv(leads: Lead[], csvPath: string): Promise<void> {
  const sortedLeads = sortLeads(leads);
  const rows = sortedLeads.map(flattenLead);

  await createObjectCsvWriter({
    path: csvPath,
    header: exportColumns.map((id) => ({ id, title: id }))
  }).writeRecords(rows);
}

export async function exportLeads(leads: Lead[], exportDir: string): Promise<{ csvPath: string; xlsxPath: string }> {
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = path.join(exportDir, `leads-${stamp}.csv`);
  const xlsxPath = path.join(exportDir, `leads-${stamp}.xlsx`);

  await Promise.all([
    generateCsv(leads, csvPath),
    generateXlsx(leads, xlsxPath)
  ]);

  return { csvPath, xlsxPath };
}
