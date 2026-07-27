export type AutomationStatus =
  | "preparing"
  | "ready"
  | "failed"
  | "pushing"
  | "pushed"
  | "applying"
  | "applied"
  | "applied_ai_failed";

export type StageStatus = "running" | "succeeded" | "failed";

/**
 * `plans-only` collects and pushes plans; lots and AI analysis stay out of the run.
 * `f3-b2b` collects the external procurement sources into the F3-B2B pipeline; it touches no GZ stage.
 */
export type AutomationWorkflow = "plans-and-lots" | "plans-only" | "f3-b2b";

/**
 * `prepare` stops a scheduled run at `ready`, leaving the push to a separate, deliberate step.
 * F3 stays in `prepare` until production sending is turned on by its own change.
 */
export type AutomationDeliveryMode = "prepare" | "push";

export interface AutomationStage {
  status: StageStatus;
  startedAt: string;
  finishedAt?: string;
  counts?: Record<string, number>;
  error?: string;
}

export interface AutomationArtifact {
  path: string;
  sha256: string;
  rows?: number;
}

export interface AutomationManifest {
  /** v4 adds the `procurement*` artifact keys; v1/v2 lack `workflow`, read it via `manifestWorkflow`. */
  schemaVersion: 1 | 2 | 3 | 4;
  runId: string;
  /** Absent in v1/v2 manifests, which are always full plans-and-lots runs. Read via `manifestWorkflow`. */
  workflow?: AutomationWorkflow;
  status: AutomationStatus;
  createdAt: string;
  updatedAt: string;
  recoveredLockRunId: string | null;
  config: { path: string; sha256: string };
  stages: Record<string, AutomationStage>;
  artifacts: Partial<Record<
    "plans" | "lots" | "plansDryRun" | "lotsDryRun" | "procurementXlsx" | "procurementReport" | "procurementDryRun",
    AutomationArtifact
  >>;
  errors: Array<{ stage: string; message: string; at: string }>;
  push: { startedAt: string } | null;
  approval: { requestedAt: string } | null;
}

export interface AutomationConfig {
  sourcePath?: string;
  workflow: AutomationWorkflow;
  deliveryMode: AutomationDeliveryMode;
  runsDir: string;
  keepSuccessfulRuns: number;
  lockPath: string;
  staleLockMinutes: number;
  plansConfig: string;
  lotsConfig: string;
  /** Collector config for the `f3-b2b` workflow. Unused by the GZ workflows. */
  procurementConfig: string;
  periodMonths: number;
  approvalLimit: number | null;
}

export interface RollingPeriod { year: number; months: number[] }

export interface AutomationStepResult {
  counts: Record<string, number>;
  criticalErrors?: string[];
  /** Observations worth reporting that must not fail the run. */
  warnings?: string[];
  output?: string;
}

export interface AutomationExportResult {
  path: string;
  rows: number;
  /** Plan-detail cache metrics, summed across periods. Absent for stages without a detail cache (lots). */
  cacheHit?: number;
  cacheMiss?: number;
  fetched?: number;
  fetchFailed?: number;
}

/** Collect result of the external procurement sources: both artifacts plus the run counters. */
export interface ProcurementCollectResult extends AutomationStepResult {
  xlsxPath: string;
  jsonPath: string;
}

/**
 * The `f3-b2b` stages, grouped into one adapter.
 *
 * A single optional member keeps every existing GZ dependency factory — production and test —
 * valid without change; the orchestrator fails loudly if an `f3-b2b` run reaches it unset.
 */
export interface ProcurementAutomationAdapter {
  collect: (configPath: string, outputDir: string, years: number[]) => Promise<ProcurementCollectResult>;
  dryRun: (reportPath: string, outputPath: string) => Promise<AutomationStepResult>;
  apply: (reportPath: string, limit: number | null) => Promise<AutomationStepResult>;
}

export interface AutomationDependencies {
  exportPlans: (configPath: string, outputPath: string, periods: RollingPeriod[]) => Promise<AutomationExportResult>;
  exportLots: (configPath: string, outputPath: string, periods: RollingPeriod[]) => Promise<AutomationExportResult>;
  dryRunPlans: (inputPath: string, reportPath: string) => Promise<AutomationStepResult>;
  dryRunLots: (inputPath: string, reportPath: string) => Promise<AutomationStepResult>;
  applyPlans: (inputPath: string, limit: number | null) => Promise<AutomationStepResult>;
  applyLots: (inputPath: string, limit: number | null) => Promise<AutomationStepResult>;
  analyzeLots: (inputPath: string, limit: number | null) => Promise<AutomationStepResult>;
  procurement?: ProcurementAutomationAdapter;
}
