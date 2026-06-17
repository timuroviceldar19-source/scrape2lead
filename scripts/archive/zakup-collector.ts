// DEPRECATED: use scripts/tenders-collector.ts or npm run kz:tenders.
import { readBinsFromCsv } from "../../src/kz/csv.js";
import { collectTendersForBins } from "../../src/kz/tendersPipeline.js";

async function main(): Promise<void> {
  const csvFile = process.argv[2];
  if (!csvFile) {
    console.error("Usage: npx tsx scripts/zakup-collector.ts bins.csv");
    process.exit(1);
  }

  console.warn("scripts/zakup-collector.ts is deprecated; delegating to the unified tenders pipeline for zakup.sk.kz only.");
  const stats = await collectTendersForBins(readBinsFromCsv(csvFile), {
    skipGoszakup: true,
    delayMs: 2000
  });
  console.log(`zakup.sk.kz: processed=${stats.processed} tenders=${stats.zakupCount} skipped=${stats.skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
