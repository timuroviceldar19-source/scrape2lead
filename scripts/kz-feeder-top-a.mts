import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { exportUnifiedReport } from "../src/kz/unifiedExporter.js";
import { runKzEnrich } from "../src/kz/enrichPipeline.js";
import { KzStorage } from "../src/kz/kzStorage.js";
import { scoreCompanyCards } from "../src/kz/kzLeadScore.js";
import { mergeLeadsWithKz, writeKzToLeads } from "../src/kz/leadKzMerge.js";
import { mergeStatGovData } from "./merge-stat-gov-data.js";
import { matchNames } from "../src/utils/nameNormalizer.js";

const DB_PATH = process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";
const BATCH_CSV = process.argv[2] ?? "bins-batch-100.csv";
const SKIP_2GIS = process.argv.includes("--skip-2gis");
const CONFIG_PATH = process.argv.find((arg, index) => arg === "--config" && process.argv[index + 1])
  ? process.argv[process.argv.indexOf("--config") + 1]
  : "config.feeder.json";
const TOP_A_CSV = process.argv.find((arg, index) => arg === "--top-a-csv" && process.argv[index + 1])
  ? process.argv[process.argv.indexOf("--top-a-csv") + 1]
  : "bins-top-a.csv";
const UNIFIED_OUT = process.argv.find((arg, index) => arg === "--out" && process.argv[index + 1])
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "exports/unified-top-a-feeder.xlsx";

function extractTopABins(batchCsv: string, outCsv: string): string[] {
  const storage = new KzStorage({ databasePath: DB_PATH });
  try {
    const bins = readBinsFromCsv(batchCsv);
    const topA = scoreCompanyCards(storage.getCompanyCards(bins))
      .filter((c) => c.lead_priority === "A")
      .sort((a, b) => (b.tender_active_budget_sum ?? 0) - (a.tender_active_budget_sum ?? 0));

    fs.mkdirSync(path.dirname(outCsv), { recursive: true });
    fs.writeFileSync(outCsv, ["bin", ...topA.map((c) => c.bin)].join("\n"), "utf8");
    console.log(`top-A bins: ${topA.length} → ${outCsv}`);
    return topA.map((c) => c.bin);
  } finally {
    storage.close();
  }
}

function backfillLeadBinsFromTopA(batchCsv: string): number {
  const db = new Database(DB_PATH);
  const storage = new KzStorage({ db });
  try {
    const bins = readBinsFromCsv(batchCsv);
    const topA = scoreCompanyCards(storage.getCompanyCards(bins)).filter((c) => c.lead_priority === "A");
    const leads = db.prepare(`
      SELECT source, external_id, company_name, bin
      FROM leads
      WHERE bin IS NULL OR TRIM(bin) = ''
    `).all() as Array<{ source: string; external_id: string; company_name: string; bin: string | null }>;

    const update = db.prepare(`
      UPDATE leads SET bin = ? WHERE source = ? AND external_id = ?
    `);

    let updated = 0;
    for (const lead of leads) {
      let best: { bin: string; score: number } | null = null;
      for (const card of topA) {
        const result = matchNames(card.name, lead.company_name, 0.65);
        if (result.matched && (!best || result.score > best.score)) {
          best = { bin: card.bin, score: result.score };
        }
      }
      if (best) {
        update.run(best.bin, lead.source, lead.external_id);
        console.log(`backfill bin: ${lead.company_name.slice(0, 40)} → ${best.bin} (${best.score.toFixed(2)})`);
        updated++;
      }
    }
    return updated;
  } finally {
    storage.close();
    db.close();
  }
}

async function run2gisScrape(configPath: string): Promise<void> {
  console.log(`2GIS scrape: ${configPath}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "dev", "--", "--config", configPath], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`2GIS scrape exit ${code}`))));
  });
}

async function main(): Promise<void> {
  const binsCsv = TOP_A_CSV;
  extractTopABins(BATCH_CSV, binsCsv);

  if (!SKIP_2GIS) {
    try {
      await run2gisScrape(CONFIG_PATH);
    } catch (error) {
      console.warn("2GIS scrape failed, continuing with existing leads:", error instanceof Error ? error.message : error);
    }
  } else {
    console.log("skip 2GIS scrape (--skip-2gis)");
  }

  const backfilled = backfillLeadBinsFromTopA(BATCH_CSV);
  console.log(`backfilled lead BINs: ${backfilled}`);

  console.log("KZ enrich top-A BINs (skip zakup)...");
  const enrich = await runKzEnrich({
    csvFile: binsCsv,
    databasePath: DB_PATH,
    skipZakup: true
  });
  console.log(`enrich: stat cached=${enrich.stat?.cached} registry cached=${enrich.registry?.cached} tenders=${enrich.tenders?.totalTenders}`);

  const db = new Database(DB_PATH);
  try {
    const mergeStat = mergeStatGovData(db);
    console.log(`merge stat.gov: matched=${mergeStat.matched} skipped=${mergeStat.skipped}`);

    const storage = new KzStorage({ db });
    const cards = scoreCompanyCards(storage.getCompanyCards(readBinsFromCsv(BATCH_CSV)));
    const { matches } = mergeLeadsWithKz(db, cards);
    const kzWritten = writeKzToLeads(db, matches);
    console.log(`writeKzToLeads: ${kzWritten}`);
    storage.close();
  } finally {
    db.close();
  }

  const unified = await exportUnifiedReport({
    databasePath: DB_PATH,
    outPath: UNIFIED_OUT,
    priority: "A",
    bins: readBinsFromCsv(BATCH_CSV)
  });
  console.log(`unified export: ${unified.xlsxPath}`);
  console.log(`leads=${unified.leads} tenders=${unified.tenders} errors=${unified.errors}`);
  console.log(`merge stats: with_bin=${unified.mergeStats.with_bin} with_tenders=${unified.mergeStats.with_tenders}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
