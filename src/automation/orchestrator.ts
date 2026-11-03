import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireRunLock, cleanupSuccessfulRuns, computeRollingPeriod, createRunId, fileSha256, manifestWorkflow, readManifest, releaseRunLock, writeManifestAtomic } from "./core.js";
import type { AutomationArtifact, AutomationConfig, AutomationDependencies, AutomationExportResult, AutomationManifest, AutomationStage, AutomationStatus, AutomationStepResult, ProcurementCollectResult, RollingPeriod } from "./types.js";
import { GzSourceUnavailableError, isTransientNetworkError } from "../kz/gzCollection.js";

const GZ_BRANCHES = [
  { key: "plans", exportStage: "exportPlans", dryStage: "dryRunPlans", applyStage: "applyPlans", configKey: "plansConfig", reportKey: "plansDryRun" },
  { key: "lots", exportStage: "exportLots", dryStage: "dryRunLots", applyStage: "applyLots", configKey: "lotsConfig", reportKey: "lotsDryRun" }
] as const;

export async function prepareAutomationRun(config: AutomationConfig, deps: AutomationDependencies, now = new Date()): Promise<AutomationManifest> {
  const runId = createRunId(now);
  const runDir = path.resolve(config.runsDir, runId);
  const lock = acquireRunLock(path.resolve(config.lockPath), runId, now, config.staleLockMinutes);
  if (fs.existsSync(runDir)) {
    releaseRunLock(path.resolve(config.lockPath), runId);
    throw new Error(`automation run already exists: ${runId}`);
  }
  fs.mkdirSync(runDir, { recursive: true });
  const manifestPath = path.join(runDir, "manifest.json");
  let manifest: AutomationManifest = {
    schemaVersion: config.workflow === "f3-b2b" ? 4 : 3,
    runId, workflow: config.workflow, status: "preparing", createdAt: now.toISOString(), updatedAt: now.toISOString(),
    recoveredLockRunId: lock.recoveredRunId,
    config: { path: config.sourcePath ?? "config/automation.json", sha256: config.sourcePath && fs.existsSync(config.sourcePath)
      ? fileSha256(config.sourcePath)
      : crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex") },
    stages: {}, artifacts: {}, errors: [], push: null, approval: null
  };
  save(manifestPath, manifest);
  const log = (message: string) => fs.appendFileSync(path.join(runDir, "run.log"), `${new Date().toISOString()} ${message}\n`);
  const periods = computeRollingPeriod(now, config.periodMonths);
  const includeLots = config.workflow === "plans-and-lots";
  try {
    if (config.workflow === "f3-b2b") {
      await prepareProcurementRun(config, deps, manifest, manifestPath, runDir, periods, log);
      manifest.status = "ready"; save(manifestPath, manifest);
      return manifest;
    }
    manifest.preparedBranches = [];
    for (const branch of GZ_BRANCHES.filter(branch => branch.key === "plans" || includeLots)) {
      let stage: string = branch.exportStage;
      try {
        const exported = await runStage(manifest, manifestPath, branch.exportStage,
          () => deps[branch.exportStage](config[branch.configKey], path.join(runDir, `${branch.key}.xlsx`), periods), log);
        manifest.artifacts[branch.key] = artifact(exported.path, exported.rows); save(manifestPath, manifest);
        stage = branch.dryStage;
        const reportPath = path.join(runDir, `${branch.key}-dry-run.json`);
        const dryRun = await runStage(manifest, manifestPath, branch.dryStage, async () => {
          const result = await deps[branch.dryStage](exported.path, reportPath);
          assertNoCriticalErrors(`${branch.key} dry-run`, result);
          return result;
        }, log);
        writeReport(reportPath, dryRun); manifest.artifacts[branch.reportKey] = artifact(reportPath);
        manifest.preparedBranches.push(branch.key); save(manifestPath, manifest);
      } catch (error) {
        // Только временная недоступность изолируется внутри ветки. Валидация и ошибки кода фатальны.
        if (!isTransientNetworkError(error)) throw error;
        recordFailure(manifest, stage, error); save(manifestPath, manifest);
      }
    }
    manifest.status = manifest.preparedBranches.length ? "ready" : "failed"; save(manifestPath, manifest);
  } catch (error) {
    const message = errorMessage(error);
    manifest.status = "failed"; recordFailure(manifest, currentFailedStage(manifest), error);
    save(manifestPath, manifest); log(`FAILED ${message}`);
  } finally {
    writeSummary(path.join(runDir, "summary.txt"), manifest);
    releaseRunLock(path.resolve(config.lockPath), runId);
    cleanupSuccessfulRuns(path.resolve(config.runsDir), config.keepSuccessfulRuns);
  }
  return manifest;
}

export async function approveAutomationRun(config: AutomationConfig, runId: string, deps: AutomationDependencies): Promise<AutomationManifest> {
  const runDir = path.resolve(config.runsDir, runId);
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`automation run not found: ${runId}`);
  const manifest = readManifest(manifestPath);
  const approvalWorkflow = manifestWorkflow(manifest);
  if (approvalWorkflow === "plans-only" || approvalWorkflow === "f3-b2b") {
    throw new Error(`automation run ${runId} is ${approvalWorkflow}: it has no lots to apply and no AI analysis to approve; use "automation:push" to send its records`);
  }
  if (manifest.status === "applied") throw new Error(`automation run already applied: ${runId}`);
  const resumable = manifest.approval !== null && ["failed", "applying", "applied_ai_failed"].includes(manifest.status);
  if (manifest.status !== "ready" && manifest.status !== "pushed" && !resumable) throw new Error(`automation run is not ready: ${manifest.status}`);
  verifyRunArtifacts(manifest);
  manifest.approval ??= { requestedAt: new Date().toISOString() }; manifest.status = "applying"; save(manifestPath, manifest);
  const log = (message: string) => fs.appendFileSync(path.join(runDir, "run.log"), `${new Date().toISOString()} ${message}\n`);
  try {
    await applyGzBranches(config, deps, manifest, manifestPath, log);
  } catch (error) {
    const message = errorMessage(error); manifest.status = "failed";
    recordFailure(manifest, currentFailedStage(manifest), error); save(manifestPath, manifest);
    writeSummary(path.join(runDir, "summary.txt"), manifest); throw error;
  }
  try {
    if (availableBranches(manifest).includes("lots") && manifest.stages.applyLots?.status === "succeeded"
      && manifest.stages.analyzeLots?.status !== "succeeded") {
      await runStage(manifest, manifestPath, "analyzeLots", () => deps.analyzeLots(manifest.artifacts.lots!.path, config.approvalLimit), log);
    }
    manifest.status = "applied";
  } catch (error) {
    const message = errorMessage(error); manifest.status = "applied_ai_failed";
    manifest.errors.push({ stage: "analyzeLots", message, at: new Date().toISOString() });
  }
  save(manifestPath, manifest); writeSummary(path.join(runDir, "summary.txt"), manifest); return manifest;
}

