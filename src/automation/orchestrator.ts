import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireRunLock, cleanupSuccessfulRuns, computeRollingPeriod, createRunId, fileSha256, readManifest, releaseRunLock, writeManifestAtomic } from "./core.js";
import type { AutomationArtifact, AutomationConfig, AutomationDependencies, AutomationManifest, AutomationStage, AutomationStatus, AutomationStepResult } from "./types.js";

export async function prepareAutomationRun(config: AutomationConfig, deps: AutomationDependencies, now = new Date()): Promise<AutomationManifest> {
  const runId = createRunId(now);
  const runDir = path.resolve(config.runsDir, runId);
  if (fs.existsSync(runDir)) throw new Error(`automation run already exists: ${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  const manifestPath = path.join(runDir, "manifest.json");
  const lock = acquireRunLock(path.resolve(config.lockPath), runId, now, config.staleLockMinutes);
  let manifest: AutomationManifest = {
    schemaVersion: 1, runId, status: "preparing", createdAt: now.toISOString(), updatedAt: now.toISOString(),
    recoveredLockRunId: lock.recoveredRunId,
    config: { path: "config/automation.json", sha256: crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex") },
    stages: {}, artifacts: {}, errors: [], approval: null
  };
  save(manifestPath, manifest);
  const log = (message: string) => fs.appendFileSync(path.join(runDir, "run.log"), `${new Date().toISOString()} ${message}\n`);
  const periods = computeRollingPeriod(now, config.periodMonths);
  try {
    const plansPath = path.join(runDir, "plans.xlsx");
    const lotsPath = path.join(runDir, "lots.xlsx");
    const plans = await runStage(manifest, manifestPath, "exportPlans", () => deps.exportPlans(config.plansConfig, plansPath, periods), log);
    manifest.artifacts.plans = artifact(plans.path, plans.rows); save(manifestPath, manifest);
    const lots = await runStage(manifest, manifestPath, "exportLots", () => deps.exportLots(config.lotsConfig, lotsPath, periods), log);
    manifest.artifacts.lots = artifact(lots.path, lots.rows); save(manifestPath, manifest);
    const plansReportPath = path.join(runDir, "plans-dry-run.json");
    const plansDry = await runStage(manifest, manifestPath, "dryRunPlans", () => deps.dryRunPlans(plans.path, plansReportPath), log);
    writeReport(plansReportPath, plansDry); manifest.artifacts.plansDryRun = artifact(plansReportPath);
    assertNoCriticalErrors("plans", plansDry); save(manifestPath, manifest);
    const lotsReportPath = path.join(runDir, "lots-dry-run.json");
    const lotsDry = await runStage(manifest, manifestPath, "dryRunLots", () => deps.dryRunLots(lots.path, lotsReportPath), log);
    writeReport(lotsReportPath, lotsDry); manifest.artifacts.lotsDryRun = artifact(lotsReportPath);
    assertNoCriticalErrors("lots", lotsDry);
    manifest.status = "ready"; save(manifestPath, manifest);
  } catch (error) {
    const message = errorMessage(error);
    manifest.status = "failed"; manifest.errors.push({ stage: currentFailedStage(manifest), message, at: new Date().toISOString() });
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
  if (manifest.status === "applied") throw new Error(`automation run already applied: ${runId}`);
  const resumable = manifest.approval !== null && ["failed", "applying", "applied_ai_failed"].includes(manifest.status);
  if (manifest.status !== "ready" && !resumable) throw new Error(`automation run is not ready: ${manifest.status}`);
  verifyArtifact(manifest.artifacts.plans, "plans"); verifyArtifact(manifest.artifacts.lots, "lots");
  manifest.approval ??= { requestedAt: new Date().toISOString() }; manifest.status = "applying"; save(manifestPath, manifest);
  const log = (message: string) => fs.appendFileSync(path.join(runDir, "run.log"), `${new Date().toISOString()} ${message}\n`);
  try {
    if (manifest.stages.applyPlans?.status !== "succeeded") await runStage(manifest, manifestPath, "applyPlans", () => deps.applyPlans(manifest.artifacts.plans!.path, config.approvalLimit), log);
    if (manifest.stages.applyLots?.status !== "succeeded") await runStage(manifest, manifestPath, "applyLots", () => deps.applyLots(manifest.artifacts.lots!.path, config.approvalLimit), log);
  } catch (error) {
    const message = errorMessage(error); manifest.status = "failed";
    manifest.errors.push({ stage: currentFailedStage(manifest), message, at: new Date().toISOString() }); save(manifestPath, manifest);
    writeSummary(path.join(runDir, "summary.txt"), manifest); throw error;
  }
  try {
    if (manifest.stages.analyzeLots?.status !== "succeeded") await runStage(manifest, manifestPath, "analyzeLots", () => deps.analyzeLots(manifest.artifacts.lots!.path, config.approvalLimit), log);
    manifest.status = "applied";
  } catch (error) {
    const message = errorMessage(error); manifest.status = "applied_ai_failed";
    manifest.errors.push({ stage: "analyzeLots", message, at: new Date().toISOString() });
  }
  save(manifestPath, manifest); writeSummary(path.join(runDir, "summary.txt"), manifest); return manifest;
}

async function runStage<T extends AutomationStepResult | { path: string; rows: number }>(
  manifest: AutomationManifest, manifestPath: string, name: string, operation: () => Promise<T>, log: (message: string) => void
): Promise<T> {
  manifest.stages[name] = { status: "running", startedAt: new Date().toISOString() }; save(manifestPath, manifest); log(`START ${name}`);
  try {
    const result = await operation();
    const counts = "counts" in result ? result.counts : { rows: result.rows };
    manifest.stages[name] = { ...manifest.stages[name], status: "succeeded", finishedAt: new Date().toISOString(), counts }; save(manifestPath, manifest); log(`DONE ${name}`); return result;
  } catch (error) {
    manifest.stages[name] = { ...manifest.stages[name], status: "failed", finishedAt: new Date().toISOString(), error: errorMessage(error) }; save(manifestPath, manifest); throw error;
  }
}

function artifact(filePath: string, rows?: number): AutomationArtifact { return { path: path.resolve(filePath), sha256: fileSha256(filePath), ...(rows === undefined ? {} : { rows }) }; }
function verifyArtifact(value: AutomationArtifact | undefined, name: string): void {
  if (!value || !fs.existsSync(value.path)) throw new Error(`${name} artifact is missing`);
  if (fileSha256(value.path) !== value.sha256) throw new Error(`${name} artifact hash mismatch`);
}
function writeReport(filePath: string, result: AutomationStepResult): void { fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8"); }
function assertNoCriticalErrors(name: string, result: AutomationStepResult): void { if (result.criticalErrors?.length) throw new Error(`${name} dry-run has critical errors: ${result.criticalErrors.join("; ")}`); }
function save(filePath: string, manifest: AutomationManifest): void { manifest.updatedAt = new Date().toISOString(); writeManifestAtomic(filePath, manifest); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function currentFailedStage(manifest: AutomationManifest): string { return Object.entries(manifest.stages).find(([, stage]) => stage.status === "failed")?.[0] ?? "prepare"; }
function writeSummary(filePath: string, manifest: AutomationManifest): void {
  const lines = [`run=${manifest.runId}`, `status=${manifest.status}`, `updated=${manifest.updatedAt}`];
  for (const [name, stage] of Object.entries(manifest.stages)) lines.push(`${name}=${stage.status}${stage.error ? ` (${stage.error})` : ""}`);
  for (const error of manifest.errors) lines.push(`error[${error.stage}]=${error.message}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}
