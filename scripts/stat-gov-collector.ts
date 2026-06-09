import { readBinsFromCsv } from "../src/kz/csv.js";
import { collectStatGovForBins } from "../src/kz/statGovCollector.js";

async function main(): Promise<void> {
  const csvFile = process.argv[2];
  if (!csvFile) {
    console.error("Usage: npx tsx scripts/stat-gov-collector.ts bins.csv");
    process.exit(1);
  }

  const bins = readBinsFromCsv(csvFile);
  const stats = await collectStatGovForBins(bins);
  console.log(`stat.gov: processed=${stats.processed} success=${stats.success} failed=${stats.failed} skipped=${stats.skipped} cached=${stats.cached}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
