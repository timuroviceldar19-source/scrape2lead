import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  buildContractSearchUrl,
  exportGoszakupContracts
} from "../src/kz/goszakupContractExporter.js";

const ConfigSchema = z.object({
  codes: z.array(z.string().regex(/^\d{6}\.\d{3}\.\d{6}$/)).min(1),
  from: z.string().default("2026-01-01"),
  to: z.string().optional(),
  outPath: z.string().optional(),
  maxPages: z.number().int().positive().default(500),
  delayMs: z.number().int().nonnegative().default(750),
  recordsPerPage: z.number().int().positive().max(2000).default(50),
  headless: z.boolean().default(true)
});

interface CliArgs {
  configPath: string;
  from?: string;
  to?: string;
  outPath?: string;
  limit?: number;
  maxPages?: number;
  headless?: boolean;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { configPath: "config/gz-contracts-panels.json", dryRun: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--config") args.configPath = value();
    else if (arg === "--from") args.from = value();
    else if (arg === "--to") args.to = value();
    else if (arg === "--out") args.outPath = value();
    else if (arg === "--limit") args.limit = positiveInteger(value(), "--limit");
    else if (arg === "--max-pages") args.maxPages = positiveInteger(value(), "--max-pages");
    else if (arg === "--headful" || arg === "--headed") args.headless = false;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!fs.existsSync(args.configPath)) throw new Error(`Config file not found: ${args.configPath}`);
  const config = ConfigSchema.parse(JSON.parse(fs.readFileSync(args.configPath, "utf8")));
  const from = args.from ?? config.from;
  const to = args.to ?? config.to ?? localIsoDate(new Date());
  const outPath = args.outPath ?? config.outPath ?? path.join("exports", `goszakup-contracts-${from}-${to}.xlsx`);

  if (args.dryRun) {
    console.log(`dry-run: from=${from} to=${to} out=${outPath}`);
    for (const code of config.codes) console.log(buildContractSearchUrl({ code, from, to }));
    return;
  }

  const result = await exportGoszakupContracts({
    codes: config.codes,
    from,
    to,
    outPath,
    limit: args.limit,
    maxPages: args.maxPages ?? config.maxPages,
    delayMs: config.delayMs,
    recordsPerPage: config.recordsPerPage,
    headless: args.headless ?? config.headless,
    slowMoMs: args.headless === false ? 100 : 0,
    onProgress: (message) => console.log(`gz-contracts: ${message}`)
  });
  console.log(`gz-contracts export: ${result.xlsxPath}`);
  console.log(
    `rows=${result.rows} codes=${result.codes} missing_ids=${result.missingIdentifiers} `
    + `outside_period=${result.skippedOutOfRange} code_mismatch=${result.skippedCodeMismatch}`
  );
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function printHelp(): void {
  console.log(`Export public goszakup contracts by ENSTRU code.

Usage:
  npm run kz:export-gz-contracts -- [options]

Options:
  --config <path>     JSON config (default: config/gz-contracts-panels.json)
  --from <YYYY-MM-DD> Signing period start
  --to <YYYY-MM-DD>   Signing period end (default: local current date)
  --out <path>        Output XLSX path
  --limit <n>         Stop after n exported rows
  --max-pages <n>     Safety page limit
  --headful           Show Chromium window
  --headless          Run Chromium hidden
  --dry-run           Validate config and print search URLs without network calls
  --help              Show this help`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

