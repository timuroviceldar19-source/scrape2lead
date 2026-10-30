import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  buildGzDealOutcomeComment,
  contractBaseNumber,
  findPlanContracts,
  buildGzDealPlanRef,
  buildGzMissingPlanFields,
  dealBin,
  dealPlanAmount,
  decideGzDealOutcome,
  decideMissingGzPlan,
  gzDealOutcomeKey,
  gzMissingPlanCandidates,
  isMissingPlanOutcome,
  parseTenge,
  type GzDealOutcome,
  type GzDealPlanRef,
  type GzOutcomeConfig,
  type GzOutcomeContract,
  type GzOutcomeDealFields,
  type GzItemFamilies,
  type GzPlanSignal,
  type GzRegisterPlanRow,
  isSignedGzPlanStatus,
  readGzPlanSignal,
  shouldReplaceGzOutcomeKey
} from "../src/bitrix/gzDealOutcome.js";
import { callBitrixBatch, chunkBatchCommands } from "../src/bitrix/batch.js";
import { describeOutcomeCoverage, type OutcomeCoverageInput } from "../src/bitrix/gzOutcomeCoverage.js";
import { formatPortalConflicts } from "../src/bitrix/gzOutcomeSummary.js";
import { prefetchGzPlanOutcomeProofs, verifyGzPlanOutcome } from '../src/bitrix/gzOutcomePortal.js';
import { fetchGzPlans, GzPlanLookup, type GzPlanLookupOptions, type GzPlanContext, type ApiPlan } from "../src/kz/zakupGzPlans.js";
import { fullEnstruCodes, type GzContractLookupPath } from "../src/kz/zakupGzRegistry.js";
import { parseGoszakupPlanDetailHtml } from "../src/kz/goszakupPlanHtmlParser.js";
import { PortalPlanVerifier, PortalThrottledError, HtmlBudgetError, fetchRegisterRows, fetchPortalPage, type PortalVerification } from "../src/kz/goszakupPlanRegistry.js";
import type { GoszakupPlanListItem } from "../src/kz/goszakupPlanTypes.js";
import { GZ_PORTAL_ORIGIN, isGzPortalRootHost } from "../src/kz/goszakupOrigin.js";

dotenv.config();

// Checks every open plan deal against the portal once a run: who signed the
// contract, or what the plan point status says, and leaves the manager one
// timeline comment per new event. Stages stay untouched on purpose. A plan
// moved under a new number is the one case the robot edits the card itself;
// a deleted plan is left alone.

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
  htmlBudgetMs: number;
  skipHtml: boolean;
  maxFullScans: number;
}

interface OpenDeal extends GzOutcomeDealFields {
  ID: string;
  COMPANY_ID?: string | null;
  ASSIGNED_BY_ID?: string | null;
  CATEGORY_ID?: string | null;
  DATE_CREATE?: string | null;
  UF_CRM_S2L_GZ_OUTCOME?: string | null;
}

