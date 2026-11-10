import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gz-summary-")); dirs.push(dir);
  const old = path.join(dir, "20261108-083000"); fs.mkdirSync(old);
  const manifestPath = path.join(old, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ runId: "OLD-CACHED", status: "pushed", stages: {}, config: {}, artifacts: {}, errors: [] }));
  const log = path.join(dir, "scheduler.log");
  const key = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
  return {
    manifestPath,
    state: (value: string) => fs.writeFileSync(`${log}.portal-probe-state`, value),
    key,
    summary: () => execFileSync(process.execPath, ["--import", "tsx", "scripts/gz-run-summary.mts", dir, log], { encoding: "utf8" })
  };
}
it("reports a blocked probe instead of a cached manifest", () => {
  const f = fixture(); f.state(`${f.key}:blocked\n`);
  expect(f.summary()).toContain("портал недоступен с этой машины GitHub, прогон не начинался");
  expect(f.summary()).not.toContain("OLD-CACHED");
});
it("ignores a marker from another GitHub job or attempt", () => {
  const f = fixture(); f.state("other-job:99:blocked\n");
  expect(f.summary()).toContain("OLD-CACHED");
});
it("uses the manifest when automation did start", () => {
  const f = fixture(); f.state(`${f.key}:started\n`);
  expect(f.summary()).toContain("OLD-CACHED");
});
it("still exits zero on broken state or corrupt manifest", () => {
  const f = fixture(); f.state("broken");
  expect(f.summary()).toContain("OLD-CACHED");
  fs.writeFileSync(f.manifestPath, "invalid JSON");
  expect(f.summary()).toContain("Сводку запуска собрать не удалось");
});

it("reports handoff instead of a cached manifest and ignores foreign handoff", () => {
  const f = fixture(); f.state(`${f.key}:handoff\n`);
  expect(f.summary()).toContain("сбор передан следующей машине");
  expect(f.summary()).not.toContain("OLD-CACHED");
  f.state("other-job:99:handoff\n");
  expect(f.summary()).toContain("OLD-CACHED");
});
