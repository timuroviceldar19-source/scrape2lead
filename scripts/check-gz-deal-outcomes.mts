import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  buildGzDealOutcomeComment,
  buildGzDealPlanRef,
  dealBin,
  decideGzDealOutcome,
  gzDealOutcomeKey,
  type GzDealOutcome,
  type GzDealPlanRef,
  type GzOutcomeConfig,
  type GzOutcomeContract,
  type GzOutcomeDealFields,
  type GzItemFamilies,
  type GzPlanSignal,
  isSignedGzPlanStatus,
  readGzPlanSignal,
  shouldReplaceGzOutcomeKey
} from "../src/bitrix/gzDealOutcome.js";
import { callBitrixBatch, chunkBatchCommands } from "../src/bitrix/batch.js";
import { goszakupGraphqlAll } from "../src/kz/goszakupGraphql.js";
import { parseGoszakupPlanSearchHtml } from "../src/kz/goszakupPlanHtmlParser.js";
import type { GoszakupPlanListItem } from "../src/kz/goszakupPlanTypes.js";
import { GZ_PORTAL_ORIGIN, isGzPortalRootHost } from "../src/kz/goszakupOrigin.js";

dotenv.config();

// Checks every open plan deal against the portal once a run: who signed the
// contract, or what the plan point status says, and leaves the manager one
// timeline comment per new event. Stages stay untouched on purpose.

interface CliArgs {
  webhookUrl: string | null;
  token: string | null;
  execute: boolean;
  limit: number | null;
  configPath: string;
  reportPath: string;
  concurrency: number;
  htmlDelayMs: number;
  htmlLimit: number;
  skipHtml: boolean;
}

interface OpenDeal extends GzOutcomeDealFields {
  ID: string;
  COMPANY_ID?: string | null;
  ASSIGNED_BY_ID?: string | null;
  CATEGORY_ID?: string | null;
  DATE_CREATE?: string | null;
  UF_CRM_S2L_GZ_OUTCOME?: string | null;
}

interface ApiPlan {
  id: number;
  rootrecordId?: number | null;
  subjectBiin?: string | null;
  isActive?: number | null;
  plnPointYear?: number | null;
  refEnstruCode?: string | null;
  nameRu?: string | null;
  RefPlnPointStatus?: { nameRu?: string | null } | null;
}

interface DealCheck {
  deal: OpenDeal;
  ref: GzDealPlanRef;
  bin: string | null;
  planUrl: string | null;
  plan: GzPlanSignal;
  statusSource: "api" | "html" | null;
  outcome: GzDealOutcome | null;
  key: string | null;
  isNew: boolean;
  applied: boolean;
  error: string | null;
  /** Why the deal was left alone this run. */
  skipped: string | null;
}

