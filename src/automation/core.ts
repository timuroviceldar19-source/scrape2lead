import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AutomationManifest, AutomationStatus, RollingPeriod } from "./types.js";

export function createRunId(now = new Date()): string {
  const p = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

export function computeRollingPeriod(now: Date, count: number): RollingPeriod[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("periodMonths must be a positive integer");
  const grouped = new Map<number, number[]>();
  for (let offset = 0; offset < count; offset++) {
    const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const months = grouped.get(date.getFullYear()) ?? [];
    months.push(date.getMonth() + 1); grouped.set(date.getFullYear(), months);
  }
  return Array.from(grouped, ([year, months]) => ({ year, months }));
}

export function hasBrokenEncoding(values: string[]): boolean {
  return values.some((value) => /(?:Р[\x80-\xBF]|С[\x80-\xBF]|Р.|С.){2,}/u.test(value) || value.includes("�"));
}

export function fileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function writeManifestAtomic(filePath: string, manifest: AutomationManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function readManifest(filePath: string): AutomationManifest {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as AutomationManifest;
}

interface RunLock { runId: string; acquiredAt: string }
export function acquireRunLock(lockPath: string, runId: string, now = new Date(), staleMinutes = 180): { recoveredRunId: string | null } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let recoveredRunId: string | null = null;
  if (fs.existsSync(lockPath)) {
    const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as RunLock;
    const age = now.getTime() - new Date(current.acquiredAt).getTime();
    if (Number.isFinite(age) && age <= staleMinutes * 60_000) throw new Error(`automation prepare already running: ${current.runId}`);
    recoveredRunId = current.runId;
  }
  fs.writeFileSync(lockPath, `${JSON.stringify({ runId, acquiredAt: now.toISOString() })}\n`, "utf8");
  return { recoveredRunId };
}

export function releaseRunLock(lockPath: string, runId: string): void {
  if (!fs.existsSync(lockPath)) return;
  const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as RunLock;
  if (current.runId === runId) fs.rmSync(lockPath, { force: true });
}

const RETAINABLE: ReadonlySet<AutomationStatus> = new Set(["ready", "applied", "applied_ai_failed"]);
export function cleanupSuccessfulRuns(runsDir: string, keep: number): string[] {
  if (!fs.existsSync(runsDir)) return [];
  const successful = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, manifestPath: path.join(runsDir, entry.name, "manifest.json") }))
    .filter((item) => fs.existsSync(item.manifestPath))
    .filter((item) => RETAINABLE.has(readManifest(item.manifestPath).status))
    .sort((a, b) => b.id.localeCompare(a.id));
  const removed = successful.slice(Math.max(0, keep));
  for (const item of removed) fs.rmSync(path.join(runsDir, item.id), { recursive: true, force: true });
  return removed.map((item) => item.id);
}
