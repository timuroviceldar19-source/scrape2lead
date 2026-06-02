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

let storage: Storage | null = null;
let adapter: TwoGisAdapter | null = null;

try {
  const config = loadConfig(options.config, overrides);
  storage = new Storage(config.databasePath);
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
}
