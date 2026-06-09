import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { exportUnifiedReport } from "../src/kz/unifiedExporter.js";
import { runKzEnrich } from "../src/kz/enrichPipeline.js";
import { KzStorage } from "../src/kz/kzStorage.js";
import { scoreCompanyCards } from "../src/kz/kzLeadScore.js";
import {
  parseFeederConfigPaths,
  readBatchCsvArg,
  readCliArg
} from "../src/kz/feederConfig.js";
import {
  backfillBinsFromMatches,
  backfillLeadBins,
  mergeLeadsWithKz,
  writeKzToLeads
} from "../src/kz/leadKzMerge.js";
import { mergeStatGovData } from "./merge-stat-gov-data.js";

const DB_PATH = process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";
const BATCH_CSV = readBatchCsvArg(process.argv);
const SKIP_2GIS = process.argv.includes("--skip-2gis");
const TOP_A_CSV = readCliArg(process.argv, "--top-a-csv") ?? "bins-top-a.csv";
const UNIFIED_OUT = readCliArg(process.argv, "--out") ?? "exports/unified-top-a-feeder.xlsx";

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
  const configPaths = parseFeederConfigPaths(process.argv);
  const binsCsv = TOP_A_CSV;
  extractTopABins(BATCH_CSV, binsCsv);

  if (!SKIP_2GIS) {
    for (const [index, configPath] of configPaths.entries()) {
      try {
        console.log(`2GIS pass ${index + 1}/${configPaths.length}`);
        await run2gisScrape(configPath);
      } catch (error) {
        console.warn(
          `2GIS scrape failed for ${configPath}, continuing:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  } else {
    console.log("skip 2GIS scrape (--skip-2gis)");
  }

  const db = new Database(DB_PATH);
  const storage = new KzStorage({ db });
  try {
    const batchCards = scoreCompanyCards(storage.getCompanyCards(readBinsFromCsv(BATCH_CSV)));

    const backfilled = backfillLeadBins(db, batchCards);
    console.log(`backfilled lead BINs (batch fuzzy): ${backfilled}`);

    console.log("KZ enrich top-A BINs (skip zakup)...");
    const enrich = await runKzEnrich({
      csvFile: binsCsv,
      databasePath: DB_PATH,
      skipZakup: true
    });
    console.log(
      `enrich: stat cached=${enrich.stat?.cached} registry cached=${enrich.registry?.cached} tenders=${enrich.tenders?.totalTenders}`
    );

    const mergeStat = mergeStatGovData(db);
    console.log(`merge stat.gov: matched=${mergeStat.matched} skipped=${mergeStat.skipped}`);

    const cards = scoreCompanyCards(storage.getCompanyCards(readBinsFromCsv(BATCH_CSV)));
    const { matches } = mergeLeadsWithKz(db, cards);
    const binsFromMatches = backfillBinsFromMatches(db, matches);
    console.log(`backfilled lead BINs (merge kz_bin): ${binsFromMatches}`);

    const kzWritten = writeKzToLeads(db, matches);
    console.log(`writeKzToLeads: ${kzWritten}`);
  } finally {
    storage.close();
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
