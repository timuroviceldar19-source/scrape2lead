import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { scoreCompanyCards } from "../src/kz/kzLeadScore.js";
import { KzStorage } from "../src/kz/kzStorage.js";
import { mergeLeadsWithKz } from "../src/kz/leadKzMerge.js";
import { groupMatchesByKzBin } from "../src/kz/unifiedExporter.js";
import { cleanName, removeLegalForm } from "../src/utils/nameNormalizer.js";

const DB_PATH = process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";
const BATCH_CSV = process.argv[2] ?? "bins-batch-100.csv";
const TOP_A_CSV = process.argv[3] ?? "bins-top-a.csv";
const LIMIT = Number(process.argv[4] ?? "3");
const MAX_COMPANIES = Number(process.argv[5] ?? "10");
const BASE_CONFIG = {
  source: "2gis",
  geo: "Астана",
  category: "placeholder",
  limit: LIMIT,
  databasePath: DB_PATH,
  exportDir: "exports",
  delayRangeMs: [2000, 4000],
  rotateEveryN: 50,
  maxRetries: 2,
  concurrency: 1,
  headless: true,
  rawSnapshotDir: "raw_snapshots",
  twoGisBaseUrl: "https://2gis.kz",
  storageBackend: "sqlite",
  websiteCrawl: { enabled: false },
  websiteDiscovery: { enabled: false },
  directoryContactDiscovery: { enabled: false }
};

interface TargetCompany {
  bin: string;
  name: string;
  activeBudget: number;
  searchTerms: string[];
}

function extractSearchTerms(statName: string): string[] {
  const terms = new Set<string>();
  for (const match of statName.matchAll(/"([^"]+)"/g)) {
    const value = match[1]?.trim();
    if (value && value.length >= 3) terms.add(value);
  }

  const cleaned = cleanName(removeLegalForm(statName));
  if (cleaned.length >= 4) terms.add(cleaned.slice(0, 48));

  return [...terms].slice(0, 2);
}

function loadTargets(): TargetCompany[] {
  const db = new Database(DB_PATH);
  const storage = new KzStorage({ db });
  try {
    const topABins = new Set(readBinsFromCsv(TOP_A_CSV));
    const cards = scoreCompanyCards(storage.getCompanyCards(readBinsFromCsv(BATCH_CSV)))
      .filter((card) => topABins.has(card.bin) && card.lead_priority === "A");

    const { matches } = mergeLeadsWithKz(db, cards);
    const matchesByBin = groupMatchesByKzBin(matches);

    return cards
      .filter((card) => (matchesByBin.get(card.bin)?.length ?? 0) === 0)
      .sort((a, b) => (b.tender_active_budget_sum ?? 0) - (a.tender_active_budget_sum ?? 0))
      .slice(0, MAX_COMPANIES)
      .map((card) => ({
        bin: card.bin,
        name: card.name,
        activeBudget: card.tender_active_budget_sum ?? 0,
        searchTerms: extractSearchTerms(card.name)
      }))
      .filter((target) => target.searchTerms.length > 0);
  } finally {
    storage.close();
    db.close();
  }
}

async function runSearch(geo: string, category: string): Promise<number> {
  const configPath = path.join("exports", `.targeted-2gis-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...BASE_CONFIG, geo, category, limit: LIMIT }, null, 2), "utf8");

  const env = { ...process.env };
  env.PROXY_SERVER = "";
  env.PROXY_API_URL = "";
  env.PROXY_USERNAME = "";
  env.PROXY_PASSWORD = "";

  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn("npm", ["run", "dev", "--", "--config", configPath], {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: true,
        env
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  }
}

async function main(): Promise<void> {
  const targets = loadTargets();
  console.log(`targeted 2GIS: ${targets.length} top-A companies without match`);

  for (const [index, target] of targets.entries()) {
    console.log(`\n[${index + 1}/${targets.length}] ${target.bin} | ${target.name.slice(0, 60)}`);
    for (const term of target.searchTerms) {
      for (const geo of ["Астана", "Алматы"]) {
        console.log(`search: ${geo} / "${term}"`);
        const code = await runSearch(geo, term);
        if (code !== 0) {
          console.warn(`search failed (${code}) for ${target.bin} ${geo} "${term}"`);
        }
      }
    }
  }

  console.log("targeted 2GIS done");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
