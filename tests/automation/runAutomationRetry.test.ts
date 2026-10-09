import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const RETRY_RUNNER = path.resolve("scripts/run-automation-with-retry.sh");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-retry-sh-")); dirs.push(dir); return dir; }

/**
 * Fake npm: the first `failures` calls print `message` and exit 1, later calls succeed.
 * Every call is counted in a file so the test can see how many attempts were made.
 */
function writeFakeNpm(dir: string, failures: number, message: string): string {
  const counter = path.join(dir, "calls");
  const lines = [
    "#!/bin/sh",
    `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${counter}"`,
    `if [ "$n" -le ${failures} ]; then echo "${message}" >&2; exit 1; fi`,
    'echo "ok"',
    "exit 0"
  ];
  const file = path.join(dir, "npm");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  fs.chmodSync(file, 0o755);
  return counter;
}

async function run(failures: number, message: string): Promise<{ code: number; calls: number; log: string }> {
  const binDir = tempDir();
  const counter = writeFakeNpm(binDir, failures, message);
  const logPath = path.join(tempDir(), "scheduler.log");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, RETRY_PAUSE_SECONDS: "0" };
  let code = 0;
  try { await execFileAsync("sh", [RETRY_RUNNER, "config/automation.json", logPath], { env }); }
  catch (error) { code = (error as { code?: number }).code ?? -1; }
  const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8").trim()) : 0;
  return { code, calls, log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "" };
}

const TIMEOUT = "page.goto: net::ERR_CONNECTION_TIMED_OUT at https://procurement.gov.kz/";

describe.skipIf(process.platform === "win32")("scheduler runner with retry (posix)", () => {
  it("runs once and exits 0 when the first attempt succeeds", async () => {
    const result = await run(0, TIMEOUT);

    expect(result.code).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.log).not.toContain("retry");
  }, 30_000);

  it("retries after a portal connection failure and succeeds", async () => {
    const result = await run(1, TIMEOUT);

    expect(result.code).toBe(0);
    expect(result.calls).toBe(2);
    expect(result.log).toContain("retry 1/2");
    expect(result.log.match(/status=failed/g)?.length).toBe(1);
    expect(result.log).toContain("status=pushed");
  }, 30_000);

  it("gives up after three attempts when the portal stays unreachable", async () => {
    const result = await run(99, TIMEOUT);

    expect(result.code).toBe(1);
    expect(result.calls).toBe(3);
    expect(result.log).toContain("retry 2/2");
  }, 30_000);

  it("does not retry a failure that is not a network problem", async () => {
    const result = await run(99, "TypeError: cannot read properties of undefined");

    expect(result.code).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.log).not.toContain("retry");
  }, 30_000);

  it("reads only the new part of the log, so an old network error does not trigger a retry", async () => {
    const binDir = tempDir();
    const counter = writeFakeNpm(binDir, 99, "TypeError: boom");
    const logPath = path.join(tempDir(), "scheduler.log");
    fs.writeFileSync(logPath, `${TIMEOUT}\n`, "utf8");
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, RETRY_PAUSE_SECONDS: "0" };

    await execFileAsync("sh", [RETRY_RUNNER, "config/automation.json", logPath], { env }).catch(() => undefined);

    expect(Number(fs.readFileSync(counter, "utf8").trim())).toBe(1);
  }, 30_000);
});
