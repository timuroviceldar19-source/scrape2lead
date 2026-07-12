import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRunLock,
  cleanupSuccessfulRuns,
  computeRollingPeriod,
  createRunId,
  fileSha256,
  hasBrokenEncoding,
  readManifest,
  releaseRunLock,
  writeManifestAtomic
} from "../../src/automation/core.js";
import type { AutomationManifest } from "../../src/automation/types.js";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-auto-")); tempDirs.push(dir); return dir; }

describe("automation core", () => {
  it("creates sortable run IDs", () => {
    expect(createRunId(new Date("2026-07-12T06:00:01Z"))).toBe("20260712-060001");
  });
  it("computes the current and next five months", () => {
    expect(computeRollingPeriod(new Date(2026, 10, 2), 6)).toEqual({ year: 2026, months: [11, 12, 1, 2, 3, 4] });
  });
  it("detects mojibake but accepts Cyrillic", () => {
    expect(hasBrokenEncoding(["РєРѕРјРїСЊСЋС‚РµСЂ"])).toBe(true);
    expect(hasBrokenEncoding(["компьютер", "Опубликован"])).toBe(false);
  });
  it("hashes files deterministically", () => {
    const file = path.join(tempDir(), "a.txt"); fs.writeFileSync(file, "hello");
    expect(fileSha256(file)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("writes and reads a manifest atomically", () => {
    const file = path.join(tempDir(), "manifest.json"); const manifest = sampleManifest("ready");
    writeManifestAtomic(file, manifest); expect(readManifest(file)).toEqual(manifest);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
  it("prevents parallel runs and recovers stale locks", () => {
    const file = path.join(tempDir(), "prepare.lock");
    const first = acquireRunLock(file, "one", new Date("2026-07-12T10:00:00Z"), 60);
    expect(first.recoveredRunId).toBeNull();
    expect(() => acquireRunLock(file, "two", new Date("2026-07-12T10:30:00Z"), 60)).toThrow(/already running/);
    const recovered = acquireRunLock(file, "two", new Date("2026-07-12T12:00:01Z"), 60);
    expect(recovered.recoveredRunId).toBe("one"); releaseRunLock(file, "two");
  });
  it("retains newest successful runs and never deletes failed runs", () => {
    const root = tempDir();
    for (const [id, status] of [["20260701-100000","applied"],["20260702-100000","ready"],["20260703-100000","failed"]] as const) {
      const dir=path.join(root,id); fs.mkdirSync(dir); writeManifestAtomic(path.join(dir,"manifest.json"), sampleManifest(status,id));
    }
    expect(cleanupSuccessfulRuns(root, 1)).toEqual(["20260701-100000"]);
    expect(fs.existsSync(path.join(root,"20260703-100000"))).toBe(true);
  });
});

function sampleManifest(status: AutomationManifest["status"], runId = "20260712-100000"): AutomationManifest {
  return { schemaVersion: 1, runId, status, createdAt: "2026-07-12T10:00:00.000Z", updatedAt: "2026-07-12T10:00:00.000Z",
    recoveredLockRunId: null, config: { path: "config/automation.json", sha256: "x" },
    stages: {}, artifacts: {}, errors: [], approval: null };
}
