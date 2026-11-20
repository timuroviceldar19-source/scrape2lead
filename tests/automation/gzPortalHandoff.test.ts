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
async function run(failures: number, message: string, probeFailures = 0, oldLog = "", probeCode = 75, extraEnv: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-retry-sh-")); dirs.push(dir);
  const scripts = path.join(dir, "scripts"); fs.mkdirSync(scripts);
  fs.copyFileSync("scripts/run-automation-with-retry.sh", path.join(scripts, "run-automation-with-retry.sh"));
  fs.writeFileSync(path.join(scripts, "run-automation.sh"), `#!/bin/sh
n=$(cat "${dir}/calls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/calls"
if [ "$n" -le ${failures} ]; then
  echo '${message}' >> "$2"
  echo 'scheduler automation:run status=failed exit=${extraEnv.TEST_ROBOT_EXIT ?? "1"}' >> "$2"
  exit ${extraEnv.TEST_ROBOT_EXIT ?? "1"}
fi
echo 'scheduler automation:run status=pushed exit=0' >> "$2"
`);
  fs.writeFileSync(path.join(dir, "npx"), `#!/bin/sh
n=$(cat "${dir}/probes" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/probes"
if [ "$n" -le ${probeFailures} ] || { [ "${extraEnv.TEST_BLOCK_AFTER_START ?? "0"}" = "1" ] && [ "$n" -gt 1 ]; }; then echo '${PROBE_FAILURE}'; exit ${probeCode}; fi
echo '${PROBE_OK}'
`, { mode: 0o755 });
  const logPath = path.join(dir, "scheduler.log"); fs.writeFileSync(logPath, oldLog);
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, RETRY_PAUSE_SECONDS: "0", ...extraEnv };
  let code = 0;
  try { await execFileAsync("sh", [path.join(scripts, "run-automation-with-retry.sh"), "config/automation.json", logPath], { env }); }
  catch (error) { code = (error as { code?: number }).code ?? -1; }
  const count = (name: string) => fs.existsSync(path.join(dir, name)) ? Number(fs.readFileSync(path.join(dir, name), "utf8").trim()) : 0;
  return { code, calls: count("calls"), probes: count("probes"), log: fs.readFileSync(logPath, "utf8"), state: fs.readFileSync(`${logPath}.portal-probe-state`, "utf8") };
}

describe.skipIf(process.platform === "win32")("scheduler runner handoff (posix)", () => {
  it("hands off immediately without starting automation or waiting", async () => {
    const r = await run(0, TIMEOUT, 99, "", 75, { GZ_PORTAL_HANDOFF: "1" });
    expect(r.code).toBe(76); expect(r.calls).toBe(0); expect(r.probes).toBe(1);
    expect(r.state).toMatch(/:handoff\n$/);
    expect(r.log).toContain("сбор передан следующей машине");
    expect(r.log).not.toContain("retry");
  });
  it("does not hand off after automation started", async () => {
    const r = await run(1, TIMEOUT, 0, "", 75, { GZ_PORTAL_HANDOFF: "1", TEST_BLOCK_AFTER_START: "1" });
    expect(r.code).toBe(1); expect(r.calls).toBe(1); expect(r.probes).toBe(3);
    expect(r.state).toMatch(/:started\n$/); expect(r.log).not.toContain("сбор передан");
  });
  it("runs automation on an inconclusive probe with handoff enabled", async () => {
    const r = await run(0, TIMEOUT, 99, "", 2, { GZ_PORTAL_HANDOFF: "1" });
    expect(r.code).toBe(0); expect(r.calls).toBe(1);
  });
  it("simulates blocked probes without invoking npx", async () => {
    const r = await run(0, TIMEOUT, 0, "", 75, { GZ_SIMULATE_PORTAL_BLOCK: "1" });
    expect(r.code).toBe(1); expect(r.calls).toBe(0); expect(r.probes).toBe(0);
    expect(r.log.match(/portal probe: unreachable: simulated/g)).toHaveLength(3);
  });
  it("hands off a simulated block without invoking npx or waiting", async () => {
    const r = await run(0, TIMEOUT, 0, "", 75, { GZ_PORTAL_HANDOFF: "1", GZ_SIMULATE_PORTAL_BLOCK: "1" });
    expect(r.code).toBe(76); expect(r.calls).toBe(0); expect(r.probes).toBe(0);
    expect(r.log.match(/portal probe: unreachable: simulated/g)).toHaveLength(1);
    expect(r.log).toContain("сбор передан следующей машине");
    expect(r.state).toMatch(/:handoff\n$/);
  });
  it("keys the state by run, attempt and machine number", async () => {
    const ids = { GZ_PORTAL_HANDOFF: "1", GITHUB_RUN_ID: "777", GITHUB_RUN_ATTEMPT: "4" };
    const machine = await run(0, TIMEOUT, 99, "", 75, { ...ids, GZ_PORTAL_MACHINE: "2" });
    expect(machine.state).toBe("777:4:2:handoff\n");
    // Без номера машины ключ прежний: локальный запуск и старые вызовы не меняются.
    const plain = await run(0, TIMEOUT, 99, "", 75, { ...ids, GZ_PORTAL_MACHINE: "" });
    expect(plain.state).toBe("777:4:handoff\n");
  });
  // 76 зарезервирован за передачей: шаг workflow делает такой job зелёным и запускает
  // следующую машину. Робот с тем же кодом должен остаться обычным падением.
  it("never reports a handoff when automation itself exits 76", async () => {
    const r = await run(9, "TypeError: x is not a function", 0, "", 75, { GZ_PORTAL_HANDOFF: "1", TEST_ROBOT_EXIT: "76" });
    expect(r.code).toBe(1); expect(r.calls).toBe(1); expect(r.probes).toBe(1);
    expect(r.state).toMatch(/:started\n$/); expect(r.log).not.toContain("сбор передан");
  });
  it("still retries a network failure on the same machine when automation exits 76", async () => {
    const r = await run(9, TIMEOUT, 0, "", 75, { GZ_PORTAL_HANDOFF: "1", TEST_ROBOT_EXIT: "76" });
    expect(r.code).toBe(1); expect(r.calls).toBe(3);
    expect(r.state).toMatch(/:started\n$/); expect(r.log).not.toContain("сбор передан");
  });
});
