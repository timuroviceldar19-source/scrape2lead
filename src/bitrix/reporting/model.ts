import type {
  CanonicalPhase,
  NormalizedDeal,
  NormalizedReport,
  RawDeal,
  RawStageHistory,
  ReportMetrics,
  ReportingConfig,
  ReportingLookups
} from "./types.js";

export type { RawDeal, RawStageHistory, ReportingConfig } from "./types.js";

const STAGE_MAP: Record<number, Record<string, CanonicalPhase>> = {
  9: {
    "C9:NEW": "new", "C9:UC_KQEL1P": "assigned", "C9:PREPARATION": "assigned",
    "C9:UC_BP8G9D": "qualified", "C9:UC_O85E7B": "proposal", "C9:UC_HB4Z3U": "tender_or_budget",
    "C9:UC_S8P651": "contract_or_fulfillment", "C9:UC_9E7STG": "contract_or_fulfillment",
    "C9:UC_IYOPUR": "tender_or_budget", "C9:WON": "won", "C9:LOSE": "lost", "C9:APOLOGY": "lost",
    "C9:1": "lost", "C9:2": "lost", "C9:3": "lost", "C9:4": "lost", "C9:5": "lost",
    "C9:6": "lost", "C9:7": "lost", "C9:8": "lost", "C9:9": "lost"
  },
  29: {
    "C29:NEW": "new", "C29:PREPARATION": "assigned", "C29:PREPAYMENT_INVOIC": "proposal",
    "C29:EXECUTING": "tender_or_budget", "C29:FINAL_INVOICE": "contract_or_fulfillment",
    "C29:WON": "excluded", "C29:LOSE": "excluded", "C29:APOLOGY": "lost"
  },
  41: {
    "C41:NEW": "new", "C41:PREPARATION": "assigned", "C41:PREPAYMENT_INVOIC": "qualified",
    "C41:EXECUTING": "tender_or_budget", "C41:UC_3J3PDR": "excluded", "C41:WON": "won",
    "C41:LOSE": "lost", "C41:APOLOGY": "lost", "C41:DUPLICATE": "excluded"
  },
  43: {
    "C43:NEW": "new", "C43:PREPARATION": "assigned", "C43:PREPAYMENT_INVOIC": "qualified",
    "C43:EXECUTING": "proposal", "C43:FINAL_INVOICE": "tender_or_budget", "C43:WON": "won",
    "C43:LOSE": "lost", "C43:APOLOGY": "lost"
  }
};

export function mapCanonicalPhase(categoryId: number, stageId: string, semantic = ""): CanonicalPhase {
  const mapped = STAGE_MAP[categoryId]?.[stageId];
  if (mapped) return mapped;
  if ([9, 29, 41, 43].includes(categoryId)) return "legacy_unknown";
  if (semantic === "S") return "won";
  if (semantic === "F") return "lost";
  return "legacy_unknown";
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000));
}

function eventOrder(a: RawStageHistory, b: RawStageHistory): number {
  return new Date(a.CREATED_TIME).getTime() - new Date(b.CREATED_TIME).getTime() || Number(a.ID) - Number(b.ID);
}

function roleFor(categories: number[], config: ReportingConfig): "sales_funnel" | "routing_queue" | "context_only" {
  if (categories.some((id) => config.salesPipelineIds.includes(id))) return "sales_funnel";
  if (categories.some((id) => config.routingPipelineIds.includes(id))) return "routing_queue";
  return "context_only";
}

