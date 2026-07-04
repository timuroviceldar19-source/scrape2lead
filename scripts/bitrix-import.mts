import dotenv from "dotenv";
import { BitrixClient } from "../src/bitrix/client.js";
import { loadImportConfig } from "../src/bitrix/importConfig.js";
import { runImport } from "../src/bitrix/importRunner.js";
import { readImportRows } from "../src/bitrix/xlsxRowReader.js";

dotenv.config();

interface CliArgs {
  configPath: string | null;
  inputPath: string | null;
  execute: boolean;
  updateExisting: boolean;
  limit: number | null;
  webhookUrl: string | null;
  delayMs: number | null;
}

const USAGE = `Usage: tsx scripts/bitrix-import.mts --config <mapping.json> --input <rows.xlsx|.csv> [options]

Options:
  --config <path>       import mapping config (JSON, see config/bitrix-import.example.json)
  --input <path>        source XLSX or CSV file
  --execute             actually write to Bitrix24 (default: dry-run preflight only)
  --update-existing     update entities already imported (matched by ORIGIN_ID)
  --limit <n>           process only the first n rows
  --webhook-url <url>   Bitrix24 inbound webhook (default: env BITRIX24_WEBHOOK_URL)
  --delay-ms <n>        minimum delay between REST calls (default: 500)`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: null,
    inputPath: null,
    execute: false,
    updateExisting: false,
    limit: null,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    delayMs: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") args.configPath = argv[++i] ?? null;
    else if (arg === "--input") args.inputPath = argv[++i] ?? null;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--update-existing") args.updateExisting = true;
    else if (arg === "--limit") args.limit = parsePositiveInt(argv[++i]);
    else if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else if (arg === "--delay-ms") args.delayMs = parsePositiveInt(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  return args;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.configPath || !args.inputPath) {
    throw new Error(`--config and --input are required\n\n${USAGE}`);
  }
  if (!args.webhookUrl) {
    throw new Error("Bitrix webhook URL is required: set BITRIX24_WEBHOOK_URL or pass --webhook-url");
  }

  const config = loadImportConfig(args.configPath);
  const rows = await readImportRows(args.inputPath, config);
  const client = new BitrixClient(args.webhookUrl, {
    requestDelayMs: args.delayMs ?? undefined
  });

  console.log(`bitrix import: entity=${config.entity} originator=${config.originatorId} mode=${args.execute ? "execute" : "dry-run"} update_existing=${args.updateExisting}`);
  console.log(`input=${args.inputPath} rows=${rows.length}${args.limit ? ` limit=${args.limit}` : ""}`);

  const { counts } = await runImport(client, config, rows, {
    execute: args.execute,
    updateExisting: args.updateExisting,
    limit: args.limit
  });

  console.log(`summary: create=${counts.create} update=${counts.update} existing=${counts.existing} duplicate=${counts.duplicate} skipped=${counts.skip} failed=${counts.failed}`);
  if (counts.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
