import dotenv from "dotenv";
import { BitrixClient } from "../src/bitrix/client.js";
import { GZ_ORIGINATOR_ID } from "../src/bitrix/gzLeadCleanup.js";
import {
  buildBackfillFields,
  decideBackfillAction,
  GZ_PLAN_LINK_FIELD,
  GZ_PLAN_POINT_ID_FIELD,
  type BackfillCandidateDeal
} from "../src/bitrix/gzOriginBackfill.js";

dotenv.config();

interface CliArgs {
  execute: boolean;
  limit: number | null;
  webhookUrl: string | null;
  claimOriginators: Set<string>;
}

const USAGE = `Usage: tsx scripts/bitrix-backfill-gz-origin.mts [--execute] [--limit <n>] [--claim-foreign <originatorId>] [--webhook-url <url>]

Stamps ORIGINATOR_ID/ORIGIN_ID (gz-plan:<planId>) onto legacy GZ deals that have
a goszakup plan link (${GZ_PLAN_LINK_FIELD}) but no origin key. Dry-run by default.
--claim-foreign (repeatable) also re-keys deals created by the given originator
(e.g. app_iu_xls_import) when their ORIGIN_ID is empty.`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    execute: false,
    limit: null,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    claimOriginators: new Set<string>()
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--limit") args.limit = Number.parseInt(argv[++i] ?? "", 10) || null;
    else if (arg === "--claim-foreign") {
      const originator = argv[++i]?.trim();
      if (originator) args.claimOriginators.add(originator);
    }
    else if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) {
    throw new Error("Bitrix webhook URL is required: set BITRIX24_WEBHOOK_URL or pass --webhook-url");
  }
  const client = new BitrixClient(args.webhookUrl);

  console.log(`gz origin backfill: mode=${args.execute ? "execute" : "dry-run"}${args.limit ? ` limit=${args.limit}` : ""}${args.claimOriginators.size ? ` claim_foreign=${[...args.claimOriginators].join(",")}` : ""}`);

  const keyed = await client.listAll(
    "deal",
    { ORIGINATOR_ID: GZ_ORIGINATOR_ID },
    ["ID", "ORIGIN_ID"]
  );
  const claimedOrigins = new Map<string, string>();
  for (const deal of keyed) {
    const originId = String(deal.ORIGIN_ID ?? "").trim();
    if (originId && !claimedOrigins.has(originId)) claimedOrigins.set(originId, String(deal.ID ?? ""));
  }
  console.log(`keyed deals with ${GZ_ORIGINATOR_ID}: ${keyed.length}`);

  const candidates = await client.listAll(
    "deal",
    { [`!${GZ_PLAN_LINK_FIELD}`]: "" },
    ["ID", "TITLE", "ORIGINATOR_ID", "ORIGIN_ID", GZ_PLAN_LINK_FIELD, GZ_PLAN_POINT_ID_FIELD]
  ) as BackfillCandidateDeal[];
  console.log(`deals with a plan link: ${candidates.length}`);

  const counts = { backfill: 0, "already-keyed": 0, "foreign-origin": 0, "no-plan-id": 0, conflict: 0, failed: 0 };
  let processed = 0;

  for (const deal of candidates) {
    const decision = decideBackfillAction(deal, claimedOrigins, { claimOriginators: args.claimOriginators });
    counts[decision.action] += 1;
    const dealId = String(deal.ID ?? "");

    if (decision.action === "conflict") {
      console.log(`[conflict] deal ${dealId} -> ${decision.originId} already on deal ${decision.claimedByDealId} (CRM duplicate, merge manually)`);
      continue;
    }
    if (decision.action === "no-plan-id") {
      console.log(`[no-plan-id] deal ${dealId}: cannot derive plan id from ${GZ_PLAN_LINK_FIELD}`);
      continue;
    }
    if (decision.action !== "backfill") continue;

    if (args.limit && processed >= args.limit) {
      counts.backfill -= 1;
      continue;
    }
    processed += 1;

    if (!args.execute) {
      console.log(`[dry-run] deal ${dealId} <- ${decision.originId}`);
      continue;
    }

    try {
      await client.update("deal", dealId, buildBackfillFields(decision.planId));
      claimedOrigins.set(decision.originId, dealId);
      console.log(`[stamped] deal ${dealId} <- ${decision.originId}`);
    } catch (error) {
      counts.backfill -= 1;
      counts.failed += 1;
      console.error(`[failed] deal ${dealId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`summary: backfill=${counts.backfill} already_keyed=${counts["already-keyed"]} foreign_origin=${counts["foreign-origin"]} no_plan_id=${counts["no-plan-id"]} conflicts=${counts.conflict} failed=${counts.failed}`);
  if (counts.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
