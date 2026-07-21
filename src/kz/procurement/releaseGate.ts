export interface ProcurementManualRun {
  runId: string;
  irrelevantProducts: number;
  automaticDuplicates: number;
  assignmentVerified: boolean;
}

export function evaluateProcurementReleaseGate(
  runs: ProcurementManualRun[],
  requiredRuns = 7
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const uniqueRuns = new Map(runs.map((run) => [run.runId, run]));
  if (uniqueRuns.size < requiredRuns) reasons.push(`manual_runs_missing:${uniqueRuns.size}/${requiredRuns}`);
  if ([...uniqueRuns.values()].some((run) => run.irrelevantProducts > 0)) reasons.push("irrelevant_products_present");
  if ([...uniqueRuns.values()].some((run) => run.automaticDuplicates > 0)) reasons.push("automatic_duplicates_present");
  if ([...uniqueRuns.values()].some((run) => !run.assignmentVerified)) reasons.push("assignment_not_verified");
  return { ok: reasons.length === 0, reasons };
}
