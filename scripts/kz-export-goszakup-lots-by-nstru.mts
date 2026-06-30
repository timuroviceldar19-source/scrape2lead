import dotenv from "dotenv";
import { exportGoszakupLotsByNstru } from "../src/kz/goszakupLotsNstruExporter.js";

dotenv.config();

interface CliArgs {
  inputPath: string;
  outPath: string | undefined;
  year: number | undefined;
  months: number[] | undefined;
  statusIds: number[] | undefined;
  maxPages: number | undefined;
  delayMs: number | undefined;
  headless: boolean;
  slowMoMs: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputPath: "Nstru.txt",
    outPath: undefined,
    year: undefined,
    months: undefined,
    statusIds: undefined,
    maxPages: undefined,
    delayMs: undefined,
    headless: false,
    slowMoMs: 100
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.inputPath = argv[++i] ?? args.inputPath;
    } else if (arg === "--out") {
      args.outPath = argv[++i];
    } else if (arg === "--year") {
      args.year = Number(argv[++i]);
    } else if (arg === "--months") {
      args.months = parseNumberList(argv[++i] ?? "");
    } else if (arg === "--statuses" || arg === "--status-ids") {
      args.statusIds = parseNumberList(argv[++i] ?? "");
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

function parseNumberList(value: string): number[] {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await exportGoszakupLotsByNstru({
    inputPath: args.inputPath,
    outPath: args.outPath,
    year: args.year,
    months: args.months,
    statusIds: args.statusIds,
    maxPages: args.maxPages,
    delayMs: args.delayMs,
    headless: args.headless,
    slowMoMs: args.slowMoMs,
    onProgress: (message) => console.log(`lots-nstru: ${message}`)
  });

  console.log(`lots-nstru export: ${result.xlsxPath}`);
  console.log(`rows=${result.rows} codes=${result.codes} months=${result.months.join(",")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
