/**
 * Harvest ТОО BINs from goszakup public supplier registry (no token).
 * Usage: npx tsx scripts/harvest-registry-bins.ts [count] [out.csv]
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { validateHarvestCandidate } from "../src/kz/binValidation.js";
import { parseRegistrySearchRows } from "../src/kz/harvestRegistryParser.js";

const REGISTRY_URL = "https://goszakup.gov.kz/ru/registry/supplierreg";
const SEARCH_TERM = "ТОО";

interface HarvestStats {
  scanned: number;
  accepted: number;
  rejected: Record<string, number>;
}

async function main(): Promise<void> {
  const targetCount = Math.max(1, Number(process.argv[2]) || 50);
  const outPath = process.argv[3] ?? "bins-batch-50.csv";
  const metaPath = outPath.replace(/\.csv$/i, "-meta.json");

  const accepted = new Map<string, { bin: string; name: string; participant_id: string | null }>();
  const stats: HarvestStats = { scanned: 0, accepted: 0, rejected: {} };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    let pageNum = 0;
    while (accepted.size < targetCount && pageNum < 10) {
      pageNum++;
      await page.goto(REGISTRY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);

      const searchInput = page.locator(
        'input[placeholder*="Наименование"], input[placeholder*="БИН"], input[name="search_bin"], input[name="bin_iin"]'
      );
      await searchInput.first().waitFor({ timeout: 10_000 });
      await searchInput.first().fill(SEARCH_TERM);
      await page.locator('button:has-text("Найти"), button[type="submit"]').first().click();
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1000);

      const rows = parseRegistrySearchRows(await page.content());
      for (const row of rows) {
        if (accepted.has(row.bin)) continue;
        stats.scanned++;
        const verdict = validateHarvestCandidate(row);
        if (!verdict.accepted) {
          const reason = verdict.reason ?? "unknown";
          stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
          continue;
        }
        accepted.set(row.bin, row);
        stats.accepted++;
        if (accepted.size >= targetCount) break;
      }

      console.log(
        `page=${pageNum} scanned=${stats.scanned} accepted=${accepted.size}/${targetCount} rejected=${JSON.stringify(stats.rejected)}`
      );

      // Single search page usually enough for 50; break if no new rows
      if (rows.length === 0) break;
      break;
    }
  } finally {
    await browser.close();
  }

  const list = Array.from(accepted.values()).slice(0, targetCount);
  if (list.length < targetCount) {
    console.warn(`Warning: only ${list.length} validated ТОО BINs (target ${targetCount})`);
  }

  const csv = ["bin", ...list.map((r) => r.bin)].join("\n") + "\n";
  fs.mkdirSync(path.dirname(outPath) || ".", { recursive: true });
  fs.writeFileSync(outPath, csv, "utf8");
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        search_term: SEARCH_TERM,
        target_count: targetCount,
        accepted_count: list.length,
        stats,
        companies: list
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Wrote ${list.length} BINs to ${outPath}`);
  console.log(`Meta: ${metaPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
