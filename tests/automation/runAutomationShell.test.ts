import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const RUNNER = path.resolve("scripts/run-automation.sh");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-runner-sh-")); dirs.push(dir); return dir; }

/** npm writes progress and warnings to stderr even on success; the fake reproduces that. */
function writeFakeNpm(dir: string, exitCode: number): void {
  const lines = ["#!/bin/sh", 'echo "npm args: $*"', 'echo "collector warning" >&2', `exit ${exitCode}`];
  const file = path.join(dir, "npm");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  fs.chmodSync(file, 0o755);
}

function envWithFakeNpm(binDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
}

async function runRunner(npmExitCode: number, configPath: string): Promise<{ code: number; log: string }> {
  const binDir = tempDir(); writeFakeNpm(binDir, npmExitCode);
  const logPath = path.join(tempDir(), "scheduler.log");
  let code = 0;
  try { await execFileAsync("sh", [RUNNER, configPath, logPath], { env: envWithFakeNpm(binDir) }); }
  catch (error) { code = (error as { code?: number }).code ?? -1; }
  return { code, log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "" };
}

describe.skipIf(process.platform === "win32")("scheduler runner (posix)", () => {
  it("reports success to cron when npm exits 0 after writing to stderr", async () => {
    const result = await runRunner(0, "config/automation.json");
    expect(result.code).toBe(0);
    expect(result.log).toContain("collector warning");
    expect(result.log).toContain("status=pushed");
    expect(result.log).toContain("exit=0");
  }, 30_000);

  it("propagates a failed npm exit code to cron", async () => {
    const result = await runRunner(1, "config/automation.json");
    expect(result.code).toBe(1);
    expect(result.log).toContain("status=failed");
    expect(result.log).toContain("exit=1");
  }, 30_000);

  it("passes the requested config through to the automation run and the log", async () => {
    const result = await runRunner(0, "config/automation.pk.json");
    expect(result.log).toContain("--config config/automation.pk.json");
    expect(result.log).toContain("config=config/automation.pk.json");
  }, 30_000);
});