const ORIGINATOR_ID = "scrape2lead-gz-plans";
const OUTCOME_FIELD = "UF_CRM_S2L_GZ_OUTCOME";
const COMPANY_BIN_FIELD = "UF_CRM_666171B20E9E3";
const DEAL_SELECT = [
  "ID", "TITLE", "ORIGIN_ID", "COMPANY_ID", "ASSIGNED_BY_ID", "CATEGORY_ID", "DATE_CREATE",
  "UF_CRM_PLAN_ID", "UF_CRM_1782386293000_IU_XLS", "UF_CRM_6A436D5A3614C",
  "UF_CRM_PLAN_LINK", "UF_CRM_1782386571874_IU_XLS", "UF_CRM_6627AEBD7C2D2",
  "UF_CRM_6A436D5A19612", "UF_CRM_REF_ENSTRU_CODE", "UF_CRM_6627AEBD54B8D", OUTCOME_FIELD
];
const API_CHUNK = 50;
const NO_PLAN_SIGNAL: GzPlanSignal = { status: null, repurposedTo: null };
// A full results page is ~55 KB; the throttled one is ~2 KB.
const THROTTLED_PAGE_MAX_LENGTH = 10_000;
const THROTTLE_BACKOFF_MS = 30_000;
// Runs come at 08:40 and 13:00; an hourly slot gives each of them its own slice.
const HTML_ROTATION_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const PLAN_FIELDS = "id rootrecordId subjectBiin isActive plnPointYear refEnstruCode nameRu RefPlnPointStatus{nameRu}";
const PLANS_BY_ROOT = `query($v:[Int],$after:Int){Plans(filter:{rootrecordId:$v},limit:200,after:$after){${PLAN_FIELDS}}}`;
const PLANS_BY_ID = `query($v:[Int],$after:Int){Plans(filter:{id:$v},limit:200,after:$after){${PLAN_FIELDS}}}`;
const CONTRACTS_BY_CUSTOMER = `query($bin:String,$year:Int,$after:Int){Contract(filter:{customerBin:$bin,finYear:$year},limit:200,after:$after){
  contractNumberSys signDate supplierBiin deleted Supplier{nameRu} RefContractStatus{nameRu}
  ContractUnits{plnPointId totalSum refEnstruCode Plans{rootrecordId nameRu}}}}`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    token: process.env.GOSZAKUP_TOKEN?.trim() || null,
    execute: false,
    limit: null,
    configPath: "config/gz-deal-outcomes.json",
    reportPath: path.join("logs", `gz-deal-outcomes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
    concurrency: 4,
    htmlDelayMs: 1500,
    htmlLimit: 200,
    skipHtml: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--limit") args.limit = Number.parseInt(argv[++i] ?? "", 10) || null;
    else if (arg === "--config") args.configPath = argv[++i] ?? args.configPath;
    else if (arg === "--report") args.reportPath = argv[++i] ?? args.reportPath;
    else if (arg === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === "--html-delay-ms") args.htmlDelayMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--html-limit") args.htmlLimit = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--skip-html") args.skipHtml = true;
  }
  return args;
}

function loadOutcomeConfig(configPath: string): GzOutcomeConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GzOutcomeConfig>;
  const bins = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.some((bin) => !/^\d{12}$/.test(String(bin)))) {
      throw new Error(`${configPath}: ${name} must be a list of 12-digit BINs`);
    }
    return value.map(String);
  };
  const prefixes = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.some((prefix) => !/^\d{6}[\d.]*$/.test(String(prefix)))) {
      throw new Error(`${configPath}: ${name} must be a list of ENSTRU code prefixes (at least 6 digits)`);
    }
    return value.map(String);
  };
  const families = raw.itemFamilies;
  if (!families || !Array.isArray(families.groups)) throw new Error(`${configPath}: itemFamilies.groups is required`);
  const config: GzOutcomeConfig = {
    ourBins: bins(raw.ourBins, "ourBins"),
    partnerBins: bins(raw.partnerBins ?? [], "partnerBins"),
    itemFamilies: {
      groups: families.groups.map((group, index) => prefixes(group, `itemFamilies.groups[${index}]`)),
      wildcards: prefixes(families.wildcards ?? [], "itemFamilies.wildcards")
    }
  };
  if (config.ourBins.length === 0) throw new Error(`${configPath}: ourBins is empty`);
  return config;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");
  if (!args.token) throw new Error("GOSZAKUP_TOKEN is required");
  const config = loadOutcomeConfig(args.configPath);
  const bitrix = new BitrixClient(args.webhookUrl);
  const gql = { token: args.token };
  const currentYear = Number(new Date().toLocaleString("en-CA", { timeZone: "Asia/Almaty", year: "numeric" }));

  const allDeals = await bitrix.listOpenPlanDeals();
  const deals = args.limit ? allDeals.slice(0, args.limit) : allDeals;
  console.log(`gz deal outcomes: mode=${args.execute ? "execute" : "dry-run"} open_deals=${allDeals.length} checked=${deals.length}`);

  const checks: DealCheck[] = deals.map((deal) => ({
    deal,
    ref: buildGzDealPlanRef(deal),
    bin: dealBin(deal),
    planUrl: portalPlanUrl(deal.UF_CRM_PLAN_LINK || deal.UF_CRM_1782386571874_IU_XLS || null),
    plan: NO_PLAN_SIGNAL,
    statusSource: null,
    outcome: null,
    key: null,
    isNew: false,
    applied: false,
    error: null,
    skipped: null
  }));

  await fillCompanyBins(bitrix, checks);
  await fillApiPlanStatuses(checks, gql, config.itemFamilies);
  const contractsByBin = await fetchContractsByBin(checks, currentYear, gql, args.concurrency);
  // A contract settles the deal, so the slow portal pages go only to the rest.
  // A "contract signed" status without a matched contract also goes there: the
  // registry names the live revision the contract unit points at.
  const htmlPending = checks.filter((check) => check.ref.planNumber && !check.plan.repurposedTo
    && (!check.plan.status || isSignedGzPlanStatus(check.plan.status))
    && !decideGzDealOutcome(check.ref, contractsByBin.get(check.bin ?? "") ?? [], NO_PLAN_SIGNAL, config));
  const htmlFailed = args.skipHtml
    ? 0
    : await fillHtmlPlanStatuses(htmlPending, args.htmlDelayMs, args.htmlLimit, config.itemFamilies);

  for (const check of checks) {
    // Without this customer's contracts the plan status would pass for news.
    if (check.bin && contractsByBin.failedBins.has(check.bin)) {
      check.skipped = "contracts unavailable";
      continue;
    }
    check.outcome = decideGzDealOutcome(check.ref, contractsByBin.get(check.bin ?? "") ?? [], check.plan, config);
    check.key = check.outcome ? gzDealOutcomeKey(check.outcome) : null;
    check.isNew = check.key !== null && shouldReplaceGzOutcomeKey(check.deal.UF_CRM_S2L_GZ_OUTCOME, check.key);
  }

  if (args.execute && checks.some((check) => check.isNew)) await bitrix.ensureOutcomeField();
  for (const check of checks.filter((item) => item.isNew)) {
    const comment = buildGzDealOutcomeComment(check.outcome!, check.planUrl);
    if (!args.execute) {
      console.log(`[dry-run] ${check.outcome!.kind} deal ${check.deal.ID} | ${comment.split("\n")[0]}`);
      continue;
    }
    // Marker first: a comment that cannot be marked would repeat every run.
    const previousKey = check.deal.UF_CRM_S2L_GZ_OUTCOME || "";
    try {
      await bitrix.updateDeal(check.deal.ID, { [OUTCOME_FIELD]: check.key });
    } catch (error) {
      check.error = error instanceof Error ? error.message : String(error);
      console.error(`[failed] deal ${check.deal.ID}: ${check.error}`);
      process.exitCode = 1;
      continue;
    }
    try {
      await bitrix.addDealComment(check.deal.ID, comment);
      check.applied = true;
      console.log(`[${check.outcome!.kind}] deal ${check.deal.ID} | ${comment.split("\n")[0]}`);
    } catch (error) {
      check.error = error instanceof Error ? error.message : String(error);
      console.error(`[failed] deal ${check.deal.ID}: ${check.error}`);
      process.exitCode = 1;
      await bitrix.updateDeal(check.deal.ID, { [OUTCOME_FIELD]: previousKey })
        .catch((rollback) => console.error(`[failed] deal ${check.deal.ID}: marker rollback: ${String(rollback)}`));
    }
  }

  const summary = summarize(checks, htmlFailed, contractsByBin.failedBins.size);
  console.log(summary.line);
  writeReport(args.reportPath, args.execute, checks, summary.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.markdown}\n`);
}

