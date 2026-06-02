import "dotenv/config";
import { Command } from "commander";
import { AdapterRegistry } from "./adapters/registry.js";
import { TwoGisAdapter } from "./adapters/2gis/index.js";
import { BrowserSessionManager } from "./browser/browserSessionManager.js";
import { loadConfig } from "./config/config.js";
import { JobManager } from "./core/jobManager.js";
import { logger } from "./logger.js";
import { ProxyRotator } from "./proxy/proxyRotator.js";
import { Storage } from "./storage/storage.js";
import { PostgresStorage } from "./storage/postgres/PostgresStorage.js";
import type { IStorage } from "./storage/interface.js";
import type { RuntimeConfig } from "./types.js";

const program = new Command();

program
  .name("scrape2lead")
  .description("Scrape2Lead MVP CLI")
  .option("-c, --config <path>", "config file path", "config.example.json")
  .option("--source <source>", "source adapter", "2gis")
  .option("--geo <geo>", "target city")
  .option("--category <category>", "target category")
  .option("--limit <limit>", "max cards")
  .option("--headless", "run browser headless")
  .option("--headed", "run browser with visible window")
  .option("--fixture <path>", "read captured JSON fixture instead of opening browser")
  .parse(process.argv);

const options = program.opts();
const overrides: Partial<RuntimeConfig> = {};
if (options.source) overrides.source = options.source;
if (options.geo) overrides.geo = options.geo;
if (options.category) overrides.category = options.category;
if (options.limit) overrides.limit = Number(options.limit);
if (options.headless) overrides.headless = true;
if (options.headed) overrides.headless = false;
if (options.fixture) overrides.fixturePath = options.fixture;

let storage: IStorage | null = null;
let adapter: TwoGisAdapter | null = null;
let postgresStorage: PostgresStorage | null = null;

try {
  const config = loadConfig(options.config, overrides);
  storage = await buildStorage(config);
  const registry = new AdapterRegistry();
  const browserSession = new BrowserSessionManager(config);
  adapter = new TwoGisAdapter(config, browserSession);
  const rotator = config.proxyApiUrl ? new ProxyRotator(config, storage, browserSession) : undefined;
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
  void postgresStorage; // held so the pool's drain is observable; no extra call needed
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
    // Block startup on the schema being migrated so the JobManager's first
    // runtime query never races an un-migrated database. ensureMigrated is
    // idempotent (no-op once schema_version is current). A failure here
    // aborts the run loudly via the surrounding try/catch. PostgresStorage
    // also guards every query path lazily, but awaiting here keeps the
    // ordering explicit and surfaces migration errors before any work starts.
    await pg.ensureMigrated();
    postgresStorage = pg;
    return pg;
  }
  return new Storage(config.databasePath, config.rawSnapshotDir);
}
