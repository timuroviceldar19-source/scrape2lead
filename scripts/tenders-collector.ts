import { readBinsFromCsv } from "../src/kz/csv.js";
import { collectTendersForBins } from "../src/kz/tendersPipeline.js";

function getDelayMs(args: string[]): number {
  const index = args.indexOf("--delay-ms");
  if (index === -1) return 2000;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : 2000;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvFile = args.find((arg) => !arg.startsWith("--"));
  if (!csvFile) {
    console.error("Usage: npx tsx scripts/tenders-collector.ts bins.csv [--delay-ms 2000]");
    process.exit(1);
  }

  const stats = await collectTendersForBins(readBinsFromCsv(csvFile), {
    delayMs: getDelayMs(args)
  });
  console.log(
    `tenders: processed=${stats.processed} zakup=${stats.zakupCount} ` +
    `goszakup=${stats.goszakupCount} total=${stats.totalTenders} skipped=${stats.skipped}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