async function fillCompanyBins(bitrix: BitrixClient, checks: DealCheck[]): Promise<void> {
  const companyIds = [...new Set(checks
    .filter((check) => !check.bin && check.deal.COMPANY_ID && check.deal.COMPANY_ID !== "0")
    .map((check) => String(check.deal.COMPANY_ID)))];
  const bins = await bitrix.companyBins(companyIds);
  for (const check of checks) {
    if (!check.bin && check.deal.COMPANY_ID) check.bin = bins.get(String(check.deal.COMPANY_ID)) ?? null;
  }
}

/** The API index misses about half of the points; those fall through to the portal search. */
async function fillApiPlanStatuses(checks: DealCheck[], gql: { token: string }, families: GzItemFamilies): Promise<void> {
  const byRoot = await fetchPlans(PLANS_BY_ROOT, uniqueInts(checks.map((check) => check.ref.planNumber)), gql);
  const byId = await fetchPlans(PLANS_BY_ID, uniqueInts(checks.flatMap((check) => check.ref.pointIds)), gql);
  const current = new Map<number, ApiPlan>();
  for (const plan of byRoot) {
    const root = plan.rootrecordId ?? plan.id;
    const known = current.get(root);
    if (plan.isActive !== 0 && (!known || plan.id > known.id)) current.set(root, plan);
  }
  const points = new Map(byId.map((plan) => [plan.id, plan]));
  const revisions = new Map<number, number[]>();
  for (const plan of byRoot) {
    const root = plan.rootrecordId ?? plan.id;
    revisions.set(root, [...(revisions.get(root) ?? []), plan.id]);
  }

  for (const check of checks) {
    const root = check.ref.planNumber;
    const rootRevisions = root ? revisions.get(root) ?? [] : [];
    const dealYear = Number(String(check.deal.DATE_CREATE ?? "").slice(0, 4)) || 0;
    // A point of an earlier year is a stale id, not the deal's plan.
    const ownPlan = check.ref.pointIds.map((id) => points.get(id))
      .find((item) => item && (item.plnPointYear ?? dealYear) >= dealYear);
    const verified = check.ref.planNumberVerified
      || (root !== null && ownPlan?.rootrecordId === root)
      || rootRevisions.some((id) => check.ref.pointIds.includes(id));
    check.ref = withRevisions({ ...check.ref, planNumberVerified: verified }, rootRevisions);
    // An unconfirmed plan number may belong to another item: the deal's own point speaks first.
    const plan = verified
      ? (root ? current.get(root) : undefined) ?? ownPlan
      : ownPlan ?? (root ? current.get(root) : undefined);
    if (!plan) continue;
    check.plan = readGzPlanSignal(check.ref, {
      status: plan.RefPlnPointStatus?.nameRu?.trim() || null,
      enstruCode: plan.refEnstruCode,
      name: plan.nameRu,
      exactPoint: check.ref.pointIds.includes(plan.id)
    }, families);
    check.statusSource = "api";
    check.bin ??= /^\d{12}$/.test(plan.subjectBiin ?? "") ? plan.subjectBiin! : null;
  }
}

