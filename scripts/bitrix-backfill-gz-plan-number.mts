import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { BitrixClient } from "../src/bitrix/client.js";
import {
  GZ_CANONICAL_PLAN_PAGE_DIR,
  canonicalPlanPageFileName,
  extractGzPlanNumberFromHeading,
  verifyCanonicalPlanPageUrl
} from "../src/kz/gzCanonicalPlanPage.js";
import {
  GZ_PLAN_ORIGINATOR_IDS,
  buildGzPlanNumberUpdate,
  canExecuteGzPlanNumberBackfill,
  decideGzPlanNumberWrite,
  isGzPlanNumberBackfillCandidate,
  planGzPlanNumberBackfill,
  type GzBackfillDeal,
  type GzPlanNumberReportEntry,
  type GzPlanNumberUnresolved
} from "../src/bitrix/gzPlanNumberBackfill.js";

dotenv.config();

const REPORT_DIR = "data";
const PAGE_LOAD_TIMEOUT_MS = 90_000;
const FETCH_RETRIES = 2;
const FETCH_DELAY_MS = 1_500;

const DEAL_SELECT = [
  "ID", "TITLE", "CATEGORY_ID", "STAGE_ID", "ORIGINATOR_ID", "ORIGIN_ID",
  "UF_CRM_PLAN_ID", "UF_CRM_PLAN_LINK", "UF_CRM_1782386571874_IU_XLS"
];

interface CliArgs {
  execute: boolean;
  reportPath: string | null;
  headless: boolean;
}

interface Report {
  schemaVersion: 2;
  createdAt: string;
  candidates: number;
  resolved: GzPlanNumberReportEntry[];
  unresolved: GzPlanNumberUnresolved[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, reportPath: null, headless: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--execute") args.execute = true;
    else if (argv[i] === "--report") args.reportPath = argv[++i] ?? null;
    else if (argv[i] === "--headed") args.headless = false;
  }
  return args;
}

async function listGzDeals(client: BitrixClient): Promise<GzBackfillDeal[]> {
  const deals: GzBackfillDeal[] = [];
  for (const originatorId of GZ_PLAN_ORIGINATOR_IDS) {
    const rows = await client.listAll("deal", { ORIGINATOR_ID: originatorId }, DEAL_SELECT);
    deals.push(...rows as GzBackfillDeal[]);
  }
  return deals;
}

/**
 * Every candidate gets its own page load, keyed and cached by its canonical
 * point. The legacy `data/debug` cache is never read: its file names come from
 * the second `show_plan` segment, which several canonical points share.
 */
