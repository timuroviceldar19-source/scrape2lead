import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { chromium, type Browser, type Page } from "playwright";
import { BitrixClient } from "../src/bitrix/client.js";
import {
  GZ_CANONICAL_PLAN_PAGE_DIR,
  canonicalPlanPageFileName
} from "../src/kz/gzCanonicalPlanPage.js";
import { getGzPlanLink, resolveGzPlanNumberSource, type GzBackfillDeal } from "../src/bitrix/gzPlanNumberBackfill.js";
import {
  canExecuteGzPlanNumberCorrection,
  classifyGzPlanNumberCorrection,
  detectGzPlanControlDrift,
  executeGzPlanNumberCorrection,
  planGzPlanNumberReplacements,
  summarizeGzPlanNumberCorrection,
  type GzPlanNumberCorrectionEntry,
  type GzPlanNumberCorrectionReport,
  type GzPlanNumberCorrectionUnresolved
} from "../src/bitrix/gzPlanNumberCorrection.js";

dotenv.config();

const REPORT_DIR = "data";
const PAGE_LOAD_TIMEOUT_MS = 90_000;
const FETCH_RETRIES = 2;
const FETCH_DELAY_MS = 1_500;

/** The 20260715 report this pass corrects: schema 1, `source` per entry. */
interface LegacyBackfillReport {
  schemaVersion: 1;
  createdAt: string;
  candidates: number;
  resolved: { dealId: string; canonicalPlanPointId: string; planNumber: string; source: string }[];
  unresolved: unknown[];
}

interface CliArgs {
  mode: "verify" | "execute" | "audit";
  sourcePath: string | null;
  reportPath: string | null;
  headless: boolean;
}

interface PageLoad {
  finalUrl: string;
  html: string | null;
  error?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "verify", sourcePath: null, reportPath: null, headless: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--execute") args.mode = "execute";
    else if (argv[i] === "--audit") args.mode = "audit";
    else if (argv[i] === "--source") args.sourcePath = argv[++i] ?? null;
    else if (argv[i] === "--report") args.reportPath = argv[++i] ?? null;
    else if (argv[i] === "--headed") args.headless = false;
  }
  return args;
}

async function readDeal(client: BitrixClient, id: string): Promise<GzBackfillDeal | null> {
  const result = await client.call("crm.deal.get", { id });
  return (result as GzBackfillDeal | null) ?? null;
}

async function readDeals(client: BitrixClient, ids: readonly string[]): Promise<Map<string, GzBackfillDeal>> {
  const deals = new Map<string, GzBackfillDeal>();
  for (const id of ids) {
    const deal = await readDeal(client, id);
    if (deal) deals.set(id, deal);
  }
  return deals;
}

async function loadCanonicalPage(page: Page, url: string): Promise<PageLoad> {
  let lastError = "unknown error";
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForTimeout(FETCH_DELAY_MS);
      return { finalUrl: page.url(), html: await page.content() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < FETCH_RETRIES) await page.waitForTimeout(FETCH_DELAY_MS);
    }
  }
  return { finalUrl: "", html: null, error: lastError };
}

