import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { chromium } from "playwright";
import {
  GZ_PLAN_ORIGINATOR_IDS,
  buildGzPlanNumberUpdate,
  canExecuteGzPlanNumberBackfill,
  decideGzPlanNumberWrite,
  extractGzPlanNumberFromHeading,
  getGzPlanLink,
  isGzPlanNumberBackfillCandidate,
  planGzPlanNumberBackfill,
  resolveGzPlanNumberSource,
  type GzBackfillDeal,
  type GzPlanNumberPlan,
  type GzPlanNumberReportEntry
} from "../src/bitrix/gzPlanNumberBackfill.js";

dotenv.config();

const DEBUG_DIR = "data/debug";
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
  schemaVersion: 1;
  createdAt: string;
  candidates: number;
  resolved: GzPlanNumberReportEntry[];
  unresolved: GzPlanNumberPlan["unresolved"];
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

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
    const payload = await response.json() as { result?: unknown; next?: number; error_description?: string; error?: string };
    if (payload.error) throw new Error(`${payload.error}: ${payload.error_description ?? ""}`);
    return payload;
  }

  async listGzDeals(): Promise<GzBackfillDeal[]> {
    const deals: GzBackfillDeal[] = [];
    for (const originatorId of GZ_PLAN_ORIGINATOR_IDS) {
      let start = 0;
      for (;;) {
        const page = await this.call("crm.deal.list", {
          filter: { ORIGINATOR_ID: originatorId },
          select: DEAL_SELECT,
          start
        }) as { result: GzBackfillDeal[]; next?: number };
        deals.push(...page.result);
        if (page.next == null) break;
        start = page.next;
      }
    }
    return deals;
  }

  async getDeal(id: string): Promise<GzBackfillDeal | null> {
    const payload = await this.call("crm.deal.get", { id }) as { result?: GzBackfillDeal };
    return payload.result ?? null;
  }

  async updateDeal(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.call("crm.deal.update", { id, fields });
  }
}

function readSnapshot(snapshotId: string): string | null {
  const file = path.join(DEBUG_DIR, `goszakup-plan-detail-${snapshotId}.html`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

async function fetchMissingPages(
  plan: GzPlanNumberPlan,
  deals: readonly GzBackfillDeal[],
  headless: boolean
): Promise<GzPlanNumberPlan> {
  if (plan.unresolved.length === 0) return plan;

  const byId = new Map(deals.map((deal) => [String(deal.ID ?? ""), deal]));
  const resolved = [...plan.resolved];
  const stillUnresolved: GzPlanNumberPlan["unresolved"] = [];

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ locale: "ru-RU", viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    for (const pending of plan.unresolved) {
      const deal = byId.get(pending.dealId);
      const url = deal ? getGzPlanLink(deal) : "";
      const source = deal ? resolveGzPlanNumberSource(deal) : null;
      if (!deal || !url || !source) {
        stillUnresolved.push({ ...pending, reason: "no usable plan link" });
        continue;
      }

      let planNumber: string | null = null;
      for (let attempt = 0; attempt <= FETCH_RETRIES && !planNumber; attempt++) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
          await page.waitForTimeout(FETCH_DELAY_MS);
          const html = await page.content();
          planNumber = extractGzPlanNumberFromHeading(html);
          if (planNumber) {
            const cacheId = source.snapshotId ?? source.canonicalPlanPointId;
            fs.mkdirSync(DEBUG_DIR, { recursive: true });
            fs.writeFileSync(path.join(DEBUG_DIR, `goszakup-plan-detail-${cacheId}.html`), html, "utf8");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`  deal ${pending.dealId}: fetch attempt ${attempt + 1} failed: ${message}`);
          if (attempt < FETCH_RETRIES) await page.waitForTimeout(FETCH_DELAY_MS);
        }
      }

      if (!planNumber) {
        stillUnresolved.push({ ...pending, reason: "no numbered heading after live fetch" });
        continue;
      }

      console.log(`  deal ${pending.dealId}: point ${source.canonicalPlanPointId} -> plan number ${planNumber} (live)`);
      resolved.push({
        dealId: pending.dealId,
        canonicalPlanPointId: source.canonicalPlanPointId,
        planNumber,
        source: "playwright",
        stageId: String(deal.STAGE_ID ?? "").trim()
      });
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return { resolved, unresolved: stillUnresolved };
}

function writeReport(plan: GzPlanNumberPlan, candidates: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const file = path.join(REPORT_DIR, `gz-plan-number-backfill-${stamp}.json`);
  const report: Report = {
    schemaVersion: 1,
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
  const deals = await client.listGzDeals();
  const candidates = deals.filter(isGzPlanNumberBackfillCandidate);
  console.log(`gz plan number backfill: mode=dry-run originators=${GZ_PLAN_ORIGINATOR_IDS.join(",")}`);
  console.log(`deals=${deals.length} candidates=${candidates.length}`);

  const local = planGzPlanNumberBackfill(deals, { readSnapshot });
  console.log(`local snapshots resolved=${local.resolved.length} need live fetch=${local.unresolved.length}`);

  const plan = await fetchMissingPages(local, deals, args.headless);
  const file = writeReport(plan, candidates.length);

  const bySource = plan.resolved.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.source] = (acc[entry.source] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`resolved=${plan.resolved.length} ${JSON.stringify(bySource)} unresolved=${plan.unresolved.length}`);
  for (const entry of plan.unresolved) {
    console.log(`  [unresolved] deal ${entry.dealId} point ${entry.canonicalPlanPointId || "-"}: ${entry.reason}`);
  }
  console.log(`report: ${file}`);

  if (candidates.length === 0) {
    console.log("nothing to backfill: every GZ plans deal already carries a plan number");
    return 0;
  }

  const verdict = canExecuteGzPlanNumberBackfill(plan);
  console.log(verdict.ok
    ? `execute allowed: npx tsx scripts/bitrix-backfill-gz-plan-number.mts --execute --report ${file}`
    : `execute BLOCKED: ${verdict.reason}`);
  // Only an unresolved candidate is a failure; an empty set means the work is done.
  return plan.unresolved.length > 0 ? 1 : 0;
}

async function runExecute(client: BitrixClient, args: CliArgs): Promise<number> {
  if (!args.reportPath) throw new Error("--execute requires --report <path to dry-run report>");
  const report = JSON.parse(fs.readFileSync(args.reportPath, "utf8")) as Report;

  const verdict = canExecuteGzPlanNumberBackfill({ resolved: report.resolved, unresolved: report.unresolved });
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
      deal = await client.getDeal(entry.dealId);
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
      await client.updateDeal(entry.dealId, buildGzPlanNumberUpdate(entry.planNumber));
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