async function fetchPlans(query: string, ids: number[], gql: { token: string }): Promise<ApiPlan[]> {
  const plans: ApiPlan[] = [];
  for (let i = 0; i < ids.length; i += API_CHUNK) {
    plans.push(...await goszakupGraphqlAll<ApiPlan>(query, { v: ids.slice(i, i + API_CHUNK) }, "Plans", gql));
  }
  return plans;
}

/**
 * Portal registry search by plan number returns the live revision with its
 * status. The portal answers a burst with a stripped page and HTTP 200, so the
 * requests go one by one, and each run takes the next slice of deals in turn.
 */
async function fillHtmlPlanStatuses(
  pending: DealCheck[],
  delayMs: number,
  limit: number,
  families: GzItemFamilies
): Promise<number> {
  const ordered = [...pending].sort((a, b) => Number(a.deal.ID) - Number(b.deal.ID));
  const runSlot = Math.floor(Date.now() / HTML_ROTATION_MS);
  const start = ordered.length > 0 ? (runSlot * limit) % ordered.length : 0;
  const slice = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, limit);
  console.log(`html status: pending=${pending.length} checking=${slice.length} from=${start}`);

  let failed = 0;
  for (const check of slice) {
    try {
      const rows = await searchPlanRows(check);
      check.ref = withRevisions(check.ref, rows.map((item) => Number(item.plan_point_id)));
      const row = [...rows].sort((a, b) => Number(b.plan_point_id) - Number(a.plan_point_id))[0];
      if (row?.status) {
        check.plan = readGzPlanSignal(check.ref, {
          status: row.status.trim(),
          name: row.item_name,
          exactPoint: check.ref.pointIds.includes(Number(row.plan_point_id))
        }, families);
        check.statusSource = "html";
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[html-status] plan ${check.ref.planNumber}: ${message}`);
      if (error instanceof PortalThrottledError) {
        console.warn("html status: portal keeps throttling, the rest waits for the next run");
        break;
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return failed;
}

async function searchPlanRows(check: DealCheck, retried = false): Promise<GoszakupPlanListItem[]> {
  const url = `${GZ_PORTAL_ORIGIN}/ru/registry/plan?filter%5Bnumber%5D=${check.ref.planNumber}&count_record=50`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (html.length < THROTTLED_PAGE_MAX_LENGTH) {
    if (retried) throw new PortalThrottledError();
    await sleep(THROTTLE_BACKOFF_MS);
    return searchPlanRows(check, true);
  }
  // Rows are the revisions of the plan number; the newest one is live. The
  // number filter matches substrings, which is harmless while every plan
  // number has the same 8 digits.
  return parseGoszakupPlanSearchHtml(html, "outcome-check")
    .filter((row) => Number.isInteger(Number(row.plan_point_id)) && Number(row.plan_point_id) > 0);
}

function withRevisions(ref: GzDealPlanRef, ids: number[]): GzDealPlanRef {
  const fresh = ids.filter((id) => !ref.pointIds.includes(id) && !ref.revisionIds.includes(id));
  return fresh.length === 0 ? ref : { ...ref, revisionIds: [...ref.revisionIds, ...fresh] };
}

class PortalThrottledError extends Error {
  constructor() {
    super("portal returned a stripped page twice");
    this.name = "PortalThrottledError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Contracts of every customer, for the financial years its deals belong to:
 * the year a deal was created and, once the calendar moves on, the next one.
 */
async function fetchContractsByBin(
  checks: DealCheck[],
  currentYear: number,
  gql: { token: string },
  concurrency: number
): Promise<Map<string, GzOutcomeContract[]> & { failedBins: Set<string> }> {
  const result = Object.assign(new Map<string, GzOutcomeContract[]>(), { failedBins: new Set<string>() });
  const years = new Map<string, Set<number>>();
  for (const check of checks) {
    if (!check.bin) continue;
    const created = Number(String(check.deal.DATE_CREATE ?? "").slice(0, 4)) || currentYear;
    const set = years.get(check.bin) ?? new Set<number>();
    set.add(created);
    if (created < currentYear) set.add(created + 1);
    years.set(check.bin, set);
  }
  await mapLimit([...years.entries()], concurrency, async ([bin, binYears]) => {
    try {
      const contracts: GzOutcomeContract[] = [];
      for (const year of binYears) {
        contracts.push(...await goszakupGraphqlAll<GzOutcomeContract>(CONTRACTS_BY_CUSTOMER, { bin, year }, "Contract", gql));
      }
      result.set(bin, contracts);
    } catch (error) {
      result.failedBins.add(bin);
      console.warn(`[contracts] BIN ${bin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return result;
}

function summarize(checks: DealCheck[], htmlFailed: number, contractsFailed: number): { line: string; markdown: string } {
  const kinds = ["won", "lost", "partner", "terminated", "repurposed", "published", "failed", "cancelled", "contract-draft", "signed-unknown"] as const;
  const fresh = (kind: string) => checks.filter((check) => check.isNew && check.outcome?.kind === kind).length;
  const counts = kinds.map((kind) => `${kind.replace("-", "_")}=${fresh(kind)}`).join(" ");
  const line = `outcomes: checked=${checks.length} ${counts} unchanged=${checks.filter((check) => check.key && !check.isNew).length}`
    + ` no_signal=${checks.filter((check) => !check.key && !check.skipped).length} skipped=${checks.filter((check) => check.skipped).length} no_bin=${checks.filter((check) => !check.bin).length}`
    + ` status_api=${checks.filter((check) => check.statusSource === "api").length} status_html=${checks.filter((check) => check.statusSource === "html").length}`
    + ` html_failed=${htmlFailed} contracts_failed=${contractsFailed} errors=${checks.filter((check) => check.error).length}`;

  const competitors = new Map<string, { deals: number; sum: number }>();
  for (const check of checks) {
    const outcome = check.outcome;
    if (!outcome || outcome.kind !== "lost") continue;
    const entry = competitors.get(outcome.supplierName) ?? { deals: 0, sum: 0 };
    competitors.set(outcome.supplierName, { deals: entry.deals + 1, sum: entry.sum + (outcome.unitSum ?? 0) });
  }
  const wins = checks.filter((check) => check.isNew && check.outcome?.kind === "won");
  const markdown = [
    "## Итоги закупок по открытым сделкам",
    "",
    `Новых событий: выиграли ${fresh("won")}, проиграли ${fresh("lost")}, партнёр ${fresh("partner")}, расторгнуто ${fresh("terminated")}, пункт переделан ${fresh("repurposed")},`
      + ` объявлено ${fresh("published")}, не состоялось ${fresh("failed")}, отменено ${fresh("cancelled")}, договор на подписании ${fresh("contract-draft")}, договор без победителя ${fresh("signed-unknown")}.`,
    "",
    ...(wins.length ? ["**Новые победы:**", ...wins.map((check) => `- сделка ${check.deal.ID}: ${describeContract(check.outcome!)}`), ""] : []),
    "**Кому уходят открытые сделки (все известные договоры):**",
    ...[...competitors.entries()].sort((a, b) => b[1].deals - a[1].deals).slice(0, 10)
      .map(([name, entry]) => `- ${name}: ${entry.deals} сделок, ${Math.round(entry.sum).toLocaleString("ru-RU")} ₸`),
    "",
    `\`${line}\``
  ].join("\n");
  return { line, markdown };
}

function describeContract(outcome: GzDealOutcome): string {
  return "contractNumber" in outcome
    ? `договор ${outcome.contractNumber} от ${outcome.signDate}${outcome.unitSum ? `, ${Math.round(outcome.unitSum).toLocaleString("ru-RU")} ₸` : ""}`
    : "newItem" in outcome ? `переделан под «${outcome.newItem}»` : outcome.planStatus;
}

function writeReport(reportPath: string, execute: boolean, checks: DealCheck[], markdown: string): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    generatedAt: new Date().toISOString(),
    summary: markdown,
    deals: checks.map((check) => ({
      dealId: check.deal.ID,
      categoryId: check.deal.CATEGORY_ID ?? null,
      assignedById: check.deal.ASSIGNED_BY_ID ?? null,
      planNumber: check.ref.planNumber,
      pointIds: check.ref.pointIds,
      bin: check.bin,
      plan: check.plan,
      statusSource: check.statusSource,
      outcome: check.outcome,
      key: check.key,
      isNew: check.isNew,
      applied: check.applied,
      error: check.error,
      skipped: check.skipped
    }))
  }, null, 2), "utf8");
}

function portalPlanUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return isGzPortalRootHost(url.hostname) ? `${GZ_PORTAL_ORIGIN}${url.pathname}` : value;
  } catch {
    return null;
  }
}

function uniqueInts(values: Array<number | null>): number[] {
  return [...new Set(values.filter((value): value is number => value !== null))];
}

async function mapLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
  }));
}

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async listOpenPlanDeals(): Promise<OpenDeal[]> {
    const deals: OpenDeal[] = [];
    let lastId = 0;
    for (;;) {
      const page = await this.call("crm.deal.list", {
        filter: { ORIGINATOR_ID, STAGE_SEMANTIC_ID: "P", ">ID": lastId },
        order: { ID: "ASC" },
        select: DEAL_SELECT,
        start: -1
      }) as OpenDeal[];
      if (!Array.isArray(page) || page.length === 0) return deals;
      deals.push(...page);
      lastId = Number(page[page.length - 1].ID);
    }
  }

  async companyBins(companyIds: string[]): Promise<Map<string, string>> {
    const bins = new Map<string, string>();
    const commands = companyIds.map((id) => ({ key: `c${id}`, method: "crm.company.get", params: { id } }));
    for (const chunk of chunkBatchCommands(commands)) {
      const results = await callBitrixBatch(this.baseUrl, chunk);
      for (const [key, outcome] of results) {
        const digits = String((outcome.result as Record<string, unknown> | undefined)?.[COMPANY_BIN_FIELD] ?? "").replace(/\D/g, "");
        if (digits.length === 12) bins.set(key.slice(1), digits);
      }
    }
    return bins;
  }

  async ensureOutcomeField(): Promise<void> {
    const fields = await this.call("crm.deal.userfield.list", { filter: { FIELD_NAME: OUTCOME_FIELD } });
    if (Array.isArray(fields) && fields.length > 0) return;
    await this.call("crm.deal.userfield.add", {
      fields: {
        FIELD_NAME: OUTCOME_FIELD,
        EDIT_FORM_LABEL: "GZ итог закупки (робот)",
        LIST_COLUMN_LABEL: "GZ итог закупки",
        USER_TYPE_ID: "string",
        XML_ID: "scrape2lead_gz_outcome",
        SORT: 540
      }
    });
  }

  async addDealComment(dealId: string, comment: string): Promise<void> {
    await this.call("crm.timeline.comment.add", { fields: { ENTITY_ID: dealId, ENTITY_TYPE: "deal", COMMENT: comment } });
  }

  async updateDeal(dealId: string, fields: Record<string, unknown>): Promise<void> {
    await this.call("crm.deal.update", { id: dealId, fields, params: { REGISTER_SONET_EVENT: "N" } });
  }

  private async call(method: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/${method}.json`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as { result: unknown; error?: string; error_description?: string };
    if (!response.ok || payload.error) throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    return payload.result;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
