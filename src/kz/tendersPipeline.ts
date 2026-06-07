import Database from "better-sqlite3";
import { runMigrations } from "../storage/migrations.js";
import { isValidBin, sleep } from "./csv.js";
import { fetchGoszakupTenders, isGoszakupAvailable } from "./goszakupCollector.js";
import { collectZakupTendersForBatch } from "./zakupCollector.js";
import type { TenderRecord } from "./tenderTypes.js";

export interface TendersPipelineOptions {
  databasePath?: string;
  delayMs?: number;
  headless?: boolean;
  skipZakup?: boolean;
  skipGoszakup?: boolean;
}

export interface TenderCollectStats {
  processed: number;
  skipped: number;
  zakupCount: number;
  goszakupCount: number;
  totalTenders: number;
}

const DEFAULT_DB_PATH = "data/scrape2lead.db";

export async function collectTendersForBins(
  bins: string[],
  options: TendersPipelineOptions = {}
): Promise<TenderCollectStats> {
  const db = new Database(options.databasePath ?? DEFAULT_DB_PATH);
  runMigrations(db);
  const upsert = prepareTenderUpsert(db);
  const validBins = Array.from(new Set(bins.filter(isValidBin)));
  const stats: TenderCollectStats = {
    processed: validBins.length,
    skipped: bins.length - validBins.length,
    zakupCount: 0,
    goszakupCount: 0,
    totalTenders: 0
  };

  try {
    if (!options.skipZakup) {
      const companies = validBins.map((bin) => ({
        bin,
        companyName: getStatCompanyName(db, bin)
      }));
      const zakupResult = await collectZakupTendersForBatch(companies, {
        delayMs: options.delayMs ?? 2000,
        headless: options.headless
      });
      for (const tender of zakupResult.tenders) {
        upsertTender(upsert, tender);
      }
      stats.zakupCount = zakupResult.tenders.length;
      stats.totalTenders += zakupResult.tenders.length;
      stats.skipped += zakupResult.skipped;
    }

    if (!options.skipGoszakup) {
      if (!isGoszakupAvailable()) {
        console.warn("goszakup.gov.kz: source skipped for batch, GOSZAKUP_TOKEN is not set");
      } else {
        for (const bin of validBins) {
          const tenders = await fetchGoszakupTenders(bin);
          for (const tender of tenders) {
            upsertTender(upsert, tender);
          }
          stats.goszakupCount += tenders.length;
          stats.totalTenders += tenders.length;
          if (options.delayMs && options.delayMs > 0) await sleep(options.delayMs);
        }
      }
    }
  } finally {
    db.close();
  }

  return stats;
}

function getStatCompanyName(db: Database.Database, bin: string): string | null {
  const row = db.prepare("SELECT name FROM stat_gov_data WHERE bin = ?").get(bin) as { name: string | null } | undefined;
  return row?.name ?? null;
}

function prepareTenderUpsert(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT INTO tender_data (
      source, bin, tender_number, tender_name, customer_name, budget_amount,
      currency, start_date, end_date, status, method, url, parsed_at
    ) VALUES (
      @source, @bin, @tender_number, @tender_name, @customer_name, @budget_amount,
      @currency, @start_date, @end_date, @status, @method, @url, @parsed_at
    )
    ON CONFLICT(source, bin, tender_number) DO UPDATE SET
      tender_name = excluded.tender_name,
      customer_name = excluded.customer_name,
      budget_amount = excluded.budget_amount,
      currency = excluded.currency,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      status = excluded.status,
      method = excluded.method,
      url = excluded.url,
      parsed_at = excluded.parsed_at
  `);
}

function upsertTender(statement: Database.Statement, tender: TenderRecord): void {
  statement.run({
    ...tender,
    customer_name: tender.customer_name ?? null,
    budget_amount: tender.budget_amount ?? null,
    start_date: tender.start_date ?? null,
    end_date: tender.end_date ?? null,
    status: tender.status ?? null,
    method: tender.method ?? null,
    url: tender.url ?? null
  });
}