export async function runScheduledAutomation(config: AutomationConfig, deps: AutomationDependencies, now = new Date()): Promise<AutomationManifest> {
  const prepared = await prepareAutomationRun(config, deps, now);
  if (prepared.status !== "ready") return prepared;
  // В режиме `prepare` расписание останавливается на `ready`: отправка включается отдельным изменением.
  if (config.deliveryMode === "prepare") return prepared;
  return pushAutomationRun(config, prepared.runId, deps);
}

export async function pushAutomationRun(config: AutomationConfig, runId: string, deps: AutomationDependencies): Promise<AutomationManifest> {
  const runDir = path.resolve(config.runsDir, runId);
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`automation run not found: ${runId}`);
  const manifest = readManifest(manifestPath);
  if (["pushed", "applying", "applied", "applied_ai_failed"].includes(manifest.status)) throw new Error(`automation run already pushed: ${runId}`);
  const resumable = manifest.push != null && manifest.status === "failed";
  if (manifest.status !== "ready" && !resumable) throw new Error(`automation run is not ready: ${manifest.status}`);
  verifyRunArtifacts(manifest);
  manifest.push ??= { startedAt: new Date().toISOString() }; manifest.status = "pushing"; save(manifestPath, manifest);
  const log = (message: string) => fs.appendFileSync(path.join(runDir, "run.log"), `${new Date().toISOString()} ${message}\n`);
  try {
    if (manifestWorkflow(manifest) === "f3-b2b") {
      const adapter = deps.procurement;
      if (!adapter) throw new Error('workflow "f3-b2b" requires the procurement dependency adapter');
      if (manifest.stages.applyProcurement?.status !== "succeeded") {
        await runStage(manifest, manifestPath, "applyProcurement",
          () => adapter.apply(manifest.artifacts.procurementReport!.path, config.approvalLimit, config.procurementConfig), log);
      }
    } else {
      await applyGzBranches(config, deps, manifest, manifestPath, log);
    }
    manifest.status = "pushed"; save(manifestPath, manifest);
  } catch (error) {
    const message = errorMessage(error); manifest.status = "failed";
    recordFailure(manifest, currentFailedStage(manifest), error); save(manifestPath, manifest);
    writeSummary(path.join(runDir, "summary.txt"), manifest); throw error;
  }
  writeSummary(path.join(runDir, "summary.txt"), manifest); return manifest;
}

