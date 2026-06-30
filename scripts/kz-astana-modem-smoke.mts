import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const CONFIG_PATH = process.argv[2] ?? "config.feeder.astana.lite.json";
const EXAMPLE_CONFIG = "config.feeder.astana.lite.example.json";

function ensureConfig(): string {
  if (fs.existsSync(CONFIG_PATH)) return CONFIG_PATH;
  if (fs.existsSync(EXAMPLE_CONFIG)) {
    fs.copyFileSync(EXAMPLE_CONFIG, CONFIG_PATH);
    console.log(`created ${CONFIG_PATH} from ${EXAMPLE_CONFIG}`);
    return CONFIG_PATH;
  }
  throw new Error(`Missing config: ${CONFIG_PATH}`);
}

function readDatabasePath(configPath: string): string {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { databasePath?: string };
  return config.databasePath ?? "data/smoke-astana-modem.db";
}

function proxyStatus(): void {
  const proxyVars = ["PROXY_SERVER", "PROXY_API_URL", "PROXY_USERNAME", "PROXY_PASSWORD"] as const;
  const active = proxyVars.filter((name) => Boolean(process.env[name]?.trim()));
  if (active.length > 0) {
    console.warn(`proxy env in shell (${active.join(", ")}) — smoke forces direct connection`);
  } else {
    console.log("proxy env in shell: none");
  }
}

async function runScrape(configPath: string): Promise<number> {
  const env = { ...process.env };
  // Empty strings prevent dotenv from re-applying PROXY_* from .env in the child.
  env.PROXY_SERVER = "";
  env.PROXY_API_URL = "";
  env.PROXY_USERNAME = "";
  env.PROXY_PASSWORD = "";

  console.log(`2GIS smoke: ${configPath}`);
  const started = Date.now();

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("npm", ["run", "dev", "--", "--config", configPath], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
      env
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });

  console.log(`2GIS smoke finished in ${Math.round((Date.now() - started) / 1000)}s, exit=${code}`);
  return code;
}

function printLeadStats(dbPath: string): void {
  if (!fs.existsSync(dbPath)) {
    console.log(`db not found: ${dbPath}`);
    return;
  }

  const db = new Database(dbPath);
  try {
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN city LIKE '%стана%' OR city LIKE '%Astana%' OR city LIKE '%Астана%' THEN 1 ELSE 0 END) AS astana_like,
        SUM(CASE WHEN phones IS NOT NULL AND phones != '[]' AND TRIM(phones) != '' THEN 1 ELSE 0 END) AS with_phones,
        SUM(CASE WHEN phone_normalized IS NOT NULL AND TRIM(phone_normalized) != '' THEN 1 ELSE 0 END) AS with_normalized_phone,
        SUM(CASE WHEN bin IS NOT NULL AND TRIM(bin) != '' THEN 1 ELSE 0 END) AS with_bin
      FROM leads
      WHERE source = '2gis'
    `).get() as Record<string, number>;

    const sample = db.prepare(`
      SELECT company_name, city, phone_normalized, phones
      FROM leads
      WHERE source = '2gis'
      ORDER BY rowid DESC
      LIMIT 5
    `).all() as Array<{ company_name: string; city: string; phone_normalized: string | null; phones: string }>;

    console.log("smoke lead stats:", stats);
    console.log("latest sample:");
    for (const row of sample) {
      const phone = row.phone_normalized?.trim() || row.phones;
      console.log(`- ${row.company_name.slice(0, 45)} | ${row.city} | ${phone}`);
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const configPath = ensureConfig();
  const dbPath = path.resolve(readDatabasePath(configPath));

  console.log("=== Astana USB modem smoke ===");
  proxyStatus();

  const code = await runScrape(configPath);
  printLeadStats(dbPath);

  if (code !== 0) {
    console.error("smoke FAILED — check mobile connection, 2GIS access, or proxy leftovers");
    process.exit(code);
  }

  const db = new Database(dbPath);
  try {
    const total = db.prepare("SELECT COUNT(*) AS c FROM leads WHERE source = '2gis'").get() as { c: number };
    if (total.c < 5) {
      console.warn(`smoke weak: only ${total.c} leads saved (expected ~10)`);
      process.exit(2);
    }
  } finally {
    db.close();
  }

  console.log("smoke OK — mobile path works, можно запускать полный Astana scrape");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