export function buildNormalizedReport(
  rawDeals: RawDeal[],
  rawHistory: RawStageHistory[],
  config: ReportingConfig,
  lookups: ReportingLookups = {}
): NormalizedReport {
  const grouped = new Map<string, RawStageHistory[]>();
  for (const item of rawHistory) {
    const id = String(item.OWNER_ID);
    const events = grouped.get(id) ?? [];
    events.push(item);
    grouped.set(id, events);
  }
  for (const events of grouped.values()) events.sort(eventOrder);

  const migrations: NormalizedReport["migrations"] = [];
  const deals: NormalizedDeal[] = [];
  for (const raw of rawDeals) {
    const id = String(raw.ID);
    const history = grouped.get(id) ?? [];
    const currentCategory = Number(raw.CATEGORY_ID);
    let previousCategory: number | null = null;
    for (const item of history) {
      const category = Number(item.CATEGORY_ID);
      if (String(item.TYPE_ID) === "5") {
        migrations.push({ dealId: id, at: item.CREATED_TIME, fromPipelineId: previousCategory, toPipelineId: category });
      }
      previousCategory = category;
    }
    const categories = [...history.map((item) => Number(item.CATEGORY_ID)), currentCategory];
    const pipelineRole = roleFor(categories, config);
    if (pipelineRole === "context_only" && !config.servicePipelineIds.includes(currentCategory)) continue;
    const firstSales = history.find((item) => config.salesPipelineIds.includes(Number(item.CATEGORY_ID)));
    const firstRouting = history.find((item) => config.routingPipelineIds.includes(Number(item.CATEGORY_ID)));
    const cohortEntryAt = firstSales?.CREATED_TIME ?? firstRouting?.CREATED_TIME ?? raw.DATE_CREATE;
    const last = history.at(-1);
    const semantic = last?.STAGE_ID === raw.STAGE_ID ? last.STAGE_SEMANTIC_ID ?? "" : "";
    const canonicalPhase = mapCanonicalPhase(currentCategory, raw.STAGE_ID, semantic);
    const lastMigration = [...history].reverse().find((item) => String(item.TYPE_ID) === "5");
    const handoff = pipelineRole === "sales_funnel" && currentCategory === 17 && Number(lastMigration?.CATEGORY_ID) === 17;
    let outcome: NormalizedDeal["outcome"] = "open";
    if (handoff) outcome = "handoff_service";
    else if (pipelineRole === "routing_queue" && currentCategory === 29 && ["C29:WON", "C29:LOSE"].includes(raw.STAGE_ID)) outcome = "routed";
    else if (canonicalPhase === "won") outcome = "won";
    else if (canonicalPhase === "lost") outcome = "lost";
    else if (canonicalPhase === "excluded") outcome = "excluded";
    else if (canonicalPhase === "legacy_unknown") outcome = "unknown";
    const amount = numeric(raw.OPPORTUNITY);
    const managerId = String(raw.ASSIGNED_BY_ID ?? "");
    const companyId = String(raw.COMPANY_ID ?? "");
    const lastStageAt = last?.CREATED_TIME ?? raw.DATE_MODIFY ?? raw.DATE_CREATE;
    deals.push({
      id, title: raw.TITLE, pipelineId: currentCategory,
      pipelineName: lookups.pipelineNames?.[String(currentCategory)] ?? `Воронка ${currentCategory}`,
      pipelineRole, rawStageId: raw.STAGE_ID,
      rawStageName: lookups.stageNames?.[raw.STAGE_ID] ?? raw.STAGE_ID,
      canonicalPhase, outcome, amount, hasPositiveAmount: amount > 0,
      currency: raw.CURRENCY_ID ?? "KZT", createdAt: raw.DATE_CREATE, cohortEntryAt, lastStageAt,
      ageDays: daysBetween(lastStageAt, config.asOf), managerId,
      managerName: lookups.managerNames?.[managerId] ?? (managerId ? `ID ${managerId}` : "Не назначен"),
      companyId, companyName: lookups.companyNames?.[companyId] ?? (companyId && companyId !== "0" ? `ID ${companyId}` : "Без компании"),
      sourceId: raw.SOURCE_ID ?? "", dealUrl: lookups.portalBaseUrl ? `${lookups.portalBaseUrl}/crm/deal/details/${id}/` : ""
    });
  }
  return { deals, migrations };
}