interface DealCheck {
  planVersion: number | null;
  verification: PortalVerification | null;
  contractSource: GzContractLookupPath | null;
  deal: OpenDeal;
  ref: GzDealPlanRef;
  bin: string | null;
  planUrl: string | null;
  plan: GzPlanSignal;
  statusSource: "api" | "html" | null;
  /** The register search by plan number came back without this plan. */
  planMissing: boolean;
  /** The customer's plan register, read only for a missing plan. */
  registerRows: GzRegisterPlanRow[] | null;
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
const PLAN_NUMBER_FIELDS = ["UF_CRM_PLAN_ID", "UF_CRM_1782386293000_IU_XLS"];
const DEAL_SELECT = [
  "ID", "TITLE", "ORIGIN_ID", "COMPANY_ID", "ASSIGNED_BY_ID", "CATEGORY_ID", "DATE_CREATE",
  "UF_CRM_PLAN_ID", "UF_CRM_1782386293000_IU_XLS", "UF_CRM_6A436D5A3614C",
  "UF_CRM_PLAN_LINK", "UF_CRM_1782386571874_IU_XLS", "UF_CRM_6627AEBD7C2D2",
  "UF_CRM_6A436D5A19612", "UF_CRM_REF_ENSTRU_CODE", "UF_CRM_6627AEBD54B8D",
  "UF_CRM_1715597423325", "OPPORTUNITY", OUTCOME_FIELD
];
const NO_PLAN_SIGNAL: GzPlanSignal = { status: null, repurposedTo: null };
// Runs come at 08:40 and 13:00; an hourly slot gives each of them its own slice.
const HTML_ROTATION_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
// The register accepts 500 rows a page (not 1000: that silently falls back to 30).
const REGISTER_PAGE_SIZE = 500;
// The largest customers (НАО «МУС») have ~3000 rows a year.
const REGISTER_MAX_PAGES = 20;

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
    htmlLimit: 500,
    htmlBudgetMs: 20 * 60 * 1000,
    skipHtml: false,
    maxFullScans: 2
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
    else if (arg === "--html-budget-min") args.htmlBudgetMs = Math.max(0, Number(argv[++i]) || 0) * 60 * 1000;
    else if (arg === "--skip-html") args.skipHtml = true;
    else if (arg === "--max-full-scans") {
      const value = argv[++i] ?? '';
      if (!/^\d+$/.test(value)) throw new Error('--max-full-scans requires a nonnegative integer');
      args.maxFullScans = Number(value);
    }
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
  const config = loadOutcomeConfig(args.configPath);
  const bitrix = new BitrixClient(args.webhookUrl);
  const contexts = new Map<number, GzPlanContext>();
  const lookup = new GzPlanLookup({ token: args.token, contexts, maxFullScans: args.maxFullScans });
  const gql: GzPlanLookupOptions = { token: args.token, contexts, lookup };
  const currentYear = Number(new Date().toLocaleString("en-CA", { timeZone: "Asia/Almaty", year: "numeric" }));

  const allDeals = await bitrix.listOpenPlanDeals();
  const deals = args.limit ? allDeals.slice(0, args.limit) : allDeals;
  console.log(`gz deal outcomes: mode=${args.execute ? "execute" : "dry-run"} open_deals=${allDeals.length} checked=${deals.length}`);

  const checks: DealCheck[] = deals.map((deal) => ({
    planVersion: null,
    verification: null,
    contractSource: null,
    deal,
    ref: buildGzDealPlanRef(deal),
    bin: dealBin(deal),
    planUrl: portalPlanUrl(deal.UF_CRM_PLAN_LINK || deal.UF_CRM_1782386571874_IU_XLS || null),
    plan: NO_PLAN_SIGNAL,
    statusSource: null,
    planMissing: false,
    registerRows: null,
    outcome: null,
    key: null,
    isNew: false,
    applied: false,
    error: null,
    skipped: null
  }));