function availableBranches(manifest: AutomationManifest): Array<"plans" | "lots"> {
  return manifest.preparedBranches ?? (manifestWorkflow(manifest) === "plans-and-lots" ? ["plans", "lots"] : ["plans"]);
}

async function applyGzBranches(config: AutomationConfig, deps: AutomationDependencies, manifest: AutomationManifest,
  manifestPath: string, log: (message: string) => void): Promise<void> {
  let succeeded = 0;
  let lastError: unknown;
  for (const branch of GZ_BRANCHES.filter(branch => availableBranches(manifest).includes(branch.key))) {
    try {
      if (manifest.stages[branch.applyStage]?.status !== "succeeded") {
        await runStage(manifest, manifestPath, branch.applyStage,
          () => deps[branch.applyStage](manifest.artifacts[branch.key]!.path, config.approvalLimit), log);
      }
      succeeded++;
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;
      lastError = error; recordFailure(manifest, branch.applyStage, error); save(manifestPath, manifest);
    }
  }
  if (!succeeded) throw lastError ?? new Error("no prepared GZ branches to apply");
}

function recordFailure(manifest: AutomationManifest, stage: string, error: unknown): void {
  const message = errorMessage(error);
  if (!manifest.errors.some(item => item.stage === stage && item.message === message)) {
    manifest.errors.push({ stage, message, at: new Date().toISOString() });
  }
}

/**
 * Стадии F3: сбор -> dry-run Bitrix -> краткий отчёт прогона.
 *
 * Отправка сюда не входит: за неё отвечает `pushAutomationRun`, который для F3 вызывается
 * только при `deliveryMode: "push"`.
 */
async function prepareProcurementRun(
  config: AutomationConfig,
  deps: AutomationDependencies,
  manifest: AutomationManifest,
  manifestPath: string,
  runDir: string,
  periods: RollingPeriod[],
  log: (message: string) => void
): Promise<void> {
  const adapter = deps.procurement;
  if (!adapter) throw new Error('workflow "f3-b2b" requires the procurement dependency adapter');

  const years = periods.map((period) => period.year);
  const collected = await runStage(manifest, manifestPath, "collectProcurement", async () => {
    const result = await adapter.collect(config.procurementConfig, runDir, years);
    assertNoCriticalErrors("procurement collection", result);
    return result;
  }, log);
  manifest.artifacts.procurementXlsx = artifact(collected.xlsxPath);
  manifest.artifacts.procurementReport = artifact(collected.jsonPath);
  save(manifestPath, manifest);

  const dryRunPath = path.join(runDir, "f3-dry-run.json");
  const dryRun = await runStage(manifest, manifestPath, "dryRunProcurement", async () => {
    const result = await adapter.dryRun(collected.jsonPath, dryRunPath, config.procurementConfig);
    assertNoCriticalErrors("procurement dry-run", result);
    return result;
  }, log);
  writeReport(dryRunPath, dryRun);
  manifest.artifacts.procurementDryRun = artifact(dryRunPath);
  save(manifestPath, manifest);

  writeProcurementSummary(path.join(runDir, "f3-report.txt"), manifest, collected, dryRun);
}

