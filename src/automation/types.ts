export type AutomationStatus =
  | "preparing"
  | "ready"
  | "failed"
  | "applying"
  | "applied"
  | "applied_ai_failed";

export type StageStatus = "running" | "succeeded" | "failed";

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
  schemaVersion: 1;
  runId: string;
  status: AutomationStatus;
  createdAt: string;
  updatedAt: string;
  recoveredLockRunId: string | null;
  config: { path: string; sha256: string };
  stages: Record<string, AutomationStage>;
  artifacts: Partial<Record<"plans" | "lots" | "plansDryRun" | "lotsDryRun", AutomationArtifact>>;
  errors: Array<{ stage: string; message: string; at: string }>;
  approval: { requestedAt: string } | null;
}

export interface AutomationConfig {
  runsDir: string;
  keepSuccessfulRuns: number;
  lockPath: string;
  staleLockMinutes: number;
  plansConfig: string;
  lotsConfig: string;
  periodMonths: number;
  approvalLimit: number | null;
}

export interface RollingPeriod { year: number; months: number[] }

export interface AutomationStepResult {
  counts: Record<string, number>;
  criticalErrors?: string[];
}

export interface AutomationExportResult { path: string; rows: number }

export interface AutomationDependencies {
  exportPlans: (configPath: string, outputPath: string, periods: RollingPeriod[]) => Promise<AutomationExportResult>;
  exportLots: (configPath: string, outputPath: string, periods: RollingPeriod[]) => Promise<AutomationExportResult>;
  dryRunPlans: (inputPath: string, reportPath: string) => Promise<AutomationStepResult>;
  dryRunLots: (inputPath: string, reportPath: string) => Promise<AutomationStepResult>;
  applyPlans: (inputPath: string, limit: number | null) => Promise<AutomationStepResult>;
  applyLots: (inputPath: string, limit: number | null) => Promise<AutomationStepResult>;
  analyzeLots: (inputPath: string, limit: number | null) => Promise<AutomationStepResult>;
}
