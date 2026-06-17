/**
 * API job-store persistence tests.
 *
 * Covers:
 *  - SQLite: full job lifecycle, logs, artifacts, queue claim semantics.
 *  - Postgres migration/SQL contract: the v3 migration must create the
 *    api_jobs, api_job_logs and api_job_artifacts tables and the statements
 *    must match the SQLite contract (no destructive casts, idempotent DDL).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { SqliteJobStore, type IJobStore } from "../src/storage/apiJobStore.js";

const pgState = vi.hoisted(() => ({ queries: [] as Array<{ text: string; params: unknown[] }> }));

vi.mock("pg", () => ({
  Pool: class {
    constructor(_config: unknown) { void _config; }
    async connect() {
      return {
        query: async (text: string, params: unknown[] = []) => {
          pgState.queries.push({ text, params });
          if (/SELECT MAX\(version\)/.test(text)) return { rows: [{ version: null }], rowCount: 1 };
          if (/RETURNING \*/.test(text)) return { rows: [{ id: "job-1" }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined
      };
    }
    async end() { return undefined; }
  }
}));

const stores: IJobStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => Promise.resolve(s.close())));
});

function openSqlite(pathOrDb: string | Database.Database): SqliteJobStore {
  const store = typeof pathOrDb === "string" ? new SqliteJobStore(pathOrDb) : new SqliteJobStore(pathOrDb);
  stores.push(store);
  return store;
}