  await fillCompanyBins(bitrix, checks);
  const inputWithoutEnstru = checks.filter(check => !fullEnstruCodes(check.ref.enstruCode).length).length;
  fillLookupContexts(checks, contexts);
  await fillApiPlanStatuses(checks, gql, config.itemFamilies);
  const planPages = args.skipHtml ? { pending: 0, failed: 0 } : await fillFromPlanPages(checks, args.htmlDelayMs);
  fillLookupContexts(checks, contexts);
  const withoutEnstru = checks.filter(check => !lookup.codesForContext(contexts.get(check.ref.planNumber ?? check.ref.pointIds[0])).length).length;
  console.log(`contract lookup: input_without_enstru=${inputWithoutEnstru} without_enstru_after_plan_lookup=${withoutEnstru}`);
  const contractsByBin = await fetchContractsByBin(checks, currentYear, gql, args.concurrency);
  // A contract settles the deal, so the slow portal pages go only to the rest.
  // A "contract signed" status without a matched contract also goes there: the
  // registry names the live revision the contract unit points at.
  const htmlPending = checks.filter((check) => check.ref.planNumber && !check.plan.repurposedTo
    && (!check.plan.status || isSignedGzPlanStatus(check.plan.status))
    && !decideGzDealOutcome(check.ref, contractsByBin.get(check.bin ?? "") ?? [], NO_PLAN_SIGNAL, config));
  const emptyStatus = { pending: 0, attempted: 0, failed: 0, budgetReached: false };
  const htmlDeadline = Date.now() + args.htmlBudgetMs;
  const portal = new PortalPlanVerifier({ delayMs: args.htmlDelayMs, deadline: args.skipHtml ? 0 : htmlDeadline });
  const priorityProofs = await prefetchGzPlanOutcomeProofs(portal, checks.map(check => ({ ref: check.ref,
    candidate: decideGzDealOutcome(check.ref, contractsByBin.get(check.bin ?? '') ?? [], check.plan, config),
    previousKey: check.deal.UF_CRM_S2L_GZ_OUTCOME })));
  console.log(`html outcome proofs: priority_candidates=${priorityProofs}`);
  const htmlStatus = args.skipHtml
    ? emptyStatus
    : await fillHtmlPlanStatuses(htmlPending, args.htmlDelayMs, args.htmlLimit, Math.max(0, htmlDeadline - Date.now()), config.itemFamilies, portal);
  const registersFailed = args.skipHtml
    ? 0
    : await fillCustomerRegisters(checks.filter((check) => check.planMissing && check.bin), args.htmlDelayMs);
  const coverage: OutcomeCoverageInput = { planPages, status: htmlStatus, registers: { failed: registersFailed } };
  const htmlFailed = planPages.failed + htmlStatus.failed + registersFailed;
  const recorded = await fillRecordedContracts(checks, contractsByBin, lookup, currentYear);

  // A plan that already has a deal is another purchase, never the new home of a missing plan.
  const dealsByPlan = await bitrix.dealsByPlanNumbers(uniqueInts(checks.flatMap((check) => check.registerRows
    ? gzMissingPlanCandidates(check.ref, dealPlanAmount(check.deal), check.registerRows, config.itemFamilies).map((row) => row.planNumber)
    : [])));

  for (const check of checks) {
    if (lookup.fullScanSkippedPlans.has(check.ref.planNumber ?? 0) || lookup.fullScanSkippedBins.has(check.bin ?? '')) check.skipped = 'full_scan_limit';
    if (check.skipped) continue;
    // Without this customer's contracts the plan status would pass for news.
    if (check.bin && contractsByBin.failedBins.has(check.bin)) {
      check.skipped = "contracts unavailable";
      continue;
    }
    check.outcome = decideGzDealOutcome(check.ref, contractsByBin.get(check.bin ?? "") ?? [], check.plan, config)
      ?? (check.registerRows
        ? decideMissingGzPlan(check.ref, dealPlanAmount(check.deal), check.registerRows, config.itemFamilies, dealsByPlan)
        : null);
    if (check.outcome && "contractNumber" in check.outcome) {
      const outcome = check.outcome;
      const paths = findPlanContracts(check.ref, contractsByBin.get(check.bin ?? "") ?? [], config.itemFamilies)
        .filter(contract => contractBaseNumber(String(contract.contractNumberSys ?? "")) === outcome.contractNumber)
        .map(contract => lookup.sourceForContract(contract));
      check.contractSource = (["enstru", "lots", "recorded", "full", "ows"] as const).find(path => paths.includes(path)) ?? null;
    }
    // Two deals of one customer must not move onto the same plan.
    if (check.outcome?.kind === "plan-renumbered" || check.outcome?.kind === "plan-moved") {
      dealsByPlan.set(check.outcome.plan.planNumber, check.deal.ID);
    }
    check.key = check.outcome ? gzDealOutcomeKey(check.outcome) : null;
    check.isNew = check.key !== null && shouldReplaceGzOutcomeKey(check.deal.UF_CRM_S2L_GZ_OUTCOME, check.key);
    if (check.isNew && check.outcome) {
      check.verification = await verifyGzPlanOutcome(portal, check.ref, check.planVersion, check.outcome, config);
      if (check.verification && check.verification.reason !== 'confirmed') {
        check.isNew = false;
        check.skipped = check.verification.reason;
        console.log(`[${check.skipped}] plan ${check.ref.planNumber}`);
      }
    }
  }

