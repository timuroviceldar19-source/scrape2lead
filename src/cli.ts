import "dotenv/config";
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
  .action(async (cmdOptions) => {
    const config = loadConfig(cmdOptions.config, {});
    const limit = Number(cmdOptions.limit) || 100;
    const city = cmdOptions.city as string | undefined;
    const includeReadyToCall = Boolean(cmdOptions.includeReadyToCall);
    // Commander automatically converts --no-write to write: false
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
      includeReadyToCall
    });

    const browserSession = new BrowserSessionManager(config);
    const adapter = new TwoGisEnrichmentAdapter(config, browserSession);
    // ProxyRotator is created whenever any proxy is configured (static
    // server OR rotation API). With only a static server it operates in
    // "no-api" mode: it just restarts the browser every `rotateEveryN`
    // leads, which is enough to pick up a fresh IP from a backconnect
    // gateway like dataimpulse port 823.
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

    for (const lead of leads) {
      try {
        const decision = await processor.processLead(lead, mode);
        if (decision.isCaptchaOrBlocked) {
          stats.captcha_or_blocked++;
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

// Parse arguments FIRST, then check if a command was executed
program.parse(process.argv);

// Default run (scraping) if no specific command like 'enrich' was invoked
if (!process.argv.includes("enrich")) {
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

  // `--config` is intentionally NOT declared on the root program so that the
  // same flag binds to subcommands (notably `enrich`) instead of being shadowed
  // by the root. The default scraping path needs it too, so we extract it from
  // argv manually here.
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
