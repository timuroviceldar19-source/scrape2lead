import "dotenv/config";
import { collectZakupTendersForBatch } from "../src/kz/zakupCollector.js";
import { isValidBin } from "../src/kz/csv.js";
import { normalizeCompanyName } from "../src/kz/normalizeCompanyName.js";

const bin = process.argv[2];
const companyNameArg = process.argv[3];

if (!bin) {
  console.error("Usage: npx tsx scripts/zakup-smoke.ts <BIN> [company name]");
  process.exit(1);
}

if (!isValidBin(bin)) {
  console.error(`Invalid BIN: ${bin} (must be 12 digits)`);
  process.exit(1);
}

const companyName = companyNameArg ?? `Company ${bin}`;
const searchName = normalizeCompanyName(companyName);

console.log(`BIN: ${bin}`);
console.log(`Company: ${companyName}`);
console.log(`Search: ${searchName}`);
console.log(`Retries: ${process.env.ZAKUP_MAX_RETRIES ?? 3}`);
console.log("---");

try {
  const result = await collectZakupTendersForBatch(
    [{ bin, companyName }],
    { headless: false, maxRetries: Number(process.env.ZAKUP_MAX_RETRIES ?? 3) }
  );

  console.log(`Processed: ${result.processed}`);
  console.log(`Accepted: ${result.accepted}`);
  console.log(`Filtered: ${result.filtered}`);
  console.log(`Failed: ${result.failed}`);

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const e of result.errors) {
      console.log(`  ${e.bin}: ${e.message}`);
    }
  }

  if (result.tenders.length > 0) {
    console.log("\nAccepted tenders:");
    for (const t of result.tenders) {
      console.log(JSON.stringify(t, null, 2));
    }
  }

  process.exit(result.failed > 0 ? 1 : 0);
} catch (error) {
  console.error("Smoke test crashed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
