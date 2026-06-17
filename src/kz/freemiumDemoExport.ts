import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { OutreachWinner } from "./outreachDigest.js";

export interface FreemiumDemoExportResult {
  xlsxPath: string;
  rows: number;
  maskedPhones: number;
}

const DEMO_COLUMNS = [
  { header: "№", key: "rank", width: 6 },
  { header: "БИН", key: "bin", width: 16 },
  { header: "Компания", key: "company_name", width: 40 },
  { header: "Предмет", key: "contract_name", width: 44 },
  { header: "Заказчик", key: "customer_name", width: 36 },
  { header: "Сумма, ₸", key: "amount", width: 16 },
  { header: "Телефон (демо)", key: "phone_masked", width: 22 },
  { header: "Email (демо)", key: "email_masked", width: 26 },
  { header: "Директор (демо)", key: "director_masked", width: 24 },
  { header: "Источник", key: "url", width: 42 },
  { header: "Примечание", key: "note", width: 36 }
] as const;

const DEMO_NOTE = "Демо — полные контакты в платном пакете. Не для перепродажи.";

/** +77009781336 → +7 (700) XXX-XX-36 */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 10) return "—";
  const normalized = digits.startsWith("7") ? digits : `7${digits}`;
  const last2 = normalized.slice(-2);
  const op = normalized.slice(1, 4);
  return `+7 (${op}) XXX-XX-${last2}`;
}

/** user@domain.com → u***@domain.com */
export function maskEmail(email: string | null | undefined): string {
  const raw = email?.trim();
  if (!raw || !raw.includes("@")) return "—";
  const [local, domain] = raw.split("@");
  if (!local || !domain) return "—";
  const head = local.charAt(0);
  return `${head}***@${domain}`;
}

/** ЖЕКСЕНБЕКОВ АСХАТ → Ж*** А*** */
export function maskDirector(name: string | null | undefined): string {
  const raw = name?.trim();
  if (!raw) return "—";
  return raw
    .split(/\s+/)
    .map((part) => (part.length <= 1 ? part : `${part.charAt(0)}***`))
    .join(" ");
}

export async function exportFreemiumDemo(
  winners: OutreachWinner[],
  outPath: string,
  maxRows = 50
): Promise<FreemiumDemoExportResult> {
  const slice = winners.slice(0, Math.min(maxRows, 100));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI Leads KZ";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Demo");
  sheet.columns = [...DEMO_COLUMNS];

  const rows = slice.map((winner, index) => ({
    rank: index + 1,
    bin: winner.bin,
    company_name: winner.company_name,
    contract_name: winner.contract_name,
    customer_name: winner.customer_name ?? "",
    amount: winner.amount,
    phone_masked: maskPhone(winner.phone ?? winner.gis_phone),
    email_masked: maskEmail(winner.email),
    director_masked: maskDirector(winner.director),
    url: winner.url ?? "",
    note: DEMO_NOTE
  }));

  sheet.addRows(rows);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  sheet.getColumn("amount").numFmt = "#,##0.00";

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);

  return {
    xlsxPath: outPath,
    rows: rows.length,
    maskedPhones: rows.filter((r) => r.phone_masked !== "—").length
  };
}