function reportDay(iso: string, asOf: string): string {
  const offset = asOf.match(/([+-])(\d{2}):(\d{2})$/);
  const offsetMinutes = offset
    ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]))
    : 0;
  return new Date(new Date(iso).getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function inPeriod(iso: string, from: string, to: string, asOf: string): boolean {
  const day = reportDay(iso, asOf);
  return day >= from && day <= to;
}

export function computeReportMetrics(report: NormalizedReport, config: ReportingConfig): ReportMetrics {
  const sales = report.deals.filter((deal) => deal.pipelineRole === "sales_funnel");
  const routing = report.deals.filter((deal) => deal.pipelineRole === "routing_queue");
  const won = sales.filter((deal) => deal.outcome === "won");
  const lost = sales.filter((deal) => deal.outcome === "lost");
  const open = sales.filter((deal) => deal.outcome === "open" || deal.outcome === "unknown");
  const denominator = won.length + lost.length;
  const selectedCurrent = report.deals.filter((deal) => config.selectedPipelineIds.includes(deal.pipelineId));
  const amountCoverageRate = selectedCurrent.length ? selectedCurrent.filter((deal) => deal.hasPositiveAmount).length / selectedCurrent.length : 0;
  const ageBuckets: ReportMetrics["ageBuckets"] = { "0-7": 0, "8-14": 0, "15-30": 0, "31-60": 0, "61+": 0 };
  for (const deal of open) {
    if (deal.ageDays <= 7) ageBuckets["0-7"]++;
    else if (deal.ageDays <= 14) ageBuckets["8-14"]++;
    else if (deal.ageDays <= 30) ageBuckets["15-30"]++;
    else if (deal.ageDays <= 60) ageBuckets["31-60"]++;
    else ageBuckets["61+"]++;
  }
  const phases = new Map<CanonicalPhase, { deals: number; amount: number }>();
  const pipelines = new Map<number, { name: string; deals: number; amount: number }>();
  for (const deal of open) {
    const phase = phases.get(deal.canonicalPhase) ?? { deals: 0, amount: 0 };
    phase.deals++; phase.amount += deal.amount; phases.set(deal.canonicalPhase, phase);
  }
  for (const deal of report.deals) {
    const pipeline = pipelines.get(deal.pipelineId) ?? { name: deal.pipelineName, deals: 0, amount: 0 };
    pipeline.deals++; pipeline.amount += deal.amount; pipelines.set(deal.pipelineId, pipeline);
  }
  const monthlyComparison = Array.from({ length: 7 }, (_, index) => ({ month: index + 1, current: 0, previous: 0 }));
  for (const deal of sales) {
    const month = Number(reportDay(deal.cohortEntryAt, config.asOf).slice(5, 7));
    if (inPeriod(deal.cohortEntryAt, config.currentPeriod.from, config.currentPeriod.to, config.asOf) && month <= 7) monthlyComparison[month - 1].current++;
    if (inPeriod(deal.cohortEntryAt, config.previousPeriod.from, config.previousPeriod.to, config.asOf) && month <= 7) monthlyComparison[month - 1].previous++;
  }
  const losses = new Map<string, number>();
  for (const deal of lost) losses.set(deal.rawStageName, (losses.get(deal.rawStageName) ?? 0) + 1);
  const migrationCounts = new Map<string, number>();
  for (const migration of report.migrations) {
    const route = `${migration.fromPipelineId ?? "?"} → ${migration.toPipelineId}`;
    migrationCounts.set(route, (migrationCounts.get(route) ?? 0) + 1);
  }
  return {
    totalDeals: report.deals.length, salesDeals: sales.length, routingDeals: routing.length, openDeals: open.length,
    wonDeals: won.length, lostDeals: lost.length, conversionRate: denominator ? won.length / denominator : null,
    amountCoverageRate, openAmount: open.reduce((sum, deal) => sum + deal.amount, 0),
    routingAmount: routing.reduce((sum, deal) => sum + deal.amount, 0),
    currentPeriodEntries: sales.filter((deal) => inPeriod(deal.cohortEntryAt, config.currentPeriod.from, config.currentPeriod.to, config.asOf)).length,
    previousPeriodEntries: sales.filter((deal) => inPeriod(deal.cohortEntryAt, config.previousPeriod.from, config.previousPeriod.to, config.asOf)).length,
    ageBuckets,
    byPhase: [...phases].map(([phase, value]) => ({ phase, ...value })).sort((a, b) => b.deals - a.deals),
    byPipeline: [...pipelines].map(([pipelineId, value]) => ({ pipelineId, pipelineName: value.name, deals: value.deals, amount: value.amount })).sort((a, b) => b.deals - a.deals),
    monthlyComparison,
    lossReasons: [...losses].map(([reason, deals]) => ({ reason, deals })).sort((a, b) => b.deals - a.deals),
    migrationSummary: [...migrationCounts].map(([route, deals]) => ({ route, deals })).sort((a, b) => b.deals - a.deals)
  };
}
