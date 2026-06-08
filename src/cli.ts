import "dotenv/config";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { Command } from "commander";
import { AdapterRegistry } from "./adapters/registry.js";
import { TwoGisAdapter } from "./adapters/2gis/index.js";
import { KaspiAdapter } from "./adapters/kaspi/index.js";
import { BrowserSessionManager } from "./browser/browserSessionManager.js";
import { loadConfig } from "./config/config.js";
import { JobManager } from "./core/jobManager.js";
import { logger } from "./logger.js";
import { ProxyRotator } from "./proxy/proxyRotator.js";
import { Storage } from "./storage/storage.js";
import { PostgresStorage } from "./storage/postgres/PostgresStorage.js";
import type { IStorage } from "./storage/interface.js";
import type { RuntimeConfig, ISourceAdapter } from "./types.js";
import { EnrichmentProcessor } from "./enrichment/enrichmentProcessor.js";
import { TwoGisEnrichmentAdapter } from "./enrichment/adapters/TwoGisEnrichmentAdapter.js";
import { formatKzEnrichResult, runKzEnrich } from "./kz/enrichPipeline.js";
import { readBinsFromCsv } from "./kz/csv.js";
import { exportKzReport } from "./kz/kzExporter.js";
import { mergeStatGovData } from "../scripts/merge-stat-gov-data.js";

const program = new Command();

program
  .name("scrape2lead")
  .description("Scrape2Lead MVP CLI")
  .option("--source <source>", "source adapter (overrides config)")
  .option("--geo <geo>", "target city (overrides config)")
  .option(
    "--category <category>",
    "target category (overrides config). Comma-separated values set the `categories` array, e.g. `--category 'Автозапчасти,Шины и диски'`"
  )
  .option("--limit <limit>", "max cards (overrides config)")
  .option("--headless", "run browser headless")
  .option("--headed", "run browser with visible window")
  .option("--fixture <path>", "read captured JSON fixture instead of opening browser");

const kz = program.command("kz").description("Kazakhstan company intelligence pipeline");

kz
  .command("login")
  .description("Create or refresh stat.gov.kz browser session")
  .action(async () => {
    await runScript("scripts/stat-gov-login.ts");
  });

kz
  .command("enrich")
  .description("Run KZ stat.gov + tenders enrichment for BIN CSV")
  .argument("<csvFile>", "CSV file with BIN values")
  .option("--skip-stat", "skip stat.gov collection")
  .option("--skip-tenders", "skip tender collection")
  .option("--skip-zakup", "skip zakup.sk.kz collection (goszakup only)")
  .option("--skip-goszakup-registry", "skip public goszakup registry collection")
  .option("--skip-goszakup-html", "skip goszakup.gov.kz HTML scraping (lots/announces)")
  .option("--registry-only", "only run goszakup registry (skip stat + tenders)")
  .option("--delay-ms <ms>", "delay between requests in ms", "2000")
  .option("--force-refresh", "ignore stat.gov TTL cache")
  .option("--goszakup-active-only", "only keep goszakup tenders with active status")
  .option("--goszakup-max-pages <pages>", "max pages to fetch from goszakup API", "20")
  .option("--zakup-max-retries <retries>", "max retries for zakup.sk.kz search input", "3")
  .action(async (csvFile: string, options: {
    skipStat?: boolean;
    skipTenders?: boolean;
    skipZakup?: boolean;
    skipGoszakupRegistry?: boolean;
    skipGoszakupHtml?: boolean;
    registryOnly?: boolean;
    delayMs: string;
    forceRefresh?: boolean;
    goszakupActiveOnly?: boolean;
    goszakupMaxPages?: string;
    zakupMaxRetries?: string;
  }) => {
    const result = await runKzEnrich({
      csvFile,
      skipStat: Boolean(options.skipStat),
      skipTenders: Boolean(options.skipTenders),
      skipZakup: Boolean(options.skipZakup),
      skipGoszakupRegistry: Boolean(options.skipGoszakupRegistry),
      skipGoszakupHtml: Boolean(options.skipGoszakupHtml),
      registryOnly: Boolean(options.registryOnly),
      delayMs: Number(options.delayMs) || 2000,
      forceRefresh: Boolean(options.forceRefresh),
      goszakupActiveOnly: Boolean(options.goszakupActiveOnly),
      goszakupMaxPages: Number(options.goszakupMaxPages) || 20,
      zakupMaxRetries: Number(options.zakupMaxRetries) || 3
    });
    console.log(formatKzEnrichResult(result));
  });

kz
  .command("export")
  .description("Export KZ company cards, tenders, summary and errors to XLSX")
  .option("--bins <csvFile>", "optional CSV file with BIN values")
  .option("--out <path>", "output XLSX path")
  .option("--format <format>", "export format", "xlsx")
  .action(async (options: { bins?: string; out?: string; format: string }) => {
    if (options.format !== "xlsx") {
      throw new Error("Only --format xlsx is supported for KZ export");
    }
    const result = await exportKzReport({
      bins: options.bins ? readBinsFromCsv(options.bins) : undefined,
      outPath: options.out
    });
    console.log(`kz export: ${result.xlsxPath}`);
    console.log(`companies=${result.companies} tenders=${result.tenders} errors=${result.errors}`);
  });

