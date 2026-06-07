import dotenv from "dotenv";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { collectStatGovForBins } from "../src/kz/statGovCollector.js";
import { collectTendersForBins } from "../src/kz/tendersPipeline.js";

dotenv.config();

interface Args {
  csvFile: string | null;
  skipStat: boolean;
  skipTenders: boolean;
  delayMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    csvFile: null,
    skipStat: argv.includes("--skip-stat"),
    skipTenders: argv.includes("--skip-tenders"),
    delayMs: 2000
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
    console.error("Usage: npx tsx scripts/kz-enrich.ts bins.csv [--skip-stat] [--skip-tenders] [--delay-ms 2000]");
    process.exit(1);
  }

  const bins = readBinsFromCsv(args.csvFile);
  let statSummary = "skipped";
  let tenderSummary = "skipped";

  if (!args.skipStat) {
    const stat = await collectStatGovForBins(bins, { delayMs: args.delayMs });
    statSummary = `processed=${stat.processed} success=${stat.success} failed=${stat.failed} skipped=${stat.skipped}`;
  }

  if (!args.skipTenders) {
    const tenders = await collectTendersForBins(bins, { delayMs: args.delayMs });
    tenderSummary =
      `processed=${tenders.processed} zakup=${tenders.zakupCount} ` +
      `goszakup=${tenders.goszakupCount} total=${tenders.totalTenders} skipped=${tenders.skipped}`;
  }

  console.log("KZ enrich summary");
  console.log(`stat: ${statSummary}`);
  console.log(`tenders: ${tenderSummary}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
