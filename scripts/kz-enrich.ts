import dotenv from "dotenv";
import { formatKzEnrichResult, runKzEnrich } from "../src/kz/enrichPipeline.js";

dotenv.config();

interface Args {
  csvFile: string | null;
  skipStat: boolean;
  skipTenders: boolean;
  delayMs: number;
  forceRefresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    csvFile: null,
    skipStat: argv.includes("--skip-stat"),
    skipTenders: argv.includes("--skip-tenders"),
    delayMs: 2000,
    forceRefresh: argv.includes("--force-refresh")
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
    console.error("Usage: npx tsx scripts/kz-enrich.ts bins.csv [--skip-stat] [--skip-tenders] [--delay-ms 2000] [--force-refresh]");
    process.exit(1);
  }

  const result = await runKzEnrich({
    csvFile: args.csvFile,
    skipStat: args.skipStat,
    skipTenders: args.skipTenders,
    delayMs: args.delayMs,
    forceRefresh: args.forceRefresh
  });
  console.log(formatKzEnrichResult(result));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