kz
  .command("merge")
  .description("Merge stat.gov data into leads")
  .action(() => {
    const db = new Database("data/scrape2lead.db");
    try {
      const stats = mergeStatGovData(db);
      console.log(`merge stat.gov: matched=${stats.matched} skipped=${stats.skipped}`);
    } finally {
      db.close();
    }
  });

kz
  .command("registry")
  .description("Collect public goszakup.gov.kz registry data (no token required)")
  .argument("<csvFile>", "CSV file with BIN values")
  .option("--delay-ms <ms>", "delay between requests in ms", "2000")
  .option("--force-refresh", "ignore TTL cache")
  .option("--headless", "run browser headless", true)
  .action(async (csvFile: string, options: { delayMs: string; forceRefresh?: boolean; headless: boolean }) => {
    const bins = readBinsFromCsv(csvFile);
    const { collectGoszakupRegistryForBins } = await import("./kz/goszakupRegistryCollector.js");
    const stats = await collectGoszakupRegistryForBins(bins, {
      delayMs: Number(options.delayMs) || 2000,
      forceRefresh: Boolean(options.forceRefresh),
      headless: Boolean(options.headless)
    });
    console.log(`registry: processed=${stats.processed} success=${stats.success} not_found=${stats.not_found} cached=${stats.cached} failed=${stats.failed}`);
  });

program
  .command("enrich")
  .description("Run enrichment on existing leads needing enrichment (no scraping)")
  .option("-c, --config <path>", "config file path", "config.example.json")
  .option("--limit <limit>", "max leads to process", "100")
  .option("--batch-size <size>", "leads per batch (for future concurrency)", "10")
  .option("--city <city>", "filter by city")
  .option("--plan", "only show which leads would be processed (no HTTP, no DB write)")
  .option("--no-write", "perform real HTTP requests and scoring, but do not write to DB")
  .option(
    "--include-ready-to-call",
    "also enrich leads with crm_status='Ready to call' that still lack address/website"
  )
  .option("--delay-min <ms>", "minimum delay between leads in ms", "3000")
  .option("--delay-max <ms>", "maximum delay between leads in ms", "6000")
  .option("--throttle-cooldown <seconds>", "cooldown after throttle/captcha in seconds", "120")
  .action(async (cmdOptions) => {
    const config = loadConfig(cmdOptions.config, {});
    const limit = Number(cmdOptions.limit) || 100;
    const city = cmdOptions.city as string | undefined;
    const includeReadyToCall = Boolean(cmdOptions.includeReadyToCall);
    const delayMin = Number(cmdOptions.delayMin) || 3000;
    const delayMax = Number(cmdOptions.delayMax) || 6000;
    const throttleCooldown = Number(cmdOptions.throttleCooldown) || 120;
    const mode = cmdOptions.plan ? 'plan' : (cmdOptions.write === false ? 'no-write' : 'write');

    const storage = await buildStorage(config);
    if (!(storage instanceof Storage)) {
      logger.error("Enrichment currently only supports SQLite storage backend");
      process.exitCode = 1;
      return;
    }

    const leads = await storage.getLeadsNeedingEnrichment(limit, city, includeReadyToCall);
    logger.info(`Enrichment mode: ${mode.toUpperCase()}`, {
      count: leads.length,
      includeReadyToCall,
      delayRange: [delayMin, delayMax],
      throttleCooldown
    });

    const browserSession = new BrowserSessionManager(config);
    const adapter = new TwoGisEnrichmentAdapter(config, browserSession);
    const rotator = config.proxyApiUrl || config.proxy
      ? new ProxyRotator(config, storage, browserSession)
      : undefined;
    const processor = new EnrichmentProcessor(adapter, storage, rotator);

    const stats = {
      total: leads.length,
      enriched: 0,
      manual_review: 0,
      not_found: 0,
      failed: 0,
      captcha_or_blocked: 0
    };

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const randomDelay = () => Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      try {
        const decision = await processor.processLead(lead, mode);
        if (decision.isCaptchaOrBlocked) {
          stats.captcha_or_blocked++;
          const cooldownMs = throttleCooldown * 1000;
          logger.warn(`Throttle/captcha detected, cooling down ${throttleCooldown}s`);
          await sleep(cooldownMs);
        } else if (decision.enrichment_status === "enriched") {
          stats.enriched++;
        } else if (decision.enrichment_status === "manual_review") {
          stats.manual_review++;
        } else if (decision.enrichment_status === "not_found") {
          stats.not_found++;
        } else if (decision.enrichment_status === "failed") {
          stats.failed++;
        }
      } catch (error) {
        logger.error("Lead processing crashed", { external_id: lead.external_id, error: error instanceof Error ? error.message : String(error) });
        stats.failed++;
      }

      if (i < leads.length - 1) {
        const delay = randomDelay();
        logger.info(`Waiting ${delay}ms before next lead...`);
        await sleep(delay);
      }
    }

    logger.info("Enrichment completed", stats);
    await processor.close();
    // processor.close() only closes the browser if the adapter owns it. In
    // the enrich CLI path we create the BrowserSessionManager at the top so
    // the ProxyRotator can restart it on proxy rotation, so we own the
    // close here.
    await browserSession.close();
    storage.close();
  });

