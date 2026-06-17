import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { OutreachProspect, OutreachWinner } from "./outreachDigest.js";
import {
  buildFirstTouchMessage,
  buildFollowUpMessage,
  buildWaLink,
  type ListStats
} from "./outreachMessages.js";

export interface WinnersExportResult {
  xlsxPath: string;
  winners: number;
  withPhone: number;
}

export interface QueueExportResult {
  xlsxPath: string;
  companies: number;
  withPhone: number;
  stats: ListStats;
}

const WINNER_COLUMNS = [
  { header: "№", key: "rank", width: 6 },
  { header: "БИН", key: "bin", width: 16 },
  { header: "Компания", key: "company_name", width: 46 },
  { header: "Договор №", key: "contract_number", width: 24 },
  { header: "Предмет", key: "contract_name", width: 46 },
  { header: "Заказчик", key: "customer_name", width: 40 },
  { header: "Сумма, ₸", key: "amount", width: 18 },
  { header: "Дата", key: "contract_date", width: 14 },
  { header: "Статус контракта", key: "status", width: 18 },
  { header: "CRM-статус", key: "crm_status", width: 16 },
  { header: "CRM-заметка", key: "crm_note", width: 30 },
  { header: "Телефон", key: "phone", width: 22 },
  { header: "Email", key: "email", width: 28 },
  { header: "Телефон (2GIS)", key: "gis_phone", width: 22 },
  { header: "Директор", key: "director", width: 32 },
  { header: "Ссылка", key: "url", width: 40 }
];

const QUEUE_COLUMNS = [
  { header: "№", key: "rank", width: 6 },
  { header: "БИН", key: "bin", width: 16 },
  { header: "Компания", key: "name", width: 46 },
  { header: "Новые активные закупки", key: "new_tender_count", width: 22 },
  { header: "Активные закупки", key: "tender_count_active", width: 18 },
  { header: "Сумма активных, ₸", key: "tender_active_budget_sum", width: 20 },
  { header: "Всего закупок", key: "tender_count_total", width: 16 },
  { header: "Телефон (registry)", key: "registry_phone", width: 22 },
  { header: "Email", key: "registry_email", width: 28 },
  { header: "Сайт", key: "registry_website", width: 28 },
  { header: "Директор", key: "director", width: 32 },
  { header: "Телефон (2GIS)", key: "gis_phone", width: 22 },
  { header: "Сообщение: первое касание", key: "message_first_touch", width: 60 },
  { header: "Сообщение: фоллоу-ап", key: "message_followup", width: 60 },
  { header: "WhatsApp", key: "wa_link", width: 40 },
  { header: "CRM-статус", key: "crm_status", width: 16 },
  { header: "CRM-заметка", key: "crm_note", width: 30 }
];

export async function exportWinnersDigest(
  winners: OutreachWinner[],
  outPath: string
): Promise<WinnersExportResult> {
  const workbook = createWorkbook();
  const sheet = workbook.addWorksheet("Winners");
  sheet.columns = WINNER_COLUMNS;

  const rows = winners.map((winner, index) => ({
    rank: index + 1,
    bin: winner.bin,
    company_name: winner.company_name,
    contract_number: winner.contract_number,
    contract_name: winner.contract_name,
    customer_name: winner.customer_name ?? "",
    amount: winner.amount,
    contract_date: winner.contract_date ?? "",
    status: winner.status ?? "",
    crm_status: winner.crm_status,
    crm_note: winner.crm_note ?? "",
    phone: winner.phone ?? "",
    email: winner.email ?? "",
    gis_phone: winner.gis_phone,
    director: winner.director ?? "",
    url: winner.url ?? ""
  }));

  sheet.addRows(rows);
  styleSheet(sheet);
  sheet.getColumn("amount").numFmt = "#,##0.00";

  await writeWorkbook(workbook, outPath);

  return {
    xlsxPath: outPath,
    winners: rows.length,
    withPhone: rows.filter((row) => row.phone.trim() || row.gis_phone.trim()).length
  };
}

export async function exportOutreachQueue(
  prospects: OutreachProspect[],
  outPath: string
): Promise<QueueExportResult> {
  const stats = computeListStats(prospects);
  const firstTouch = buildFirstTouchMessage(stats);
  const followUp = buildFollowUpMessage(stats);

  const workbook = createWorkbook();
  const sheet = workbook.addWorksheet("Outreach Queue");
  sheet.columns = QUEUE_COLUMNS;

  const rows = prospects.map((prospect, index) => {
    const card = prospect.card;
    const phone = card.registry_phone?.trim() || prospect.gis_phone;
    return {
      rank: index + 1,
      bin: card.bin,
      name: card.name,
      new_tender_count: prospect.new_active_tenders.length,
      tender_count_active: card.tender_count_active,
      tender_active_budget_sum: card.tender_active_budget_sum,
      tender_count_total: card.tender_count_total,
      registry_phone: card.registry_phone ?? "",
      registry_email: card.registry_email ?? "",
      registry_website: card.registry_website ?? "",
      director: card.director ?? "",
      gis_phone: prospect.gis_phone,
      message_first_touch: firstTouch,
      message_followup: followUp,
      wa_link: buildWaLink(phone, firstTouch) ?? "",
      crm_status: prospect.crm_status,
      crm_note: prospect.crm_note ?? ""
    };
  });

  sheet.addRows(rows);
  styleSheet(sheet);
  sheet.getColumn("tender_active_budget_sum").numFmt = "#,##0.00";

  await writeWorkbook(workbook, outPath);

  return {
    xlsxPath: outPath,
    companies: rows.length,
    withPhone: rows.filter((row) => row.registry_phone.trim() || row.gis_phone.trim()).length,
    stats
  };
}

export function computeListStats(prospects: OutreachProspect[]): ListStats {
  const budgets = prospects.map((prospect) => prospect.card.tender_active_budget_sum ?? 0);
  return {
    companyCount: prospects.length,
    totalActiveBudget: budgets.reduce((sum, value) => sum + value, 0),
    withPhoneCount: prospects.filter(
      (prospect) => prospect.card.registry_phone?.trim() || prospect.gis_phone.trim()
    ).length,
    topContractBudget: budgets.length > 0 ? Math.max(...budgets) : 0
  };
}

function createWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Scrape2Lead";
  workbook.created = new Date();
  return workbook;
}

async function writeWorkbook(workbook: ExcelJS.Workbook, outPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);
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
