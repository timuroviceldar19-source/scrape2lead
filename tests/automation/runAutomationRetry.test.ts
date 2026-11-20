import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const TIMEOUT = "page.goto: net::ERR_CONNECTION_TIMED_OUT at https://procurement.gov.kz/";
const PROBE_OK = "portal probe: ok (HTTP 200, 0 s)";
const PROBE_FAILURE = "portal probe: unreachable: fetch failed ENOTFOUND";

/** Изолированный runner: оба процесса подставные, ни npm, ни сети, ни Bitrix. */
async function run(failures: number, message: string, probeFailures = 0, oldLog = "", probeCode = 75) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-retry-sh-")); dirs.push(dir);
  const scripts = path.join(dir, "scripts"); fs.mkdirSync(scripts);
  fs.copyFileSync("scripts/run-automation-with-retry.sh", path.join(scripts, "run-automation-with-retry.sh"));
  fs.writeFileSync(path.join(scripts, "run-automation.sh"), `#!/bin/sh
n=$(cat "${dir}/calls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/calls"
if [ "$n" -le ${failures} ]; then
  echo '${message}' >> "$2"
  echo 'scheduler automation:run status=failed exit=1' >> "$2"
  exit 1
fi
echo 'scheduler automation:run status=pushed exit=0' >> "$2"
`);
  fs.writeFileSync(path.join(dir, "npx"), `#!/bin/sh
n=$(cat "${dir}/probes" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/probes"
if [ "$n" -le ${probeFailures} ]; then echo '${PROBE_FAILURE}'; exit ${probeCode}; fi
echo '${PROBE_OK}'
`, { mode: 0o755 });
  const logPath = path.join(dir, "scheduler.log"); fs.writeFileSync(logPath, oldLog);
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, RETRY_PAUSE_SECONDS: "0" };
  let code = 0;
  try { await execFileAsync("sh", [path.join(scripts, "run-automation-with-retry.sh"), "config/automation.json", logPath], { env }); }
  catch (error) { code = (error as { code?: number }).code ?? -1; }
  const count = (name: string) => fs.existsSync(path.join(dir, name)) ? Number(fs.readFileSync(path.join(dir, name), "utf8").trim()) : 0;
  return { code, calls: count("calls"), probes: count("probes"), log: fs.readFileSync(logPath, "utf8"), state: fs.readFileSync(`${logPath}.portal-probe-state`, "utf8") };
}

describe.skipIf(process.platform === "win32")("scheduler runner with retry (posix)", () => {
  it("never starts automation after three failed probes", async () => {
    const result = await run(0, TIMEOUT, 99);
    expect(result.code).toBe(1);
    expect(result.calls).toBe(0);
    expect(result.probes).toBe(3);
    expect(result.log.match(/portal probe: unreachable/g)).toHaveLength(3);
    expect(result.log).toContain("портал недоступен с этой машины GitHub, прогон не начинался");
    expect(result.state).toMatch(/:blocked\n$/);
  });
  it("starts automation once after a failed probe followed by success", async () => {
    const result = await run(0, TIMEOUT, 1);
    expect(result.code).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.probes).toBe(2);
    expect(result.log).toContain(PROBE_FAILURE);
    expect(result.log).toContain(PROBE_OK);
    expect(result.state).toMatch(/:started\n$/);
  });
  it("runs once and exits 0 when the first attempt succeeds", async () => {
    const result = await run(0, TIMEOUT);
    expect(result.code).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.log).not.toContain("retry");
  });
  it("retries after a portal connection failure and succeeds", async () => {
    const result = await run(1, TIMEOUT);
    expect(result.code).toBe(0);
    expect(result.calls).toBe(2);
    expect(result.probes).toBe(2);
    expect(result.log).toContain("retry 1/2");
    expect(result.log.match(/status=failed/g)?.length).toBe(1);
    expect(result.log).toContain("status=pushed");
  });
  it("gives up after three attempts when the portal stays unreachable", async () => {
    const result = await run(99, TIMEOUT);
    expect(result.code).toBe(1);
    expect(result.calls).toBe(3);
    expect(result.log).toContain("retry 2/2");
    expect(result.log).not.toContain("прогон не начинался");
  });
  it("does not retry a failure that is not a network problem", async () => {
    const result = await run(99, "TypeError: cannot read properties of undefined");
    expect(result.code).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.log).not.toContain("retry");
  });
  it("ignores old network and probe errors when automation fails for another reason", async () => {
    const result = await run(99, "TypeError: boom", 1, `${TIMEOUT}\n`);
    expect(result.code).toBe(1);
    expect(result.probes).toBe(2);
    expect(result.calls).toBe(1);
  });
  it.each([1, 2])("starts automation when the probe itself fails (exit %i)", async probeCode => {
    const result = await run(0, TIMEOUT, 99, "", probeCode);
    expect(result.code).toBe(0);
    expect(result.probes).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.log).toContain(`portal probe: inconclusive (probe exit ${probeCode})`);
    expect(result.state).toMatch(/:started\n$/);
  });
  it.each([1, 2])("does not classify automation errors using failed probe output (exit %i)", async probeCode => {
    const result = await run(99, "TypeError: boom", 99, "", probeCode);
    expect(result.code).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.probes).toBe(1);
    const inconclusive = result.log.split("\n").find(line => line.includes("inconclusive"));
    const pattern = new RegExp(fs.readFileSync("scripts/run-automation-with-retry.sh", "utf8").match(/NETWORK_PATTERN='([^']+)'/)![1]);
    expect(inconclusive).toBe(`portal probe: inconclusive (probe exit ${probeCode})`);
    expect(inconclusive).not.toMatch(pattern);
    expect(result.log).not.toContain("retry");
  });
});
