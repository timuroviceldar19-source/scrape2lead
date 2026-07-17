export type PipelineRole = "sales_funnel" | "routing_queue" | "context_only";

export type CanonicalPhase =
  | "new"
  | "assigned"
  | "qualified"
  | "proposal"
  | "tender_or_budget"
  | "contract_or_fulfillment"
  | "won"
  | "lost"
  | "excluded"
  | "legacy_unknown";

export type DealOutcome = "open" | "won" | "lost" | "routed" | "handoff_service" | "excluded" | "unknown";

export interface DatePeriod { from: string; to: string }

export interface ReportingConfig {
  asOf: string;
  currentPeriod: DatePeriod;
  previousPeriod: DatePeriod;
  salesPipelineIds: number[];
  routingPipelineIds: number[];
  servicePipelineIds: number[];
  selectedPipelineIds: number[];
  attentionAfterDays: number;
  criticalAfterDays: number;
}

export interface RawDeal {
  ID: string;
  TITLE: string;
  CATEGORY_ID: string | number;
  STAGE_ID: string;
  OPPORTUNITY?: string | number | null;
  CURRENCY_ID?: string;
  DATE_CREATE: string;
  DATE_MODIFY?: string;
  ASSIGNED_BY_ID?: string | number;
  COMPANY_ID?: string | number;
  SOURCE_ID?: string;
}

export interface RawStageHistory {
  ID: string;
  TYPE_ID: string | number;
  OWNER_ID: string | number;
  CREATED_TIME: string;
  CATEGORY_ID: string | number;
  STAGE_SEMANTIC_ID?: string;
  STAGE_ID?: string;
}

export interface ReportingLookups {
  pipelineNames?: Record<string, string>;
  stageNames?: Record<string, string>;
  managerNames?: Record<string, string>;
  companyNames?: Record<string, string>;
  portalBaseUrl?: string;
}

export interface NormalizedDeal {
  id: string;
  title: string;
  pipelineId: number;
  pipelineName: string;
  pipelineRole: PipelineRole;
  rawStageId: string;
  rawStageName: string;
  canonicalPhase: CanonicalPhase;
  outcome: DealOutcome;
  amount: number;
  hasPositiveAmount: boolean;
  currency: string;
  createdAt: string;
  cohortEntryAt: string;
  lastStageAt: string;
  ageDays: number;
  managerId: string;
  managerName: string;
  companyId: string;
  companyName: string;
  sourceId: string;
  dealUrl: string;
}

export interface PipelineMigration {
  dealId: string;
  at: string;
  fromPipelineId: number | null;
  toPipelineId: number;
}

export interface NormalizedReport {
  deals: NormalizedDeal[];
  migrations: PipelineMigration[];
}

export interface ReportMetrics {
  totalDeals: number;
  salesDeals: number;
  routingDeals: number;
  openDeals: number;
  wonDeals: number;
  lostDeals: number;
  conversionRate: number | null;
  amountCoverageRate: number;
  openAmount: number;
  routingAmount: number;
  currentPeriodEntries: number;
  previousPeriodEntries: number;
  ageBuckets: Record<"0-7" | "8-14" | "15-30" | "31-60" | "61+", number>;
  byPhase: Array<{ phase: CanonicalPhase; deals: number; amount: number }>;
  byPipeline: Array<{ pipelineId: number; pipelineName: string; deals: number; amount: number }>;
  monthlyComparison: Array<{ month: number; current: number; previous: number }>;
  lossReasons: Array<{ reason: string; deals: number }>;
  migrationSummary: Array<{ route: string; deals: number }>;
}

export interface StageMappingRow {
  pipelineId: number;
  rawStageId: string;
  rawStageName: string;
  canonicalPhase: CanonicalPhase;
  confidence: "exact" | "legacy_exact" | "unknown";
}

export interface DataQuality {
  amountCoverageRate: number;
  companyCoverageRate: number;
  sourceCoverageRate: number;
  assignedCoverageRate: number;
  unknownStageEvents: number;
  retiredStageKeys: number;
  notes: string[];
}

export interface DashboardPayload {
  generatedAt: string;
  asOfDate: string;
  portalBaseUrl: string;
  metrics: ReportMetrics;
  deals: NormalizedDeal[];
  pipelineNames: Record<string, string>;
  managerNames: Record<string, string>;
  stageMapping: StageMappingRow[];
  dataQuality: DataQuality;
}

export interface SnapshotManifest {
  snapshotAt: string;
  asOfDate: string;
  timeZoneOffset: string;
  sourceCounts: Record<string, number>;
  normalizedCounts: Record<string, number>;
  sha256: Record<string, string>;
  readOnlyMethods: string[];
}
