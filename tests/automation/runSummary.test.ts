import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLatestManifestPath, renderRunSummary } from "../../src/automation/runSummary.js";
import type { AutomationManifest } from "../../src/automation/types.js";

function manifest(overrides: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    schemaVersion: 4,
    runId: "20261009-093151",
    workflow: "plans-and-lots",
    status: "pushed",
    createdAt: "2026-10-09T04:31:51.000Z",
    updatedAt: "2026-10-09T04:41:27.000Z",
    recoveredLockRunId: null,
    config: { path: "config/automation.json", sha256: "abc" },
    stages: {
      exportPlans: {
        status: "succeeded",
        startedAt: "2026-10-09T04:31:51.000Z",
        finishedAt: "2026-10-09T04:36:03.000Z",
        counts: { rows: 82, cache_hit: 57, cache_miss: 0, fetched: 0, fetch_failed: 0 }
      },
      applyPlans: {
        status: "succeeded",
        startedAt: "2026-10-09T04:40:00.000Z",
        finishedAt: "2026-10-09T04:40:45.000Z",
        counts: { create: 3, update: 1, revise: 0, existing: 70, duplicate: 8 }
      },
      applyLots: {
        status: "succeeded",
        startedAt: "2026-10-09T04:40:45.000Z",
        finishedAt: "2026-10-09T04:41:20.000Z",
        counts: { create: 2, update: 0, existing: 11 }
      }
    },
    artifacts: {},
    errors: [],
    push: null,
    approval: null,
    ...overrides
  };
}

describe("renderRunSummary", () => {
  it("shows the run, its status and the config", () => {
    const text = renderRunSummary(manifest());

    expect(text).toContain("20261009-093151");
    expect(text).toContain("✅");
    expect(text).toContain("pushed");
    expect(text).toContain("config/automation.json");
  });

  it("adds up created, updated, existing and duplicate deals over the apply stages", () => {
    const text = renderRunSummary(manifest());

    expect(text).toContain("создано 5");
    expect(text).toContain("обновлено 1");
    expect(text).toContain("уже были 81");
    expect(text).toContain("дубликаты 8");
  });

  it("lists every stage with its duration and counts", () => {
    const text = renderRunSummary(manifest());

    expect(text).toMatch(/\| exportPlans \| ✅ \| 4м 12с \|/);
    expect(text).toContain("cache_hit=57");
    expect(text).toContain("fetch_failed=0");
    expect(text).toMatch(/\| applyPlans \| ✅ \| 45с \| .*create=3/);
  });

  it("works for plans-only runs without lots", () => {
    const only = manifest({ workflow: "plans-only" });
    delete only.stages.applyLots;

    const text = renderRunSummary(only);

    expect(text).toContain("создано 3");
    expect(text).not.toContain("applyLots");
  });

  it("says nothing was written to Bitrix when no apply stage ran", () => {
    const text = renderRunSummary(
      manifest({
        status: "failed",
        stages: {
          exportPlans: {
            status: "failed",
            startedAt: "2026-10-09T03:41:00.000Z",
            finishedAt: "2026-10-09T03:45:20.000Z",
            error: "page.goto: net::ERR_CONNECTION_TIMED_OUT"
          }
        },
        errors: [{ stage: "exportPlans", message: "page.goto: net::ERR_CONNECTION_TIMED_OUT", at: "2026-10-09T03:45:20.000Z" }]
      })
    );

    expect(text).toContain("❌");
    expect(text).toContain("запись в Bitrix не выполнялась");
    expect(text).toContain("ERR_CONNECTION_TIMED_OUT");
  });

  it("keeps long errors short and does not break the table", () => {
    const error = `scripts/x.mts failed: a|b\n${"x".repeat(2000)}`;
    const text = renderRunSummary(
      manifest({
        status: "failed",
        stages: { applyPlans: { status: "failed", startedAt: "2026-10-09T04:40:00.000Z", error } }
      })
    );

    const row = text.split("\n").find((line) => line.startsWith("| applyPlans")) ?? "";
    expect(row.length).toBeLessThan(600);
    expect(row).not.toContain("\n");
    expect(row.match(/(?<!\\)\|/g)?.length).toBe(5);
  });

  it("marks a stage that is still running", () => {
    const text = renderRunSummary(
      manifest({ status: "applying", stages: { applyPlans: { status: "running", startedAt: "2026-10-09T04:40:00.000Z" } } })
    );

    expect(text).toContain("⏳");
  });
});

describe("findLatestManifestPath", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function runsDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-summary-"));
    roots.push(root);
    return root;
  }

  function addRun(root: string, name: string, withManifest = true): void {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    if (withManifest) fs.writeFileSync(path.join(root, name, "manifest.json"), "{}");
  }

  it("returns the newest run directory that has a manifest", () => {
    const root = runsDir();
    addRun(root, "20261008-084123");
    addRun(root, "20261009-093151");
    addRun(root, "20261009-103100", false);
    addRun(root, "pk", false);

    expect(findLatestManifestPath(root)).toBe(path.join(root, "20261009-093151", "manifest.json"));
  });

  it("returns null when the directory is missing or empty", () => {
    const root = runsDir();

    expect(findLatestManifestPath(path.join(root, "nope"))).toBeNull();
    expect(findLatestManifestPath(root)).toBeNull();
  });
});
