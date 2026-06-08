import dotenv from "dotenv";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { collectGoszakupRegistryForBins } from "../src/kz/goszakupRegistryCollector.js";

dotenv.config();

interface Args {
  csvFile: string | null;
  delayMs: number;
  forceRefresh: boolean;
  headless: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    csvFile: null,
    delayMs: 2000,
    forceRefresh: argv.includes("--force-refresh"),
    headless: !argv.includes("--headed")
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--delay-ms") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value)) args.delayMs = value;
      i++;
      continue;
    }
    if (!arg.startsWith("--") && args.csvFile === null) {
      args.csvFile = arg;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.csvFile) {
    console.error("Usage: npx tsx scripts/goszakup-registry-collector.ts bins.csv [--force-refresh] [--delay-ms 2000] [--headed]");
    process.exit(1);
  }

  const bins = readBinsFromCsv(args.csvFile);
  const stats = await collectGoszakupRegistryForBins(bins, {
    delayMs: args.delayMs,
    forceRefresh: args.forceRefresh,
    headless: args.headless
  });

  console.log(`registry: processed=${stats.processed} success=${stats.success} not_found=${stats.not_found} cached=${stats.cached} failed=${stats.failed} skipped=${stats.skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
