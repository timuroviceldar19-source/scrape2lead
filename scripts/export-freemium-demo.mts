/**
 * Демо Excel для подписчиков канала (50–100 строк, маскированные контакты).
 * Мини-выборка за вовлечение: --mini (15 строк).
 */
import Database from "better-sqlite3";
import path from "node:path";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { exportFreemiumDemo } from "../src/kz/freemiumDemoExport.js";
import { parseAmount, type OutreachWinner } from "../src/kz/outreachDigest.js";
import { KzStorage } from "../src/kz/kzStorage.js";
import { scoreCompanyCards } from "../src/kz/kzLeadScore.js";

const DB_PATH = process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1] ?? null;
}

function collectBins(): string[] {
  const bins = new Set<string>();
  for (const csvPath of ["bins-batch.csv", "bins-top-a.csv"]) {
    try {
      for (const bin of readBinsFromCsv(csvPath)) bins.add(bin);
    } catch {
      console.warn(`freemium-demo: пропускаю ${csvPath}`);
    }
  }
  return [...bins];
}

function loadRecentWinners(db: Database.Database, bins: string[], limit: number): OutreachWinner[] {
  if (bins.length === 0) return [];

  const placeholders = bins.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT bin, tender_number, tender_name, customer_name, budget_amount, start_date, status, url, parsed_at
       FROM tender_data
       WHERE source LIKE '%goszakup%' AND bin IN (${placeholders})
       ORDER BY parsed_at DESC
       LIMIT ?`
    )
    .all(...bins, limit * 3) as Array<{
    bin: string;
    tender_number: string;
    tender_name: string;
    customer_name: string | null;
    budget_amount: string | null;
    start_date: string | null;
    status: string | null;
    url: string | null;
  }>;

  const storage = new KzStorage({ db });
  const uniqueBins = [...new Set(rows.map((r) => r.bin))];
  const cards = scoreCompanyCards(storage.getCompanyCards(uniqueBins));
  const byBin = new Map(cards.map((c) => [c.bin, c]));

  const winners: OutreachWinner[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.bin}:${row.tender_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const card = byBin.get(row.bin);
    winners.push({
      bin: row.bin,
      company_name: card?.name ?? row.bin,
      director: card?.director ?? null,
      phone: card?.registry_phone ?? null,
      email: card?.registry_email ?? null,
      gis_phone: "",
      contract_number: row.tender_number,
      contract_name: row.tender_name,
      customer_name: row.customer_name,
      amount: parseAmount(row.budget_amount),
      amount_raw: row.budget_amount,
      contract_date: row.start_date,
      status: row.status,
      url: row.url
    });
    if (winners.length >= limit) break;
  }

  winners.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  return winners;
}

async function main(): Promise<void> {
  const isMini = process.argv.includes("--mini");
  const defaultRows = isMini
    ? Number(process.env.FREEMIUM_MINI_ROWS ?? 15)
    : Number(process.env.FREEMIUM_DEMO_ROWS ?? 50);
  const rowsArg = readArg("--rows");
  const maxRows = rowsArg ? Math.min(Number(rowsArg), 100) : defaultRows;

  if (!Number.isFinite(maxRows) || maxRows < 1) {
    throw new Error("Некорректное число строк (--rows или FREEMIUM_DEMO_ROWS)");
  }

  const bins = collectBins();
  const db = new Database(DB_PATH);
  try {
    const winners = loadRecentWinners(db, bins, maxRows);
    if (winners.length === 0) {
      throw new Error("Нет данных для демо — проверьте БИНы и tender_data");
    }

    const date = new Date().toISOString().slice(0, 10);
    const prefix = isMini ? "freemium-mini" : "freemium-demo";
    const outPath = path.join("exports", `${prefix}-${date}.xlsx`);
    const result = await exportFreemiumDemo(winners, outPath, maxRows);

    console.log(
      `${prefix}: ${result.rows} строк → ${result.xlsxPath} (${result.maskedPhones} с замаскированным телефоном)`
    );
    console.log("Выдавать подписчикам канала в личку — не публиковать файл в открытую ленту.");
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
