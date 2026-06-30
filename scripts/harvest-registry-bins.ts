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
const SEARCH_TERMS = [
  "ТОО",
  "TOO",
  "Товарищество с ограниченной",
  ..."АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЫЭЮЯ".split("").map((c) => `ТОО ${c}`)
];

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
    for (const searchTerm of SEARCH_TERMS) {
      if (accepted.size >= targetCount) break;

      await page.goto(REGISTRY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);

      const searchInput = page.locator(
        'input[placeholder*="Наименование"], input[placeholder*="БИН"], input[name="search_bin"], input[name="bin_iin"]'
      );
      await searchInput.first().waitFor({ timeout: 10_000 });
      await searchInput.first().fill(searchTerm);
      await page.locator('button:has-text("Найти"), button[type="submit"]').first().click();
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1000);

      let pageNum = 0;
      while (accepted.size < targetCount && pageNum < 5) {
        pageNum++;
        const rows = parseRegistrySearchRows(await page.content());
        let addedOnPage = 0;

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
          addedOnPage++;
          if (accepted.size >= targetCount) break;
        }

        console.log(
          `term="${searchTerm}" page=${pageNum} rows=${rows.length} added=${addedOnPage} accepted=${accepted.size}/${targetCount}`
        );

        if (accepted.size >= targetCount) break;
        if (rows.length === 0) break;

        const hasNext = await goToNextResultsPage(page);
        if (!hasNext) break;
        await page.waitForTimeout(1200);
      }
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
        search_terms: SEARCH_TERMS,
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

async function goToNextResultsPage(page: import("playwright").Page): Promise<boolean> {
  const selectors = [
    'a.page-link:has-text("»")',
    'a:has-text("»")',
    'button:has-text("Следующая")',
    'a:has-text("Следующая")',
    'li.next:not(.disabled) a',
    '.pagination .active + li a'
  ];

  for (const selector of selectors) {
    const link = page.locator(selector).first();
    if ((await link.count()) === 0) continue;
    if (!(await link.isVisible().catch(() => false))) continue;
    await link.click();
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    return true;
  }

  return false;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