describe("SqliteJobStore", () => {
  it("creates jobs in queued status", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({
      id: "job-1",
      type: "scrape",
      command: "node",
      args: ["src/cli.ts"],
      request: { limit: 10 },
      cwd: process.cwd()
    });

    const job = await store.getJob("job-1");
    expect(job).not.toBeNull();
    expect(job?.status).toBe("queued");
    expect(job?.args).toEqual(["src/cli.ts"]);
    expect(job?.request).toEqual({ limit: 10 });
  });

  it("lists jobs with status filter and pagination", async () => {
    const store = openSqlite(":memory:");
    for (let i = 0; i < 3; i++) {
      await store.createJob({
        id: `job-${i}`,
        type: "scrape",
        command: "node",
        args: [],
        request: {},
        cwd: process.cwd()
      });
    }

    await store.claimNextQueuedJob();
    const all = await store.listJobs({});
    expect(all.total).toBe(3);

    const queued = await store.listJobs({ status: "queued" });
    expect(queued.total).toBe(2);

    const running = await store.listJobs({ status: "running" });
    expect(running.total).toBe(1);

    const limited = await store.listJobs({ limit: 1, offset: 1 });
    expect(limited.jobs).toHaveLength(1);
  });

  it("claims queued jobs in FIFO order and sets them running", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "job-a", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.createJob({ id: "job-b", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });

    const claimed = await store.claimNextQueuedJob();
    expect(claimed?.id).toBe("job-a");
    expect(claimed?.status).toBe("running");

    const second = await store.claimNextQueuedJob();
    expect(second?.id).toBe("job-b");

    const third = await store.claimNextQueuedJob();
    expect(third).toBeNull();
  });

  it("persists logs and returns them ordered", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "job-1", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.appendLog("job-1", "stdout", "first");
    await store.appendLog("job-1", "stderr", "second");
    await store.appendLog("job-1", "system", "third");

    const logs = await store.getLogs("job-1");
    expect(logs.map((l) => ({ stream: l.stream, line: l.line }))).toEqual([
      { stream: "stdout", line: "first" },
      { stream: "stderr", line: "second" },
      { stream: "system", line: "third" }
    ]);
  });

  it("persists artifacts linked to a job", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "job-1", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.saveArtifacts("job-1", [
      { name: "report.xlsx", path: "/tmp/report.xlsx", size: 1024, mtime: new Date().toISOString() }
    ]);

    const job = await store.getJob("job-1");
    expect(job?.artifacts).toEqual(["report.xlsx"]);

    const artifacts = await store.listArtifacts("job-1");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("report.xlsx");
  });

  it("finishes jobs and records exit code/signal/error", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "job-1", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    const claimed = await store.claimNextQueuedJob();
    expect(claimed).not.toBeNull();

    const updated = await store.setJobPid("job-1", 1234);
    expect(updated).toBe(true);

    const finished = await store.finishJob("job-1", "failed", 1, "SIGTERM", "boom");
    expect(finished).toBe(true);

    const job = await store.getJob("job-1");
    expect(job?.status).toBe("failed");
    expect(job?.exit_code).toBe(1);
    expect(job?.signal).toBe("SIGTERM");
    expect(job?.error).toBe("boom");
    expect(job?.pid).toBeNull();
  });

  it("cancels queued or running jobs", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "job-1", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.createJob({ id: "job-2", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.claimNextQueuedJob();

    expect(await store.cancelJob("job-1")).toBe(true);
    expect(await store.cancelJob("job-2")).toBe(true);

    expect((await store.getJob("job-1"))?.status).toBe("cancelled");
    expect((await store.getJob("job-2"))?.status).toBe("cancelled");
    expect(await store.cancelJob("job-1")).toBe(false);
  });

  it("resets running jobs to interrupted", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "job-1", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.claimNextQueuedJob();

    const reset = await store.resetRunningJobs();
    expect(reset).toBe(1);

    const job = await store.getJob("job-1");
    expect(job?.status).toBe("interrupted");
    expect(job?.finished_at).not.toBeNull();
  });

  it("persists data to disk and reloads it in a new store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-jobstore-"));
    const dbPath = path.join(dir, "jobs.db");

    const first = openSqlite(dbPath);
    await first.createJob({ id: "job-1", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await first.claimNextQueuedJob();
    await first.appendLog("job-1", "stdout", "hello");
    await first.finishJob("job-1", "completed", 0, null);
    await first.close();

    const second = openSqlite(dbPath);
    const job = await second.getJob("job-1");
    expect(job?.status).toBe("completed");
    const logs = await second.getLogs("job-1");
    expect(logs[0]?.line).toBe("hello");
  });

  it("getLatestJobByType returns the most recent job of that type", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "scrape-1", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    // Sleep >1ms so created_at is strictly greater for the autopilot jobs.
    await new Promise((r) => setTimeout(r, 5));
    await store.createJob({ id: "auto-1", type: "kz-autopilot", command: "node", args: [], request: {}, cwd: process.cwd() });
    await new Promise((r) => setTimeout(r, 5));
    await store.createJob({ id: "auto-2", type: "kz-autopilot", command: "node", args: [], request: {}, cwd: process.cwd() });
    await new Promise((r) => setTimeout(r, 5));
    await store.createJob({ id: "export-1", type: "kz-export", command: "node", args: [], request: {}, cwd: process.cwd() });

    const latest = await store.getLatestJobByType("kz-autopilot");
    expect(latest?.id).toBe("auto-2");

    const latestScrape = await store.getLatestJobByType("scrape");
    expect(latestScrape?.id).toBe("scrape-1");

    const latestEnrich = await store.getLatestJobByType("kz-enrich");
    expect(latestEnrich).toBeNull();
  });

  it("getLatestJobByType returns hydrated job with artifacts", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "auto-1", type: "kz-autopilot", command: "node", args: ["--dry-run"], request: {}, cwd: process.cwd() });
    await store.claimNextQueuedJob();
    await store.saveArtifacts("auto-1", [
      { name: "autopilot.json", path: "/tmp/autopilot.json", size: 12, mtime: new Date().toISOString() },
      { name: "digest.xlsx", path: "/tmp/digest.xlsx", size: 3456, mtime: new Date().toISOString() }
    ]);
    await store.finishJob("auto-1", "completed", 0, null);

    const latest = await store.getLatestJobByType("kz-autopilot");
    expect(latest).not.toBeNull();
    expect(latest?.status).toBe("completed");
    expect(latest?.exit_code).toBe(0);
    expect(latest?.artifacts).toEqual(["autopilot.json", "digest.xlsx"]);
  });

  it("pruneTerminalJobsBefore deletes only old terminal jobs and cascades logs/artifacts", async () => {
    const db = new Database(":memory:");
    const store = openSqlite(db);

    // Old completed job — must be pruned.
    await store.createJob({ id: "old-completed", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.claimNextQueuedJob();
    await store.appendLog("old-completed", "stdout", "before");
    await store.saveArtifacts("old-completed", [
      { name: "old.csv", path: "/tmp/old.csv", size: 10, mtime: new Date().toISOString() }
    ]);
    await store.finishJob("old-completed", "completed", 0, null);
    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?").run("2024-01-01T00:00:00.000Z", "old-completed");

    // Old failed job — must be pruned.
    await store.createJob({ id: "old-failed", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.claimNextQueuedJob();
    await store.appendLog("old-failed", "stderr", "boom");
    await store.finishJob("old-failed", "failed", 1, null, "boom");
    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?").run("2024-01-02T00:00:00.000Z", "old-failed");

    // Old cancelled job — must be pruned.
    await store.createJob({ id: "old-cancelled", type: "kz-enrich", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.cancelJob("old-cancelled");
    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?").run("2024-01-03T00:00:00.000Z", "old-cancelled");

    // Old interrupted job — must be pruned.
    await store.createJob({ id: "old-interrupted", type: "kz-export", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.claimNextQueuedJob();
    await store.resetRunningJobs();
    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?").run("2024-01-04T00:00:00.000Z", "old-interrupted");

    // Recent completed job — must be preserved.
    await store.createJob({ id: "recent-completed", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.claimNextQueuedJob();
    await store.finishJob("recent-completed", "completed", 0, null);

    const cutoff = "2025-01-01T00:00:00.000Z";
    const pruned = await store.pruneTerminalJobsBefore(cutoff);
    expect(pruned).toBe(4);

    expect(await store.getJob("old-completed")).toBeNull();
    expect(await store.getJob("old-failed")).toBeNull();
    expect(await store.getJob("old-cancelled")).toBeNull();
    expect(await store.getJob("old-interrupted")).toBeNull();
    expect(await store.getJob("recent-completed")).not.toBeNull();

    // FK ON DELETE CASCADE should have removed logs and artifacts.
    expect(await store.getLogs("old-completed")).toEqual([]);
    expect(await store.listArtifacts("old-completed")).toEqual([]);

    const remaining = await store.listJobs({});
    expect(remaining.total).toBe(1);
    expect(remaining.jobs[0]?.id).toBe("recent-completed");
  });

  it("pruneTerminalJobsBefore preserves queued and running jobs even when old", async () => {
    const db = new Database(":memory:");
    const store = openSqlite(db);

    // Old queued job (claim only one, leave the other queued).
    await store.createJob({ id: "old-queued", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.createJob({ id: "old-queued-anchor", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    await store.claimNextQueuedJob(); // old-queued now running
    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?").run("2024-01-01T00:00:00.000Z", "old-queued");
    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?").run("2024-01-01T00:00:00.000Z", "old-queued-anchor");

    // Add a third queued job that is also old.
    await store.createJob({ id: "old-queued-2", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?").run("2024-01-01T00:00:00.000Z", "old-queued-2");

    const pruned = await store.pruneTerminalJobsBefore("2025-01-01T00:00:00.000Z");
    expect(pruned).toBe(0);

    const queued2 = await store.getJob("old-queued-2");
    expect(queued2?.status).toBe("queued");

    const running = await store.getJob("old-queued");
    expect(running?.status).toBe("running");

    const anchor = await store.getJob("old-queued-anchor");
    expect(anchor?.status).toBe("queued");

    const total = await store.listJobs({});
    expect(total.total).toBe(3);
  });

  it("pruneTerminalJobsBefore returns 0 when there is nothing to prune", async () => {
    const store = openSqlite(":memory:");
    await store.createJob({ id: "job-1", type: "scrape", command: "node", args: [], request: {}, cwd: process.cwd() });
    const pruned = await store.pruneTerminalJobsBefore("2020-01-01T00:00:00.000Z");
    expect(pruned).toBe(0);
    const total = await store.listJobs({});
    expect(total.total).toBe(1);
  });
});

describe("Postgres api_jobs migration contract", () => {
  beforeEach(() => {
    pgState.queries.length = 0;
  });

  it("v3 migration creates api_jobs, api_job_logs and api_job_artifacts", async () => {
    const { MIGRATIONS } = await import("../src/storage/postgres/migrations.js");
    const v3 = MIGRATIONS.find((m) => m.version === 3);
    expect(v3).toBeDefined();
    expect(v3?.sql).toContain("CREATE TABLE IF NOT EXISTS api_jobs");
    expect(v3?.sql).toContain("CREATE TABLE IF NOT EXISTS api_job_logs");
    expect(v3?.sql).toContain("CREATE TABLE IF NOT EXISTS api_job_artifacts");
    expect(v3?.sql).toContain("TIMESTAMPTZ");
  });

  it("PostgresJobStore uses no destructive casts on JSON fields", async () => {
    const { PostgresJobStore } = await import("../src/storage/postgres/apiJobStore.js");
    const pg = new PostgresJobStore("postgres://u:p@localhost/db");
    stores.push(pg);
    await pg.createJob({ id: "job-1", type: "scrape", command: "node", args: ["a"], request: { x: 1 }, cwd: "/tmp" });

    const insert = pgState.queries.find((q) => /INSERT INTO api_jobs/.test(q.text));
    expect(insert).toBeDefined();
    expect(insert?.params[3]).toBe(JSON.stringify(["a"]));
    expect(insert?.params[4]).toBe(JSON.stringify({ x: 1 }));
    expect(insert?.text).not.toMatch(/::jsonb/);
  });
});