  if (args.execute && checks.some((check) => check.isNew)) await bitrix.ensureOutcomeField();
  for (const check of checks.filter((item) => item.isNew)) {
    const comment = buildGzDealOutcomeComment(check.outcome!, check.planUrl);
    const cardFields = isMissingPlanOutcome(check.outcome!) ? buildGzMissingPlanFields(check.deal, check.outcome) : {};
    const edits = Object.keys(cardFields).length ? ` | card: ${JSON.stringify(cardFields)}` : "";
    if (!args.execute) {
      console.log(`[dry-run] ${check.outcome!.kind} deal ${check.deal.ID} | ${comment.split("\n")[0]}${edits}`);
      continue;
    }
    // Marker first: a comment that cannot be marked would repeat every run.
    const previousKey = check.deal.UF_CRM_S2L_GZ_OUTCOME || "";
    try {
      await bitrix.updateDeal(check.deal.ID, { ...cardFields, [OUTCOME_FIELD]: check.key });
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

  const summary = summarize(checks, htmlFailed, contractsByBin.failedBins.size, coverage);
  const confirmationLine = `portal_verification=${JSON.stringify(portal.stats)}`;
  summary.markdown += `\n\n\`${confirmationLine}\``;
  const conflicts = formatPortalConflicts(checks.map(check => ({ planNumber: check.ref.planNumber, zakupStatus: check.statusSource === 'api' ? check.plan.status : null, verification: check.verification })));
  if (conflicts) summary.markdown += `\n\n${conflicts}`;
  console.log(confirmationLine);
  const lookupStats = {
    input_without_enstru: inputWithoutEnstru, without_enstru_after_plan_lookup: withoutEnstru,
    recorded_contract_deals_checked: recorded.deals, recorded_contract_numbers_checked: recorded.numbers, recorded_contract_lookup_failed: recorded.failed,
    full_scan_deals_attempted: checks.filter(check => lookup.fullScanPlans.has(check.ref.planNumber ?? 0)).length,
    full_scan_customers: lookup.fullScanBins.size,
    full_scan_limit: args.maxFullScans,
    full_scan_skipped_plans: lookup.fullScanSkippedPlans.size,
    full_scan_skipped_customers: lookup.fullScanSkippedBins.size,
    ...Object.fromEntries(Object.entries(portal.stats).map(([key, value]) => [`portal_${key}`, value])),
    ...Object.fromEntries((["enstru", "lots", "recorded", "full", "ows"] as const).map(path => [`contract_${path}_found`, checks.filter(check => check.contractSource === path).length])),
    ...Object.fromEntries((["q", "enstru", "lots", "full", "ows"] as const).map(path => [`plan_${path}_found`, checks.filter(check => lookup.planSources.get(check.ref.planNumber ?? 0) === path).length]))
  };
  console.log(`lookup_stats=${JSON.stringify(lookupStats)}`);
  console.log(summary.line);
  if (summary.warning) console.log(`::warning::${summary.warning}`);
  writeReport(args.reportPath, args.execute, checks, summary.markdown, lookupStats);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.markdown}\n`);
}

/** Проверяем текущие публичные данные по известному номеру, когда индекс ЕНС ТРУ не вернул прежний договор. */
async function fillRecordedContracts(
  checks: DealCheck[],
  contracts: Map<string, GzOutcomeContract[]> & { failedBins: Set<string> },
  lookup: GzPlanLookup,
  currentYear: number
): Promise<{ deals: number; numbers: number; failed: number }> {
  const groups = new Map<string, { bin: string; number: string; checks: DealCheck[] }>();
  for (const check of checks) {
    const marker = /^(?:won|lost|partner|terminated):(.+)$/.exec(check.deal.UF_CRM_S2L_GZ_OUTCOME ?? "");
    if (!marker || !check.bin || contracts.failedBins.has(check.bin)) continue;
    const number = contractBaseNumber(marker[1]);
    if ((contracts.get(check.bin) ?? []).some(contract => contractBaseNumber(String(contract.contractNumberSys ?? "")) === number)) continue;
    const key = `${check.bin}:${number}`;
    const group = groups.get(key) ?? { bin: check.bin, number, checks: [] };
    group.checks.push(check); groups.set(key, group);
  }
  const stats = { deals: [...groups.values()].reduce((sum, group) => sum + group.checks.length, 0), numbers: groups.size, failed: 0 };
  console.log(`recorded contract lookup: deals=${stats.deals} numbers=${stats.numbers}`);
  await mapLimit([...groups.values()], 4, async group => {
    const years = new Set<number>();
    for (const check of checks.filter(check => check.bin === group.bin)) {
      const year = Number(check.deal.DATE_CREATE?.slice(0, 4)) || currentYear;
      years.add(year); if (year < currentYear) years.add(year + 1);
    }
    try {
      const found = await lookup.contractsByNumbers(group.bin, [...years], [group.number]);
      const rows = contracts.get(group.bin) ?? [];
      const known = new Set(rows.map(row => JSON.stringify(row)));
      for (const row of found) if (!known.has(JSON.stringify(row))) rows.push(row);
      contracts.set(group.bin, rows);
    } catch (error) {
      stats.failed += group.checks.length;
      for (const check of group.checks) check.skipped = "recorded contract unavailable";
      console.warn(`[recorded-contract] BIN ${group.bin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return stats;
}

function fillLookupContexts(checks: DealCheck[], contexts: Map<number, GzPlanContext>): void {
  for (const check of checks) {
    const year = Number(check.deal.DATE_CREATE?.slice(0, 4));
    if (!check.bin || !year) continue;
    const existing = check.ref.planNumber ? contexts.get(check.ref.planNumber) : undefined;
    const context = existing?.bin === check.bin ? existing : { bin: check.bin, year };
    context.codes = fullEnstruCodes(context.codes, check.ref.enstruCode);
    context.pointIds = [...new Set([...(context.pointIds ?? []), ...check.ref.pointIds])];
    for (const id of [check.ref.planNumber, ...check.ref.pointIds]) if (id) contexts.set(id, context);
  }
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
async function fillApiPlanStatuses(checks: DealCheck[], gql: GzPlanLookupOptions, families: GzItemFamilies): Promise<void> {
  const byRoot = await fetchPlans("root", uniqueInts(checks.map((check) => check.ref.planNumber)), gql);
  const byId = await fetchPlans("id", uniqueInts(checks.flatMap((check) => check.ref.pointIds)).filter(id => !byRoot.some(plan => plan.id === id)), gql);
  byId.push(...byRoot);
  const current = new Map<number, ApiPlan>();
  for (const plan of byRoot) {
    const root = plan.rootrecordId ?? plan.id;
    const known = current.get(root);
    if (plan.isActive !== 0 && !plan.isDeleted && (!known || plan.id > known.id)) current.set(root, plan);
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
      .find((item) => item && !item.isDeleted && item.subjectBiin === check.bin && (item.plnPointYear ?? 0) >= dealYear);
    const verified = check.ref.planNumberVerified
      || (root !== null && ownPlan?.rootrecordId === root)
      || rootRevisions.some((id) => check.ref.pointIds.includes(id));
    check.ref = withRevisions({ ...check.ref, planNumberVerified: verified }, rootRevisions);
    // An unconfirmed plan number may belong to another item: the deal's own point speaks first.
    const plan = verified
      ? (root ? current.get(root) : undefined) ?? ownPlan
      : ownPlan ?? (root ? current.get(root) : undefined);
    if (!plan || plan.subjectBiin !== check.bin || (plan.plnPointYear ?? 0) < dealYear) continue;
    check.plan = readGzPlanSignal(check.ref, {
      status: plan.RefPlnPointStatus?.nameRu?.trim() || null,
      enstruCode: plan.refEnstruCode,
      name: plan.nameRu,
      exactPoint: check.ref.pointIds.includes(plan.id)
    }, families);
    check.statusSource = "api";
    check.planVersion = plan.id;
    check.bin ??= /^\d{12}$/.test(plan.subjectBiin ?? "") ? plan.subjectBiin! : null;
  }
}

async function fetchPlans(by: "root" | "id", ids: number[], gql: GzPlanLookupOptions): Promise<ApiPlan[]> {
  const plans: ApiPlan[] = [];
  await mapLimit(ids, 4, async (id) => {
    try { plans.push(...await fetchGzPlans([id], by, gql)); }
    catch (error) { console.warn(`[plans-${by}] ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  });
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
  budgetMs: number,
  families: GzItemFamilies,
  portal: PortalPlanVerifier
): Promise<OutcomeCoverageInput["status"]> {
  const ordered = [...pending].sort((a, b) => Number(a.deal.ID) - Number(b.deal.ID));
  const runSlot = Math.floor(Date.now() / HTML_ROTATION_MS);
  const start = ordered.length > 0 ? (runSlot * limit) % ordered.length : 0;
  const slice = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, limit);
  console.log(`html status: pending=${pending.length} checking=${slice.length} from=${start}`);

  const startedAt = Date.now();
  let failed = 0;
  let attempted = 0;
  let budgetReached = false;
  for (const check of slice) {
    if (Date.now() - startedAt >= budgetMs) {
      budgetReached = true;
      console.warn(`html status: time budget of ${Math.round(budgetMs / 60_000)} min reached, the rest waits for the next run`);
      break;
    }
    attempted += 1;
    try {
      const rows = await portal.search(check.ref.planNumber!);
      // A plan the API still knows is not gone, whatever the search returned.
      check.planMissing = check.statusSource !== "api" && !rows.some((item) => item.plan_list_number === String(check.ref.planNumber));
      check.ref = withRevisions(check.ref, rows.map((item) => Number(item.plan_point_id)));
      const row = [...rows].sort((a, b) => Number(b.plan_point_id) - Number(a.plan_point_id))[0];
      if (row?.status) {
        check.plan = readGzPlanSignal(check.ref, {
          status: row.status.trim(),
          name: row.item_name,
          exactPoint: check.ref.pointIds.includes(Number(row.plan_point_id))
        }, families);
        check.statusSource = "html";
        // Без версии zakup нельзя подтвердить изменение статуса из zakup.
        check.planVersion ??= Number(row.plan_point_id);
      }
    } catch (error) {
      if (error instanceof HtmlBudgetError) { budgetReached = true; break; }
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[html-status] plan ${check.ref.planNumber}: ${message}`);
      if (error instanceof PortalThrottledError) {
        console.warn("html status: portal keeps throttling, the rest waits for the next run");
        break;
      }
    }
    // Пауза между запросами реестра общая с подтверждением новых итогов.
  }
  return { pending: pending.length, attempted, failed, budgetReached };
}

/**
 * A plan the register no longer knows: the customer's whole register tells a
 * wrong number, a plan moved under another number, or a deleted one. Rare
 * enough (a few deals a run) to read every page of the customer.
 */
async function fillCustomerRegisters(missing: DealCheck[], delayMs: number): Promise<number> {
  const byBin = new Map<string, DealCheck[]>();
  for (const check of missing) byBin.set(check.bin!, [...(byBin.get(check.bin!) ?? []), check]);
  console.log(`customer registers: missing_plans=${missing.length} customers=${byBin.size}`);

  let failed = 0;
  for (const [bin, binChecks] of byBin) {
    const years = [...new Set(binChecks.flatMap((check) => {
      const year = Number(String(check.deal.DATE_CREATE ?? "").slice(0, 4));
      return year ? [year, year + 1] : [];
    }))];
    try {
      const rows = await customerRegisterRows(bin, years, delayMs);
      for (const check of binChecks) check.registerRows = rows;
    } catch (error) {
      failed += 1;
      console.warn(`[customer-register] BIN ${bin}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof PortalThrottledError) break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return failed;
}

async function customerRegisterRows(bin: string, years: number[], delayMs: number): Promise<GzRegisterPlanRow[]> {
  const filter = [`filter%5Bcustomer%5D=${bin}`, ...years.map((year) => `filter%5Byear%5D%5B%5D=${year}`)].join("&");
  const rows: GzRegisterPlanRow[] = [];
  // The register numbers pages from 1; page=1 is the first page.
  for (let page = 1; ; page++) {
    if (page > REGISTER_MAX_PAGES) throw new Error(`more than ${REGISTER_MAX_PAGES} register pages`);
    const items = await fetchRegisterRows(`${GZ_PORTAL_ORIGIN}/ru/registry/plan?${filter}&count_record=${REGISTER_PAGE_SIZE}&page=${page}`);
    rows.push(...items.flatMap(toRegisterRow));
    if (items.length < REGISTER_PAGE_SIZE) return rows;
    if (delayMs > 0) await sleep(delayMs);
  }
}

function toRegisterRow(item: GoszakupPlanListItem): GzRegisterPlanRow[] {
  const planNumber = Number(item.plan_list_number);
  const pointId = Number(item.plan_point_id);
  if (!Number.isInteger(planNumber) || planNumber <= 0) return [];
  return [{
    planNumber,
    pointId,
    itemName: item.item_name,
    amount: parseTenge(item.planned_amount),
    status: item.status?.trim() || null,
    url: portalPlanUrl(item.detail_url)
  }];
}

/**
 * The deal's own plan page names the customer BIN and the item code that old
 * cards lack. Without the BIN the customer's contracts stay unknown; without
 * the code a contract on an unindexed revision cannot be matched. Either way
 * a won deal would read «победителя определить не удалось».
 */
async function fillFromPlanPages(checks: DealCheck[], delayMs: number): Promise<OutcomeCoverageInput["planPages"]> {
  const pending = checks.filter((check) => (!check.bin || !check.ref.enstruCode) && check.planUrl);
  console.log(`plan pages: pending=${pending.length}`);
  let failed = 0;
  for (const check of pending) {
    try {
      const detail = parseGoszakupPlanDetailHtml(await fetchPortalPage(check.planUrl!), String(check.ref.pointIds[0] ?? ""));
      const bin = detail?.customer_bin ?? "";
      const code = String(detail?.ref_enstru_code ?? "").trim();
      check.bin ??= /^\d{12}$/.test(bin) ? bin : null;
      if (!check.ref.enstruCode && /^\d{6}/.test(code)) check.ref = { ...check.ref, enstruCode: code };
    } catch (error) {
      failed += 1;
      console.warn(`[plan-page] deal ${check.deal.ID}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof PortalThrottledError) break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return { pending: pending.length, failed };
}

function withRevisions(ref: GzDealPlanRef, ids: number[]): GzDealPlanRef {
  const fresh = ids.filter((id) => !ref.pointIds.includes(id) && !ref.revisionIds.includes(id));
  return fresh.length === 0 ? ref : { ...ref, revisionIds: [...ref.revisionIds, ...fresh] };
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
  gql: GzPlanLookupOptions,
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
      const contracts = await gql.lookup!.contracts(bin, [...binYears]);
      result.set(bin, contracts);
    } catch (error) {
      result.failedBins.add(bin);
      console.warn(`[contracts] BIN ${bin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return result;
}

function summarize(
  checks: DealCheck[],
  htmlFailed: number,
  contractsFailed: number,
  coverageInput: OutcomeCoverageInput
): { line: string; markdown: string; warning: string | null } {
  const coverage = describeOutcomeCoverage(coverageInput);
  const kinds = ["won", "lost", "partner", "terminated", "repurposed", "published", "failed", "cancelled", "contract-draft",
    "plan-renumbered", "plan-moved"] as const;
  const fresh = (kind: string) => checks.filter((check) => check.isNew && check.outcome?.kind === kind).length;
  const counts = kinds.map((kind) => `${kind.replaceAll("-", "_")}=${fresh(kind)}`).join(" ");
  const line = `outcomes: checked=${checks.length} ${counts} unchanged=${checks.filter((check) => check.key && !check.isNew).length}`
    + ` no_signal=${checks.filter((check) => !check.key && !check.skipped).length} skipped=${checks.filter((check) => check.skipped).length} no_bin=${checks.filter((check) => !check.bin).length}`
    + ` status_api=${checks.filter((check) => check.statusSource === "api").length} status_html=${checks.filter((check) => check.statusSource === "html").length}`
    + ` html_failed=${htmlFailed} contracts_failed=${contractsFailed} errors=${checks.filter((check) => check.error).length}`
    + ` ${coverage.line}`;

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
      + ` объявлено ${fresh("published")}, не состоялось ${fresh("failed")}, отменено ${fresh("cancelled")}, договор на подписании ${fresh("contract-draft")},`
      + ` номер плана исправлен ${fresh("plan-renumbered")}, сделка переведена на новый план ${fresh("plan-moved")}.`,
    "",
    coverage.markdown,
    "",
    ...(wins.length ? ["**Новые победы:**", ...wins.map((check) => `- сделка ${check.deal.ID}: ${describeContract(check.outcome!)}`), ""] : []),
    "**Кому уходят открытые сделки (все известные договоры):**",
    ...[...competitors.entries()].sort((a, b) => b[1].deals - a[1].deals).slice(0, 10)
      .map(([name, entry]) => `- ${name}: ${entry.deals} сделок, ${Math.round(entry.sum).toLocaleString("ru-RU")} ₸`),
    "",
    `\`${line}\``
  ].join("\n");
  return { line, markdown, warning: coverage.warning };
}

function describeContract(outcome: GzDealOutcome): string {
  if ("contractNumber" in outcome) {
    return `договор ${outcome.contractNumber} от ${outcome.signDate}${outcome.unitSum ? `, ${Math.round(outcome.unitSum).toLocaleString("ru-RU")} ₸` : ""}`;
  }
  return gzDealOutcomeKey(outcome);
}

function writeReport(reportPath: string, execute: boolean, checks: DealCheck[], markdown: string, lookupStats: Record<string, number>): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    generatedAt: new Date().toISOString(),
    summary: markdown,
    lookup: lookupStats,
    deals: checks.map((check) => ({
      dealId: check.deal.ID,
      categoryId: check.deal.CATEGORY_ID ?? null,
      assignedById: check.deal.ASSIGNED_BY_ID ?? null,
      planNumber: check.ref.planNumber,
      pointIds: check.ref.pointIds,
      revisionIds: check.ref.revisionIds,
      enstruCode: check.ref.enstruCode,
      itemName: check.ref.itemName,
      planNumberVerified: check.ref.planNumberVerified,
      bin: check.bin,
      plan: check.plan,
      statusSource: check.statusSource,
      outcome: check.outcome,
      contractSource: check.contractSource,
      key: check.key,
      previousKey: check.deal.UF_CRM_S2L_GZ_OUTCOME ?? null,
      isNew: check.isNew,
      applied: check.applied,
      error: check.error,
      skipped: check.skipped,
      verification: check.verification,
      planVersion: check.planVersion
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

  /** Deals of any stage that carry one of the plan numbers, by plan number. */
  async dealsByPlanNumbers(planNumbers: number[]): Promise<Map<number, string>> {
    const found = new Map<number, string>();
    const commands = planNumbers.flatMap((plan) => PLAN_NUMBER_FIELDS.map((field) => ({
      key: `${field}_${plan}`,
      method: "crm.deal.list",
      params: { filter: { [field]: String(plan) }, select: ["ID"], order: { ID: "ASC" } }
    })));
    for (const chunk of chunkBatchCommands(commands)) {
      for (const [key, outcome] of await callBitrixBatch(this.baseUrl, chunk)) {
        if (outcome.error) throw new Error(`deals by plan ${key}: ${outcome.error.error_description || outcome.error.error}`);
        const first = (outcome.result as Array<{ ID: string }> | undefined)?.[0];
        const plan = Number(key.slice(key.lastIndexOf("_") + 1));
        if (first && !found.has(plan)) found.set(plan, String(first.ID));
      }
    }
    return found;
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
