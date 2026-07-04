import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { BitrixClient } from "../src/bitrix/client.js";
import {
  DEFAULT_OLD_XLS_ORIGINATOR_ID,
  buildDuplicateArchiveFields,
  findGzDuplicatePairs,
  stageMatchesDealCategory,
  type DuplicateHygieneDeal,
  type GzDuplicatePair
} from "../src/bitrix/gzDuplicateHygiene.js";
import { GZ_ORIGINATOR_ID } from "../src/bitrix/gzLeadCleanup.js";
import { GZ_PLAN_LINK_FIELD, GZ_PLAN_POINT_ID_FIELD } from "../src/bitrix/gzOriginBackfill.js";

dotenv.config();

interface CliArgs {
  execute: boolean;
  limit: number | null;
  webhookUrl: string | null;
  delayMs: number | null;
  oldOriginatorIds: Set<string>;
  archiveStageId: string | null;
  reportPath: string | null;
}

interface DuplicateHygieneReport {
  mode: "dry-run" | "execute";
  oldOriginatorIds: string[];
  archiveStageId: string | null;
  pairs: GzDuplicatePair[];
  archived: Array<{ oldDealId: string; keyedDealId: string; originId: string }>;
  failed: Array<{ oldDealId: string; keyedDealId: string; originId: string; message: string }>;
  skippedMutationReason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const USAGE = `Usage: tsx scripts/bitrix-gz-duplicate-hygiene.mts [options]

Reports real GZ duplicate deal pairs: an old XLS-copy deal and a keyed deal with
the same gz-plan:<planId>. Dry-run by default; keyed deals are never mutated.

Options:
  --execute                 archive old XLS-copy deals (requires --archive-stage-id)
  --archive-stage-id <id>   Bitrix deal stage to set on old duplicate copies
  --old-originator <id>     old import originator to target (repeatable; default ${DEFAULT_OLD_XLS_ORIGINATOR_ID})
  --limit <n>               archive only first n pairs in execute mode
  --report <path>           write JSON report
  --webhook-url <url>       Bitrix24 inbound webhook (default: env BITRIX24_WEBHOOK_URL)
  --delay-ms <n>            minimum delay between REST calls (default: 500)`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    execute: false,
    limit: null,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    delayMs: null,
    oldOriginatorIds: new Set<string>(),
    archiveStageId: null,
    reportPath: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--archive-stage-id") args.archiveStageId = argv[++i]?.trim() || null;
    else if (arg === "--old-originator") {
      const originator = argv[++i]?.trim();
      if (originator) args.oldOriginatorIds.add(originator);
    } else if (arg === "--limit") args.limit = parsePositiveInt(argv[++i]);
    else if (arg === "--report") args.reportPath = argv[++i] ?? null;
    else if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else if (arg === "--delay-ms") args.delayMs = parsePositiveInt(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (args.oldOriginatorIds.size === 0) {
    args.oldOriginatorIds.add(DEFAULT_OLD_XLS_ORIGINATOR_ID);
  }

  return args;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) {
    throw new Error("Bitrix webhook URL is required: set BITRIX24_WEBHOOK_URL or pass --webhook-url");
  }

  const client = new BitrixClient(args.webhookUrl, {
    requestDelayMs: args.delayMs ?? undefined
  });
  const startedAt = new Date().toISOString();

  console.log(
    `gz duplicate hygiene: mode=${args.execute ? "execute" : "dry-run"} old_originators=${[...args.oldOriginatorIds].join(",")}`
      + `${args.archiveStageId ? ` archive_stage=${args.archiveStageId}` : ""}`
  );

  const keyedDeals = await client.listAll(
    "deal",
    { ORIGINATOR_ID: GZ_ORIGINATOR_ID },
    ["ID", "TITLE", "ORIGINATOR_ID", "ORIGIN_ID", "STAGE_ID", "CATEGORY_ID"]
  ) as DuplicateHygieneDeal[];
  const oldDeals = await client.listAll(
    "deal",
    { [`!${GZ_PLAN_LINK_FIELD}`]: "" },
    ["ID", "TITLE", "ORIGINATOR_ID", "ORIGIN_ID", "STAGE_ID", "CATEGORY_ID", GZ_PLAN_LINK_FIELD, GZ_PLAN_POINT_ID_FIELD]
  ) as DuplicateHygieneDeal[];
  const pairs = findGzDuplicatePairs([...keyedDeals, ...oldDeals], {
    oldOriginatorIds: args.oldOriginatorIds
  });

  console.log(`keyed_deals=${keyedDeals.length} old_candidates=${oldDeals.length} duplicate_pairs=${pairs.length}`);
  for (const pair of pairs.slice(0, 50)) {
    console.log(`[pair] old ${pair.oldDealId} -> keyed ${pair.keyedDealId} ${pair.originId}`);
  }
  if (pairs.length > 50) console.log(`[pair] ... ${pairs.length - 50} more`);

  const archiveFields = buildDuplicateArchiveFields(args.archiveStageId);
  const skippedMutationReason = args.execute && !archiveFields
    ? "execute requested but --archive-stage-id was not provided; report-only mode"
    : null;
  if (skippedMutationReason) console.warn(skippedMutationReason);

  const report: DuplicateHygieneReport = {
    mode: args.execute && archiveFields ? "execute" : "dry-run",
    oldOriginatorIds: [...args.oldOriginatorIds],
    archiveStageId: args.archiveStageId,
    pairs,
    archived: [],
    failed: [],
    skippedMutationReason,
    startedAt,
    finishedAt: null
  };

  const pairsToArchive = args.limit ? pairs.slice(0, args.limit) : pairs;
  if (args.execute && archiveFields) {
    for (const pair of pairsToArchive) {
      if (!stageMatchesDealCategory(args.archiveStageId ?? "", pair.oldCategoryId)) {
        const message = `archive stage ${args.archiveStageId} belongs to another pipeline; deal is in category ${pair.oldCategoryId}`;
        report.failed.push({
          oldDealId: pair.oldDealId,
          keyedDealId: pair.keyedDealId,
          originId: pair.originId,
          message
        });
        console.error(`[failed] old ${pair.oldDealId}: ${message}`);
        continue;
      }
      try {
        await client.update("deal", pair.oldDealId, archiveFields);
        report.archived.push({
          oldDealId: pair.oldDealId,
          keyedDealId: pair.keyedDealId,
          originId: pair.originId
        });
        console.log(`[archived] old ${pair.oldDealId} -> ${args.archiveStageId} (keyed ${pair.keyedDealId})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({
          oldDealId: pair.oldDealId,
          keyedDealId: pair.keyedDealId,
          originId: pair.originId,
          message
        });
        console.error(`[failed] old ${pair.oldDealId}: ${message}`);
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  if (args.reportPath) {
    fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
    fs.writeFileSync(args.reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`report=${args.reportPath}`);
  }

  console.log(`summary: pairs=${pairs.length} archived=${report.archived.length} failed=${report.failed.length}`);
  if (report.failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