/** Краткий отчёт прогона: найдено, принято, исключено, новые, обновления, дубли, ошибки, конфликты года. */
function writeProcurementSummary(
  filePath: string,
  manifest: AutomationManifest,
  collected: ProcurementCollectResult,
  dryRun: AutomationStepResult
): void {
  const lines = [
    `run=${manifest.runId}`,
    `workflow=${manifestWorkflow(manifest)}`,
    `collected=${collected.counts.collected ?? 0}`,
    `accepted=${collected.counts.data ?? 0}`,
    `review=${collected.counts.review ?? 0}`,
    `rejected=${collected.counts.rejected ?? 0}`,
    `year_conflicts=${collected.counts.yearConflicts ?? 0}`,
    `month_unknown=${collected.counts.monthUnknown ?? 0}`,
    `new=${dryRun.counts.create ?? 0}`,
    `updates=${dryRun.counts.update ?? 0}`,
    `revised=${dryRun.counts.revise ?? 0}`,
    `duplicates=${dryRun.counts.duplicate ?? 0}`,
    `failed=${dryRun.counts.failed ?? 0}`
  ];
  for (const warning of collected.warnings ?? []) lines.push(`warning=${warning}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function runStage<T extends AutomationStepResult | AutomationExportResult>(
  manifest: AutomationManifest, manifestPath: string, name: string, operation: () => Promise<T>, log: (message: string) => void
): Promise<T> {
  manifest.stages[name] = { status: "running", startedAt: new Date().toISOString() }; save(manifestPath, manifest); log(`START ${name}`);
  try {
    const result = await operation();
    const counts = "counts" in result ? result.counts : exportCounts(result);
    const skipped = "skippedQueries" in result ? result.skippedQueries : undefined;
    if (skipped?.length) console.warn(`::warning::${name}: Частичный сбор: пропущено запросов — ${skipped.length}`);
    manifest.stages[name] = { ...manifest.stages[name], status: "succeeded", finishedAt: new Date().toISOString(), counts,
      ...(skipped?.length ? { skipped } : {}) }; save(manifestPath, manifest); log(`DONE ${name}`); return result;
  } catch (error) {
    manifest.stages[name] = { ...manifest.stages[name], status: "failed", finishedAt: new Date().toISOString(), error: errorMessage(error),
      ...(error instanceof GzSourceUnavailableError ? { skipped: error.skippedQueries } : {}),
      ...(name.startsWith("export") && isTransientNetworkError(error) ? { sourceUnreachable: true } : {}) };
    const transient = isTransientNetworkError(error);
    const message = `${transient ? "fetch failed: " : ""}${errorMessage(error)}`;
    save(manifestPath, manifest); log(`FAILED ${name}: ${message}`);
    if (transient) console.warn(`::warning::${name}: временная недоступность; подробности в сводке запуска`);
    console.error(`${name}: ${message}`); throw error;
  }
}

function exportCounts(result: AutomationExportResult): Record<string, number> {
  const counts: Record<string, number> = { rows: result.rows };
  if (result.cacheHit !== undefined) counts.cache_hit = result.cacheHit;
  if (result.cacheMiss !== undefined) counts.cache_miss = result.cacheMiss;
  if (result.fetched !== undefined) counts.fetched = result.fetched;
  if (result.fetchFailed !== undefined) counts.fetch_failed = result.fetchFailed;
  if (result.successfulQueries !== undefined) counts.successful_queries = result.successfulQueries;
  if (result.skippedQueries !== undefined) counts.skipped_queries = result.skippedQueries.length;
  return counts;
}
function artifact(filePath: string, rows?: number): AutomationArtifact { return { path: path.resolve(filePath), sha256: fileSha256(filePath), ...(rows === undefined ? {} : { rows }) }; }
function verifyRunArtifacts(manifest: AutomationManifest): void {
  if (manifestWorkflow(manifest) === "f3-b2b") {
    verifyArtifact(manifest.artifacts.procurementXlsx, "procurement xlsx");
    verifyArtifact(manifest.artifacts.procurementReport, "procurement report");
    verifyArtifact(manifest.artifacts.procurementDryRun, "procurement dry-run");
    return;
  }
  const available = availableBranches(manifest);
  if (!available.length || available.some(branch => branch !== "plans" && branch !== "lots")) throw new Error("invalid prepared branches");
  if (manifestWorkflow(manifest) === "plans-only" && available.includes("lots")) throw new Error("plans-only run contains lots");
  for (const branch of GZ_BRANCHES.filter(branch => available.includes(branch.key))) {
    if (manifest.preparedBranches && manifest.stages[branch.dryStage]?.status !== "succeeded") throw new Error(`${branch.key} dry-run is not ready`);
    verifyArtifact(manifest.artifacts[branch.key], branch.key);
    verifyArtifact(manifest.artifacts[branch.reportKey], `${branch.key} dry-run`);
  }
}
function verifyArtifact(value: AutomationArtifact | undefined, name: string): void {
  if (!value || !fs.existsSync(value.path)) throw new Error(`${name} artifact is missing`);
  if (fileSha256(value.path) !== value.sha256) throw new Error(`${name} artifact hash mismatch`);
}
function writeReport(filePath: string, result: AutomationStepResult): void { fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8"); }
function assertNoCriticalErrors(name: string, result: AutomationStepResult): void { if (result.criticalErrors?.length) throw new Error(`${name} has critical errors: ${result.criticalErrors.join("; ")}`); }
function save(filePath: string, manifest: AutomationManifest): void { manifest.updatedAt = new Date().toISOString(); writeManifestAtomic(filePath, manifest); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function currentFailedStage(manifest: AutomationManifest): string { return Object.entries(manifest.stages).reverse().find(([, stage]) => stage.status === "failed")?.[0] ?? "prepare"; }
function writeSummary(filePath: string, manifest: AutomationManifest): void {
  const lines = [`run=${manifest.runId}`, `workflow=${manifestWorkflow(manifest)}`, `status=${manifest.status}`, `updated=${manifest.updatedAt}`];
  for (const [name, stage] of Object.entries(manifest.stages)) {
    lines.push(`${name}=${stage.status}${stage.error ? ` (${stage.error})` : ""}`);
    for (const skipped of stage.skipped ?? []) lines.push(`skipped[${name}]=${JSON.stringify(skipped)}`);
  }
  for (const error of manifest.errors) lines.push(`error[${error.stage}]=${error.message}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}
