import "dotenv/config";
import { fetchGoszakupTenders } from "../src/kz/goszakupCollector.js";
import { isValidBin } from "../src/kz/csv.js";

const bin = process.argv[2];

if (!bin) {
  console.error("Usage: npx tsx scripts/goszakup-smoke.ts <BIN>");
  process.exit(1);
}

if (!isValidBin(bin)) {
  console.error(`Invalid BIN: ${bin} (must be 12 digits)`);
  process.exit(1);
}

const token = process.env.GOSZAKUP_TOKEN;
if (!token) {
  console.error("GOSZAKUP_TOKEN is not set in .env");
  process.exit(1);
}

try {
  console.log(`Fetching goszakup tenders for BIN ${bin}...`);
  const result = await fetchGoszakupTenders(bin, {
    token,
    activeOnly: true
  });

  console.log(`Pages: ${result.pages}`);
  console.log(`Raw items: ${result.raw}`);
  console.log(`Accepted (active): ${result.tenders.length}`);
  console.log(`Filtered out: ${result.filtered}`);

  if (result.tenders.length > 0) {
    console.log("\nFirst 3 tenders:");
    const preview = result.tenders.slice(0, 3);
    for (const t of preview) {
      console.log(JSON.stringify(t, null, 2));
    }
  }

  process.exit(0);
} catch (error) {
  console.error("Smoke test failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
