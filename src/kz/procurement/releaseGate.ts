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

/**
 * Допуск сбора до production-отправки.
 *
 * Конфликт года блокирует: он означает, что запись пришла не из того периода, под который её запросили.
 * Неразрешённый будущий год и недоступный статус — предупреждения: во втором полугодии следующий
 * год ещё не открыт в справочнике EPZ, и это нормальное состояние источника, а не сбой сбора.
 */
export function evaluateProcurementCollectionGate(
  collection: ProcurementCollectionCompleteness
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!collection.complete) reasons.push("collection_incomplete", ...collection.incompleteReasons);
  if ((collection.yearConflicts ?? 0) > 0) reasons.push(`plan_year_conflicts:${collection.yearConflicts}`);
  return { ok: reasons.length === 0, reasons };
}
import type { ProcurementCollectionCompleteness } from "./types.js";