async function fetchCanonicalPages(
  plan: ReturnType<typeof planGzPlanNumberBackfill>,
  headless: boolean
): Promise<{ resolved: GzPlanNumberReportEntry[]; unresolved: GzPlanNumberUnresolved[] }> {
  const resolved: GzPlanNumberReportEntry[] = [];
  const unresolved: GzPlanNumberUnresolved[] = [...plan.unresolved];
  if (plan.pending.length === 0) return { resolved, unresolved };

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ locale: "ru-RU", viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    for (const target of plan.pending) {
      let load: { finalUrl: string; html: string | null; error?: string } = {
        finalUrl: "",
        html: null,
        error: "unknown error"
      };
      for (let attempt = 0; attempt <= FETCH_RETRIES && load.html == null; attempt++) {
        try {
          await page.goto(target.planLink, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
          await page.waitForTimeout(FETCH_DELAY_MS);
          load = { finalUrl: page.url(), html: await page.content() };
        } catch (error) {
          load = { finalUrl: "", html: null, error: error instanceof Error ? error.message : String(error) };
          if (attempt < FETCH_RETRIES) await page.waitForTimeout(FETCH_DELAY_MS);
        }
      }

      const reject = (reason: string): void => {
        unresolved.push({ dealId: target.dealId, canonicalPlanPointId: target.canonicalPlanPointId, reason });
        console.log(`  deal ${target.dealId}: ${reason}`);
      };

      if (load.html == null) {
        reject(`page did not load: ${load.error ?? "unknown error"}`);
        continue;
      }
      const urlVerdict = verifyCanonicalPlanPageUrl(load.finalUrl, target.canonicalPlanPointId);
      if (!urlVerdict.ok) {
        reject(urlVerdict.reason ?? "final url did not match the requested point");
        continue;
      }
      const planNumber = extractGzPlanNumberFromHeading(load.html);
      if (!planNumber) {
        reject("canonical page carries no single numbered heading");
        continue;
      }

      fs.mkdirSync(GZ_CANONICAL_PLAN_PAGE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(GZ_CANONICAL_PLAN_PAGE_DIR, canonicalPlanPageFileName(target.canonicalPlanPointId)),
        load.html,
        "utf8"
      );

      console.log(`  deal ${target.dealId}: point ${target.canonicalPlanPointId} -> plan number ${planNumber}`);
      resolved.push({
        dealId: target.dealId,
        canonicalPlanPointId: target.canonicalPlanPointId,
        planNumber,
        source: "canonical-page",
        stageId: target.stageId
      });
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return { resolved, unresolved };
}

function writeReport(
  plan: { resolved: GzPlanNumberReportEntry[]; unresolved: GzPlanNumberUnresolved[] },
  candidates: number
): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const file = path.join(REPORT_DIR, `gz-plan-number-backfill-${stamp}.json`);
  const report: Report = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    candidates,
    resolved: plan.resolved,
    unresolved: plan.unresolved
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

async function runDryRun(client: BitrixClient, args: CliArgs): Promise<number> {
  const deals = await listGzDeals(client);
  const candidates = deals.filter(isGzPlanNumberBackfillCandidate);
  console.log(`gz plan number backfill: mode=dry-run originators=${GZ_PLAN_ORIGINATOR_IDS.join(",")}`);
  console.log(`deals=${deals.length} candidates=${candidates.length}`);

  const plan = planGzPlanNumberBackfill(deals);
  console.log(`canonical page loads=${plan.pending.length} unusable link=${plan.unresolved.length}`);

  const fetched = await fetchCanonicalPages(plan, args.headless);
  const file = writeReport(fetched, candidates.length);

  console.log(`resolved=${fetched.resolved.length} unresolved=${fetched.unresolved.length}`);
  for (const entry of fetched.unresolved) {
    console.log(`  [unresolved] deal ${entry.dealId} point ${entry.canonicalPlanPointId || "-"}: ${entry.reason}`);
  }
  console.log(`report: ${file}`);

  if (candidates.length === 0) {
    console.log("nothing to backfill: every GZ plans deal already carries a plan number");
    return 0;
  }

  const verdict = canExecuteGzPlanNumberBackfill(fetched);
  console.log(verdict.ok
    ? `execute allowed: npx tsx scripts/bitrix-backfill-gz-plan-number.mts --execute --report ${file}`
    : `execute BLOCKED: ${verdict.reason}`);
  // Only an unresolved candidate is a failure; an empty set means the work is done.
  return fetched.unresolved.length > 0 ? 1 : 0;
}

async function runExecute(client: BitrixClient, args: CliArgs): Promise<number> {
  if (!args.reportPath) throw new Error("--execute requires --report <path to dry-run report>");
  const report = JSON.parse(fs.readFileSync(args.reportPath, "utf8")) as Report;

  const verdict = canExecuteGzPlanNumberBackfill(report);
  if (!verdict.ok) {
    console.error(`execute refused: ${verdict.reason}`);
    return 1;
  }

  console.log(`gz plan number backfill: mode=execute report=${args.reportPath} entries=${report.resolved.length}`);
  let written = 0;
  let skipped = 0;
  const drifted: string[] = [];
  const failed: string[] = [];

  for (const entry of report.resolved) {
    let deal: GzBackfillDeal | null;
    try {
      deal = (await client.call("crm.deal.get", { id: entry.dealId })) as GzBackfillDeal | null;
    } catch (error) {
      failed.push(`${entry.dealId} (read: ${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (!deal) {
      drifted.push(`${entry.dealId} (deal no longer exists)`);
      continue;
    }

    const decision = decideGzPlanNumberWrite(entry, deal);
    if (decision.action === "drift") {
      drifted.push(`${entry.dealId} (${decision.reason})`);
      continue;
    }
    if (decision.action === "skip-filled") {
      skipped++;
      continue;
    }

    try {
      await client.update("deal", entry.dealId, buildGzPlanNumberUpdate(entry.planNumber));
      written++;
    } catch (error) {
      failed.push(`${entry.dealId} (update: ${error instanceof Error ? error.message : String(error)})`);
    }
  }

  console.log(`written=${written} skipped_already_filled=${skipped} drifted=${drifted.length} failed=${failed.length}`);
  for (const item of drifted) console.log(`  [drift] ${item}`);
  for (const item of failed) console.log(`  [failed] ${item}`);
  return failed.length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
  if (!webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is not configured");

  const client = new BitrixClient(webhookUrl);
  process.exitCode = args.execute ? await runExecute(client, args) : await runDryRun(client, args);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