// `--config` is intentionally NOT declared on the root program so that
// the same flag binds to subcommands (notably `enrich`) instead of being
// shadowed by the root. The default scraping path needs it too, so we
// strip `--config <path>` (and `-c <path>` / `--config=<path>`) from
// argv before parsing — but ONLY when the user is invoking the root
// scrape path (no `enrich` subcommand). Subcommands still see --config.
const argvForParse = process.argv.includes("enrich")
  ? process.argv
  : process.argv.filter((arg, i, arr) => {
      if (arg === "-c" || arg === "--config") return false;
      if (arg.startsWith("--config=")) return false;
      if (i > 0 && (arr[i - 1] === "-c" || arr[i - 1] === "--config")) return false;
      return true;
    });

// Default scrape action — commander runs this when no subcommand is matched.
// Without it, the moment any subcommand (like `enrich`) is registered, commander
// treats a no-args invocation as a help request and prints+exits before our
// scrape code gets a chance to run.
program.action(async () => {
  const options = program.opts();
  const overrides: Partial<RuntimeConfig> = {};
  if (options.source) overrides.source = options.source;
  if (options.geo) overrides.geo = options.geo;
  if (options.category) {
    const parts = options.category
      .split(",")
      .map((c: string) => c.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      overrides.categories = parts;
      overrides.category = undefined;
    } else {
      overrides.category = parts[0];
    }
  }
  if (options.limit) overrides.limit = Number(options.limit);
  if (options.headless) overrides.headless = true;
  if (options.headed) overrides.headless = false;
  if (options.fixture) overrides.fixturePath = options.fixture;

  // `--config` is intentionally NOT declared on the root program so that
  // the same flag binds to subcommands (notably `enrich`) instead of being
  // shadowed by the root. The default scraping path needs it too, so we
  // extract it from argv manually here.
  const configPath = readConfigArg(process.argv) ?? "config.example.json";

  let storage: IStorage | null = null;
  let adapter: ISourceAdapter | null = null;
  let postgresStorage: PostgresStorage | null = null;

  try {
    const config = loadConfig(configPath, overrides);
    storage = await buildStorage(config);
    const registry = new AdapterRegistry();
    const browserSession = new BrowserSessionManager(config);

    if (config.source === "kaspi") {
      adapter = new KaspiAdapter(config, browserSession);
    } else {
      adapter = new TwoGisAdapter(config, browserSession);
    }

    const rotator = config.proxyApiUrl || config.proxy
      ? new ProxyRotator(config, storage, browserSession)
      : undefined;
    registry.register(adapter);
    const manager = new JobManager(config, registry, storage, rotator);
    const result = await manager.run();
    logger.info("export files", { csv: result.csvPath, xlsx: result.xlsxPath });
  } catch (error) {
    logger.error("job failed", { message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    storage?.close();
    await adapter?.close();
    void postgresStorage;
  }
});

// Parse arguments; the default action above runs the scrape path, the
// `enrich` subcommand runs its own action.
await program.parseAsync(argvForParse);

async function runScript(scriptPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const executable = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(executable, ["tsx", scriptPath], {
      stdio: "inherit",
      shell: false
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptPath} exited with code ${code ?? "null"}`));
    });
  });
}

/**
 * Backend selector. SQLite stays the default so the existing CLI surface,
 * `config.example.json`, and the on-disk `data/scrape2lead.db` workflow are
 * preserved untouched. The Postgres branch is selected by either
 * `STORAGE_BACKEND=postgres` in the environment or
 * `storageBackend: "postgres"` in the JSON config (see `docs/storage.md`).
 */
async function buildStorage(config: RuntimeConfig): Promise<IStorage> {
  const backend = config.storageBackend ?? "sqlite";
  if (backend === "postgres") {
    const connectionString =
      config.postgresConnectionString ?? process.env.POSTGRES_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error(
        "storageBackend=postgres requires postgresConnectionString (config) or POSTGRES_CONNECTION_STRING (env)"
      );
    }
    const pg = new PostgresStorage(connectionString, {
      rawSnapshotDir: config.rawSnapshotDir
    });
    await pg.ensureMigrated();
    return pg;
  }
  return new Storage(config.databasePath, config.rawSnapshotDir);
}

/**
 * Extract `--config <path>` / `-c <path>` from a raw argv list. Returns
 * `undefined` when the flag is absent. Used by the default scraping path
 * because the root program intentionally does not declare `--config`
 * (see the comment in the default-scrape branch for the rationale).
 */
export function readConfigArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-c" || arg === "--config") {
      return argv[i + 1];
    }
    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
  }
  return undefined;
}
