import dotenv from "dotenv";
import { exportGzPlansReport } from "../src/kz/gzPlanExporter.js";
import {
  DEFAULT_GZ_PLANS_CONFIG_PATH,
  loadGzPlansConfig,
  mergeGzPlansExportOptions
} from "../src/kz/gzPlansConfig.js";

dotenv.config();

interface CliArgs {
  configPath: string;
  outPath: string | null | undefined;
  keywords: string[] | undefined;
  year: number | undefined;
  months: number[] | undefined;
  statuses: string[] | undefined;
  maxPages: number | undefined;
  delayMs: number | undefined;
  skipRegistry: boolean | undefined;
  forceRegistryRefresh: boolean | undefined;
  keepDuplicates: boolean | undefined;
  headless: boolean | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: DEFAULT_GZ_PLANS_CONFIG_PATH,
    outPath: undefined,
    keywords: undefined,
    year: undefined,
    months: undefined,
    statuses: undefined,
    maxPages: undefined,
    delayMs: undefined,
    skipRegistry: undefined,
    forceRegistryRefresh: undefined,
    keepDuplicates: undefined,
    headless: undefined
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      args.configPath = argv[++i] ?? DEFAULT_GZ_PLANS_CONFIG_PATH;
    } else if (arg === "--out") {
      args.outPath = argv[++i] ?? null;
    } else if (arg === "--keywords") {
      const raw = argv[++i] ?? "";
      args.keywords = raw.split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg === "--year") {
      args.year = Number(argv[++i] ?? 2026);
    } else if (arg === "--months") {
      const raw = argv[++i] ?? "";
      args.months = raw.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value));
    } else if (arg === "--statuses") {
      const raw = argv[++i] ?? "";
      args.statuses = raw.split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg === "--max-pages") {
      args.maxPages = Number(argv[++i]);
    } else if (arg === "--delay-ms") {
      args.delayMs = Number(argv[++i]);
    } else if (arg === "--skip-registry") {
      args.skipRegistry = true;
    } else if (arg === "--force-registry-refresh") {
      args.forceRegistryRefresh = true;
    } else if (arg === "--keep-duplicates") {
      args.keepDuplicates = true;
    } else if (arg === "--headed") {
      args.headless = false;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fileConfig = loadGzPlansConfig(args.configPath);
  const options = mergeGzPlansExportOptions(fileConfig, compactOverrides({
    outPath: args.outPath,
    keywords: args.keywords,
    year: args.year,
    months: args.months,
    statuses: args.statuses,
    maxPages: args.maxPages,
    delayMs: args.delayMs,
    skipRegistry: args.skipRegistry,
    forceRegistryRefresh: args.forceRegistryRefresh,
    keepDuplicates: args.keepDuplicates,
    headless: args.headless
  }));

  const result = await exportGzPlansReport({
    ...options,
    token: process.env.GOSZAKUP_TOKEN ?? null,
    onProgress: (message) => console.log(`gz-plans: ${message}`)
  });

  console.log(`gz-plans export: ${result.xlsxPath}`);
  console.log(`rows=${result.rows} customers=${result.customers} registry_hits=${result.registryHits}`);
}

function compactOverrides<T extends Record<string, unknown>>(overrides: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
