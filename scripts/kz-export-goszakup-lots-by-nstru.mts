import fs from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";
import { exportGoszakupLotsByNstru, resolveLotStatusIds } from "../src/kz/goszakupLotsNstruExporter.js";

dotenv.config();

const GzLotsConfigSchema = z.object({
  keywords: z.array(z.string().min(1)).default([]),
  nstruCodes: z.array(z.string().min(1)).default([]),
  inputPath: z.string().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  months: z.array(z.coerce.number().int().min(1).max(12)).optional(),
  statuses: z.array(z.string().min(1)).default([]),
  minAmount: z.coerce.number().nonnegative().optional(),
  excludeKeywords: z.array(z.string().min(1)).default([]),
  maxPages: z.coerce.number().int().positive().optional(),
  delayMs: z.coerce.number().int().nonnegative().optional(),
  headless: z.boolean().optional(),
  outPath: z.string().optional()
});

type GzLotsConfig = z.infer<typeof GzLotsConfigSchema>;

interface CliArgs {
  configPath: string | undefined;
  inputPath: string | undefined;
  outPath: string | undefined;
  year: number | undefined;
  months: number[] | undefined;
  statusIds: number[] | undefined;
  maxPages: number | undefined;
  delayMs: number | undefined;
  headless: boolean | undefined;
  slowMoMs: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: undefined,
    inputPath: undefined,
    outPath: undefined,
    year: undefined,
    months: undefined,
    statusIds: undefined,
    maxPages: undefined,
    delayMs: undefined,
    headless: undefined,
    slowMoMs: undefined
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      args.configPath = argv[++i];
    } else if (arg === "--input") {
      args.inputPath = argv[++i];
    } else if (arg === "--out") {
      args.outPath = argv[++i];
    } else if (arg === "--year") {
      args.year = Number(argv[++i]);
    } else if (arg === "--months") {
      args.months = parseNumberList(argv[++i] ?? "");
    } else if (arg === "--statuses" || arg === "--status-ids") {
      args.statusIds = resolveLotStatusIds(parseStringList(argv[++i] ?? ""));
    } else if (arg === "--max-pages") {
      args.maxPages = Number(argv[++i]);
    } else if (arg === "--delay-ms") {
      args.delayMs = Number(argv[++i]);
    } else if (arg === "--slow-ms") {
      args.slowMoMs = Number(argv[++i]);
    } else if (arg === "--headed") {
      args.headless = false;
    } else if (arg === "--headless") {
      args.headless = true;
      args.slowMoMs = 0;
    }
  }

  return args;
}

function loadConfig(configPath: string | undefined): GzLotsConfig {
  if (!configPath) return GzLotsConfigSchema.parse({});
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  return GzLotsConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
}

function parseNumberList(value: string): number[] {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function parseStringList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);

  const statusIds = args.statusIds ?? resolveLotStatusIds(config.statuses);
  const headless = args.headless ?? config.headless ?? false;
  const result = await exportGoszakupLotsByNstru({
    inputPath: args.inputPath ?? config.inputPath ?? "Nstru.txt",
    nstruCodes: config.nstruCodes.length > 0 ? config.nstruCodes : undefined,
    keywords: config.keywords,
    outPath: args.outPath ?? config.outPath,
    year: args.year ?? config.year,
    months: args.months ?? config.months,
    statusIds,
    minAmount: config.minAmount,
    excludeKeywords: config.excludeKeywords,
    maxPages: args.maxPages ?? config.maxPages,
    delayMs: args.delayMs ?? config.delayMs,
    headless,
    slowMoMs: args.slowMoMs ?? (headless ? 0 : 100),
    onProgress: (message) => console.log(`lots-nstru: ${message}`)
  });

  console.log(`lots-nstru export: ${result.xlsxPath}`);
  console.log(`rows=${result.rows} queries=${result.codes} months=${result.months.join(",")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
