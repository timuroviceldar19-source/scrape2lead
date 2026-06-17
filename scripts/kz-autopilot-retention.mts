import Database from "better-sqlite3";
import { KzStorage } from "../src/kz/kzStorage.js";
import {
  parseOutreachRetentionDays,
  pruneOutreachRuns
} from "../src/kz/outreachRetention.js";

const DB_PATH = process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";

function readDaysArg(argv: string[]): number | null {
  const index = argv.indexOf("--days");
  if (index === -1 || index + 1 >= argv.length) return null;
  return parseOutreachRetentionDays(argv[index + 1]);
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const retentionDays = readDaysArg(process.argv)
    ?? parseOutreachRetentionDays(process.env.KZ_OUTREACH_RUN_RETENTION_DAYS);

  if (retentionDays === null) {
    console.error(
      "outreach retention: disabled (set KZ_OUTREACH_RUN_RETENTION_DAYS or pass --days N)"
    );
    process.exitCode = 1;
    return;
  }

  const db = new Database(DB_PATH);
  const storage = new KzStorage({ db });
  try {
    const result = pruneOutreachRuns(db, { retentionDays, apply });
    const mode = result.dryRun ? "dry-run" : "apply";
    console.log(
      `outreach retention (${mode}): retentionDays=${result.retentionDays} `
      + `cutoff=${result.cutoffIso}`
    );
    console.log(
      `eligibleRuns=${result.eligibleRunIds.length} `
      + `skippedUnfinished=${result.skippedUnfinished} `
      + `prunedRuns=${result.prunedRuns} `
      + `detachedItems=${result.detachedItems}`
    );
    if (result.eligibleRunIds.length > 0) {
      console.log(`eligibleRunIds: ${result.eligibleRunIds.join(", ")}`);
    }
    if (result.dryRun && result.eligibleRunIds.length > 0) {
      console.log("pass --apply to prune eligible runs (outreach_seen and outreach_items are preserved)");
    }
  } finally {
    storage.close();
    db.close();
  }
}

main();