async function withBrowser<T>(headless: boolean, run: (page: Page) => Promise<T>): Promise<T> {
  const browser: Browser = await chromium.launch({ headless });
  const context = await browser.newContext({ locale: "ru-RU", viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  try {
    return await run(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

function saveCanonicalPage(canonicalPlanPointId: string, html: string): void {
  fs.mkdirSync(GZ_CANONICAL_PLAN_PAGE_DIR, { recursive: true });
  const file = path.join(GZ_CANONICAL_PLAN_PAGE_DIR, canonicalPlanPageFileName(canonicalPlanPointId));
  fs.writeFileSync(file, html, "utf8");
}

function writeCorrectionReport(report: GzPlanNumberCorrectionReport): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const file = path.join(REPORT_DIR, `gz-plan-number-correction-${stamp}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

function readCorrectionReport(file: string): GzPlanNumberCorrectionReport {
  return JSON.parse(fs.readFileSync(file, "utf8")) as GzPlanNumberCorrectionReport;
}

function printSummary(report: GzPlanNumberCorrectionReport): void {
  const summary = summarizeGzPlanNumberCorrection(report);
  console.log(
    `verified=${summary.verified} wrong=${summary.wrong} unchanged=${summary.unchanged} unresolved=${summary.unresolved}`
  );

  const replacements = planGzPlanNumberReplacements(report);
  console.log(`planned replacements (${replacements.length}):`);
  for (const entry of replacements) {
    console.log(
      `  deal ${entry.dealId} point ${entry.canonicalPlanPointId}: ${entry.storedPlanNumber} -> ${entry.livePlanNumber}  ${entry.finalUrl}`
    );
  }
  for (const entry of report.unresolved) {
    console.log(`  [unresolved] deal ${entry.dealId} point ${entry.canonicalPlanPointId}: ${entry.reason}`);
  }
}

async function runVerify(client: BitrixClient, args: CliArgs): Promise<number> {
  if (!args.sourcePath) throw new Error("verify requires --source <path to the 20260715 backfill report>");
  const source = JSON.parse(fs.readFileSync(args.sourcePath, "utf8")) as LegacyBackfillReport;

  // Only the snapshot-sourced entries are in question: they were read from the
  // legacy-keyed cache, where one page answered for several canonical points.
  const suspect = source.resolved.filter((entry) => entry.source === "snapshot");
  console.log(`gz plan number correction: mode=verify source=${args.sourcePath}`);
  console.log(`source entries=${source.resolved.length} snapshot-sourced=${suspect.length}`);

  const deals = await readDeals(client, suspect.map((entry) => entry.dealId));

  const verified: GzPlanNumberCorrectionEntry[] = [];
  const unresolved: GzPlanNumberCorrectionUnresolved[] = [];

  await withBrowser(args.headless, async (page) => {
    for (const [index, item] of suspect.entries()) {
      const deal = deals.get(item.dealId);
      if (!deal) {
        unresolved.push({
          dealId: item.dealId,
          canonicalPlanPointId: item.canonicalPlanPointId,
          requestedUrl: "",
          finalUrl: "",
          reason: "deal no longer readable in Bitrix"
        });
        continue;
      }

      const requestedUrl = getGzPlanLink(deal);
      const canonicalPlanPointId = resolveGzPlanNumberSource(deal)?.canonicalPlanPointId ?? "";
      if (!requestedUrl || !canonicalPlanPointId) {
        unresolved.push({
          dealId: item.dealId,
          canonicalPlanPointId,
          requestedUrl,
          finalUrl: "",
          reason: "deal carries no usable plan link"
        });
        continue;
      }
      if (canonicalPlanPointId !== item.canonicalPlanPointId) {
        unresolved.push({
          dealId: item.dealId,
          canonicalPlanPointId,
          requestedUrl,
          finalUrl: "",
          reason: `plan link now points at ${canonicalPlanPointId}, the source report saw ${item.canonicalPlanPointId}`
        });
        continue;
      }

      const load = await loadCanonicalPage(page, requestedUrl);
      const result = classifyGzPlanNumberCorrection(
        { dealId: item.dealId, canonicalPlanPointId, requestedUrl, finalUrl: load.finalUrl, html: load.html, loadError: load.error },
        deal
      );

      if ("unresolved" in result) {
        unresolved.push(result.unresolved);
        console.log(`  [${index + 1}/${suspect.length}] deal ${item.dealId}: ${result.unresolved.reason}`);
        continue;
      }

      saveCanonicalPage(canonicalPlanPointId, load.html as string);
      verified.push(result.entry);
      const mark = result.entry.verdict === "wrong" ? "WRONG" : "ok";
      console.log(
        `  [${index + 1}/${suspect.length}] deal ${item.dealId} point ${canonicalPlanPointId}: stored ${result.entry.storedPlanNumber} live ${result.entry.livePlanNumber} ${mark}`
      );
    }
  });

  const report: GzPlanNumberCorrectionReport = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    sourceReport: args.sourcePath,
    verified,
    unresolved
  };
  const file = writeCorrectionReport(report);

  printSummary(report);
  console.log(`report: ${file}`);

  const verdict = canExecuteGzPlanNumberCorrection(report);
  console.log(verdict.ok
    ? `execute allowed (needs explicit confirmation): npx tsx scripts/bitrix-correct-gz-plan-number.mts --execute --report ${file}`
    : `execute BLOCKED: ${verdict.reason}`);
  return unresolved.length > 0 ? 1 : 0;
}

async function runExecute(client: BitrixClient, args: CliArgs): Promise<number> {
  if (!args.reportPath) throw new Error("--execute requires --report <path to correction report>");
  const report = readCorrectionReport(args.reportPath);

  const replacements = planGzPlanNumberReplacements(report);
  console.log(`gz plan number correction: mode=execute report=${args.reportPath} replacements=${replacements.length}`);

  // One fresh session, so each write rests on its own load rather than on the
  // report's. Every read, load and decision happens before the first write.
  const outcome = await withBrowser(args.headless, async (page) => {
    return executeGzPlanNumberCorrection(report, {
      readDeal: (dealId) => readDeal(client, dealId),
      loadCanonicalPage: (url) => loadCanonicalPage(page, url),
      updateDeal: (dealId, fields) => client.update("deal", dealId, fields)
    });
  });

  console.log(
    `written=${outcome.written} skipped=${outcome.skipped} blocked=${outcome.blocked.length} failed=${outcome.failed.length}`
  );
  for (const item of outcome.blocked) console.log(`  [blocked] ${item}`);
  for (const item of outcome.failed) console.log(`  [failed] ${item}`);
  if (outcome.blocked.length > 0) {
    console.log(`preflight failed: ${outcome.planned.length} replacement(s) withheld, nothing was written`);
  }
  return outcome.failed.length > 0 || outcome.blocked.length > 0 ? 1 : 0;
}

/**
 * Independent of the execute path: re-reads every deal and re-loads every
 * canonical page, then asserts the CRM matches the live page and that nothing
 * but the plan number moved.
 */
async function runAudit(client: BitrixClient, args: CliArgs): Promise<number> {
  if (!args.reportPath) throw new Error("--audit requires --report <path to correction report>");
  const report = readCorrectionReport(args.reportPath);
  console.log(`gz plan number correction: mode=audit report=${args.reportPath} entries=${report.verified.length}`);

  const deals = await readDeals(client, report.verified.map((entry) => entry.dealId));
  const pages = await withBrowser(args.headless, async (page) => {
    const loaded = new Map<string, PageLoad>();
    for (const entry of report.verified) {
      loaded.set(entry.dealId, await loadCanonicalPage(page, entry.requestedUrl));
    }
    return loaded;
  });

  const problems: string[] = [];
  let matching = 0;

  for (const entry of report.verified) {
    const deal = deals.get(entry.dealId);
    if (!deal) {
      problems.push(`${entry.dealId}: deal no longer readable`);
      continue;
    }

    const drift = detectGzPlanControlDrift(entry, deal);
    if (drift) problems.push(`${entry.dealId}: ${drift}`);

    const load = pages.get(entry.dealId);
    const result = classifyGzPlanNumberCorrection(
      {
        dealId: entry.dealId,
        canonicalPlanPointId: entry.canonicalPlanPointId,
        requestedUrl: entry.requestedUrl,
        finalUrl: load?.finalUrl ?? "",
        html: load?.html ?? null,
        loadError: load?.error
      },
      deal
    );

    if ("unresolved" in result) {
      problems.push(`${entry.dealId}: ${result.unresolved.reason}`);
      continue;
    }
    if (result.entry.verdict !== "unchanged") {
      problems.push(
        `${entry.dealId}: CRM carries ${result.entry.storedPlanNumber}, live page reads ${result.entry.livePlanNumber}`
      );
      continue;
    }
    matching++;
  }

  console.log(`live-matching=${matching}/${report.verified.length} problems=${problems.length}`);
  for (const problem of problems) console.log(`  [problem] ${problem}`);
  return problems.length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
  if (!webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is not configured");

  const client = new BitrixClient(webhookUrl);
  if (args.mode === "execute") process.exitCode = await runExecute(client, args);
  else if (args.mode === "audit") process.exitCode = await runAudit(client, args);
  else process.exitCode = await runVerify(client, args);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
