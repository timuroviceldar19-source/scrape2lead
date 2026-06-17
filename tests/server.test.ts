import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  buildJobInvocation,
  createApiServer,
  handleStaticStreamError,
  npxCommand,
  normalizeSpawnInvocation,
  resolveCliInvocation,
  safeListen,
  validateRemoteBind,
  type ApiServer,
  type SpawnRunner,
  type SpawnedProcess
} from "../src/server.js";
import { SqliteJobStore, type IJobStore } from "../src/storage/apiJobStore.js";
import { runMigrations } from "../src/storage/migrations.js";

class FakeProcess extends EventEmitter implements SpawnedProcess {
  pid = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

class FakeRunner implements SpawnRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  processes: FakeProcess[] = [];
  autoExit = true;

  start(command: string, args: string[], options: { cwd: string }): SpawnedProcess {
    this.calls.push({ command, args, cwd: options.cwd });
    const process = new FakeProcess();
    this.processes.push(process);
    if (this.autoExit) {
      queueMicrotask(() => {
        process.stdout.write("ok\n");
        process.stdout.end();
        process.stderr.end();
        process.emit("exit", 0, null);
      });
    }
    return process;
  }
}

interface App {
  server: ApiServer;
  url: string;
  cwd: string;
  jobStore: import("../src/storage/apiJobStore.js").IJobStore;
}

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => close(app)));
});

async function makeApp(options: {
  cwd?: string;
  runner?: SpawnRunner;
  apiToken?: string;
  maxConcurrentJobs?: number;
  maxLogLines?: number;
  sqliteDb?: Database.Database;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<App> {
  const cwd = options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-"));
  const runner = options.runner ?? new FakeRunner();
  const sqliteDb = options.sqliteDb ?? new Database(":memory:");
  const jobStore = new SqliteJobStore(sqliteDb);
  const server = createApiServer({
    cwd,
    spawnRunner: runner,
    jobStore,
    apiToken: options.apiToken,
    maxConcurrentJobs: options.maxConcurrentJobs,
    maxLogLines: options.maxLogLines,
    env: options.env
  });
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Expected TCP server address"));
        return;
      }
      resolve(addr);
    });
  });
  const app: App = { server, url: `http://127.0.0.1:${address.port}`, cwd, jobStore };
  apps.push(app);
  return app;
}

async function close(app: App): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    app.server.close((error) => error ? reject(error) : resolve());
  });
  await Promise.resolve(app.jobStore.close());
}

async function waitForStatus(
  app: App,
  jobId: string,
  status: string,
  timeoutMs = 2000
): Promise<import("../src/storage/apiJobStore.js").ApiJob> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await app.jobStore.getJob(jobId);
    if (job && job.status === status) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${status}`);
}

describe("scrape2lead API server", () => {
  it("serves health checks", async () => {
    const app = await makeApp();
    const response = await fetch(`${app.url}/health`);
    const body = await response.json() as { ok: boolean; service: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, service: "scrape2lead-api" });
  });

  it("returns lastAutopilotRun: null on /health when no autopilot job exists", async () => {
    const app = await makeApp();
    const response = await fetch(`${app.url}/health`);
    const body = await response.json() as {
      ok: boolean;
      lastAutopilotRun: unknown;
      jobStore: { ok: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.lastAutopilotRun).toBeNull();
    expect(body.jobStore).toEqual({ ok: true });
  });

  it("exposes the latest autopilot job fields in /health", async () => {
    const app = await makeApp();
    // Create two autopilot jobs so we can verify "latest" ordering.
    const first = await (await fetch(`${app.url}/api/v1/jobs/kz-autopilot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    })).json() as { job: { id: string } };
    await waitForStatus(app, first.job.id, "completed");

    // Tiny gap so created_at of the second job is strictly greater.
    await new Promise((r) => setTimeout(r, 5));

    const second = await (await fetch(`${app.url}/api/v1/jobs/kz-autopilot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    })).json() as { job: { id: string } };
    await waitForStatus(app, second.job.id, "completed");

    const health = await (await fetch(`${app.url}/health`)).json() as {
      lastAutopilotRun: null | {
        id: string;
        status: string;
        createdAt: string;
        startedAt: string | null;
        finishedAt: string | null;
        exitCode: number | null;
        error: string | null;
        artifacts: string[];
      };
      jobStore: { ok: boolean };
    };

    expect(health.jobStore).toEqual({ ok: true });
    expect(health.lastAutopilotRun).not.toBeNull();
    expect(health.lastAutopilotRun?.id).toBe(second.job.id);
    expect(health.lastAutopilotRun?.status).toBe("completed");
    expect(health.lastAutopilotRun?.exitCode).toBe(0);
    expect(typeof health.lastAutopilotRun?.createdAt).toBe("string");
    expect(typeof health.lastAutopilotRun?.startedAt).toBe("string");
    expect(typeof health.lastAutopilotRun?.finishedAt).toBe("string");
    expect(health.lastAutopilotRun?.error).toBeNull();
    expect(Array.isArray(health.lastAutopilotRun?.artifacts)).toBe(true);
  });

  it("ignores non-autopilot jobs when computing lastAutopilotRun", async () => {
    const app = await makeApp();
    // Create a non-autopilot job, then an autopilot job. The autopilot must win.
    const enrich = await (await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    })).json() as { job: { id: string } };
    await waitForStatus(app, enrich.job.id, "completed");

    await new Promise((r) => setTimeout(r, 5));

    const autopilot = await (await fetch(`${app.url}/api/v1/jobs/kz-autopilot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    })).json() as { job: { id: string } };
    await waitForStatus(app, autopilot.job.id, "completed");

    const health = await (await fetch(`${app.url}/health`)).json() as {
      lastAutopilotRun: { id: string };
    };
    expect(health.lastAutopilotRun.id).toBe(autopilot.job.id);
  });

  it("returns /health 200 ok:true with jobStore.ok=false when jobStore read fails", async () => {
    const jobStore = new SqliteJobStore(new Database(":memory:"));
    const original = jobStore.getLatestJobByType.bind(jobStore);
    jobStore.getLatestJobByType = async () => {
      throw new Error("boom");
    };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-healthfail-"));
    const server = createApiServer({ cwd, jobStore });
    apps.push({ server, url: "", cwd, jobStore });
    const { port } = await safeListen(server, { port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${port}`;

    const response = await fetch(`${base}/health`);
    const body = await response.json() as {
      ok: boolean;
      lastAutopilotRun: unknown;
      jobStore: { ok: boolean; error?: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.lastAutopilotRun).toBeNull();
    expect(body.jobStore.ok).toBe(false);
    expect(body.jobStore.error).toBe("boom");

    // restore so the standard afterEach close() can still close cleanly
    jobStore.getLatestJobByType = original;
  });

  it("prunes old terminal api_jobs on startup when SCRAPE2LEAD_JOB_RETENTION_DAYS is set", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-retention-"));
    const dbPath = path.join(cwd, "jobs.db");
    const db = new Database(dbPath);
    const runner = new FakeRunner();
    runner.autoExit = false;

    // First app creates a terminal job and re-ages it. We use autoExit=false
    // and drive the FakeProcess exit manually so the kz-enrich job reaches
    // a terminal status without any other process interference.
    const firstApp = await makeApp({ cwd, runner, sqliteDb: db });
    const create = await fetch(`${firstApp.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    });
    const { job } = await create.json() as { job: { id: string } };
    await waitForStatus(firstApp, job.id, "running");
    runner.processes[0]?.emit("exit", 0, null);
    await waitForStatus(firstApp, job.id, "completed");

    // Add a queued job that must be preserved even when "old". The second
    // app's drainQueue will claim it and (with autoExit=false) keep it in
    // "running" so the assertion below is deterministic.
    const queuedId = "preserved-queued";
    await firstApp.jobStore.createJob({
      id: queuedId,
      type: "scrape",
      command: "node",
      args: [],
      request: {},
      cwd
    });

    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?")
      .run("2024-01-01T00:00:00.000Z", job.id);
    db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?")
      .run("2024-01-01T00:00:00.000Z", queuedId);

    apps.splice(apps.indexOf(firstApp), 1);
    await close(firstApp);

    // Second app boots with retention=30 days; the completed job is well past
    // the cutoff, the queued job is old but must be preserved.
    const secondRunner = new FakeRunner();
    secondRunner.autoExit = false;
    const secondApp = await makeApp({
      cwd,
      runner: secondRunner,
      sqliteDb: new Database(dbPath),
      env: { SCRAPE2LEAD_JOB_RETENTION_DAYS: "30" }
    });

    // Pruned: old completed job is gone.
    expect(await secondApp.jobStore.getJob(job.id)).toBeNull();
    // Preserved: the queued job is still in the store. After the second
    // app's drainQueue runs the status can be "running" (if the runner
    // already claimed it) or "queued" (if the assertion runs before
    // drainQueue has scheduled the claim). Both prove the row survived
    // retention.
    const preserved = await secondApp.jobStore.getJob(queuedId);
    expect(preserved).not.toBeNull();
    expect(["queued", "running"]).toContain(preserved?.status);
  });

  it("does not prune when SCRAPE2LEAD_JOB_RETENTION_DAYS is empty or invalid", async () => {
    for (const value of ["", "0", "-1", "abc", "1.5"]) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-noret-"));
      const dbPath = path.join(cwd, "jobs.db");
      const db = new Database(dbPath);
      const firstApp = await makeApp({ cwd, sqliteDb: db });
      const { job } = await (await fetch(`${firstApp.url}/api/v1/jobs/kz-enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bins: ["960440000716"] })
      })).json() as { job: { id: string } };
      await waitForStatus(firstApp, job.id, "completed");
      db.prepare("UPDATE api_jobs SET created_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", job.id);
      apps.splice(apps.indexOf(firstApp), 1);
      await close(firstApp);

      const secondApp = await makeApp({
        cwd,
        sqliteDb: new Database(dbPath),
        env: { SCRAPE2LEAD_JOB_RETENTION_DAYS: value }
      });
      const preserved = await secondApp.jobStore.getJob(job.id);
      expect(preserved?.status).toBe("completed");
    }
  });

  it("accepts delayMs: 0 for kz-enrich and passes --delay-ms 0 to the child process", async () => {
    const runner = new FakeRunner();
    const app = await makeApp({ runner });
    const response = await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"], delayMs: 0 })
    });
    const body = await response.json() as { job: { id: string; args: string[] } };

    expect(response.status).toBe(202);
    const delayIdx = body.job.args.indexOf("--delay-ms");
    expect(delayIdx).toBeGreaterThanOrEqual(0);
    expect(body.job.args[delayIdx + 1]).toBe("0");

    await waitForStatus(app, body.job.id, "completed");
    const spawnArgs = runner.calls[0]?.args ?? [];
    const spawnDelayIdx = spawnArgs.indexOf("--delay-ms");
    expect(spawnDelayIdx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[spawnDelayIdx + 1]).toBe("0");
  });

  it("starts kz-enrich jobs and materializes inline BINs into a CSV", async () => {
    const app = await makeApp();
    const response = await fetch(`${app.url}/api/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bins: ["960440000716", "bad", "061040006408", "960440000716"],
        skipStat: true,
        goszakupMaxPages: 3
      })
    });
    const body = await response.json() as { job: { id: string; args: string[]; status: string } };

    expect(response.status).toBe(202);
    const csvPath = body.job.args[body.job.args.indexOf("enrich") + 1];
    expect(fs.readFileSync(csvPath, "utf8")).toBe("bin\n960440000716\n061040006408\n");

    const job = await waitForStatus(app, body.job.id, "completed");
    expect(job.status).toBe("completed");
    expect(job.exit_code).toBe(0);
  });

  it("requires auth when an API token is configured", async () => {
    const app = await makeApp({ apiToken: "secret" });

    const unauthorized = await fetch(`${app.url}/health`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${app.url}/health`, {
      headers: { Authorization: "Bearer secret" }
    });
    expect(authorized.status).toBe(200);
  });

  it("builds kz-export with default out under SCRAPE2LEAD_EXPORT_DIR", () => {
    const cwd = path.join(os.tmpdir(), "scrape2lead-build");
    const exportDir = path.join(cwd, "custom-exports");
    const jobId = "job-export-1";
    const invocation = buildJobInvocation("kz-export", {}, jobId, cwd, {
      SCRAPE2LEAD_EXPORT_DIR: exportDir
    });
    const outIdx = invocation.args.indexOf("--out");
    expect(outIdx).toBeGreaterThanOrEqual(0);
    expect(invocation.args[outIdx + 1]).toBe(path.join(exportDir, `kz-${jobId}.xlsx`));
  });

  it("builds kz-export with explicit out resolved under SCRAPE2LEAD_EXPORT_DIR", () => {
    const cwd = path.join(os.tmpdir(), "scrape2lead-build-explicit");
    const exportDir = path.join(cwd, "custom-exports");
    const invocation = buildJobInvocation(
      "kz-export",
      { out: "custom.xlsx" },
      "job-export-2",
      cwd,
      { SCRAPE2LEAD_EXPORT_DIR: exportDir }
    );
    const outIdx = invocation.args.indexOf("--out");
    expect(outIdx).toBeGreaterThanOrEqual(0);
    expect(invocation.args[outIdx + 1]).toBe(path.join(exportDir, "custom.xlsx"));
  });

  it("builds kz-export with exports/ prefix resolved to SCRAPE2LEAD_EXPORT_DIR basename", () => {
    const cwd = path.join(os.tmpdir(), "scrape2lead-build-prefix");
    const exportDir = path.join(cwd, "custom-exports");
    const invocation = buildJobInvocation(
      "kz-export",
      { out: "exports/custom-name.xlsx" },
      "job-export-3",
      cwd,
      { SCRAPE2LEAD_EXPORT_DIR: exportDir }
    );
    const outIdx = invocation.args.indexOf("--out");
    expect(outIdx).toBeGreaterThanOrEqual(0);
    expect(invocation.args[outIdx + 1]).toBe(path.join(exportDir, "custom-name.xlsx"));
  });

  it("builds the autopilot command from whitelisted flags only", () => {
    const cwd = process.cwd();
    const invocation = buildJobInvocation(
      "kz-autopilot",
      {
        batchCsv: "bins-batch.csv",
        dryRun: true,
        skipEnrich: true,
        maxPages: 5,
        enrichRetries: 2,
        enrichRetryBaseMs: 1000,
        enrichDeadlineMs: 300000,
        skipChannel: true,
        channelNiche: "construction",
        shell: "rm -rf ."
      },
      "job-1",
      cwd
    );

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(cwd, "scripts", "kz-autopilot.mts"),
      "--batch-csv",
      "bins-batch.csv",
      "--dry-run",
      "--skip-enrich",
      "--max-pages",
      "5",
      "--enrich-retries",
      "2",
      "--enrich-retry-base-ms",
      "1000",
      "--enrich-deadline-ms",
      "300000"
    ]);
    expect(invocation.args).not.toContain("--skip-channel");
    expect(invocation.args).not.toContain("--channel-niche");
  });

  it("kz-export without out writes to SCRAPE2LEAD_EXPORT_DIR and registers a downloadable artifact", async () => {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-export-"));
    const runner = new FakeRunner();
    runner.autoExit = false;
    const originalStart = runner.start.bind(runner);
    runner.start = (command, args, options) => {
      const proc = originalStart(command, args, options) as import("node:child_process").ChildProcessWithoutNullStreams;
      const outIdx = args.indexOf("--out");
      const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
      queueMicrotask(() => {
        setTimeout(() => {
          if (outPath) {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, "fake-xlsx", "utf8");
          }
          (proc.stdout as NodeJS.WriteStream | null)?.write("ok\n");
          (proc.stdout as NodeJS.WriteStream | null)?.end();
          (proc.stderr as NodeJS.WriteStream | null)?.end();
          proc.emit("exit", 0, null);
        }, 50);
      });
      return proc;
    };
    const app = await makeApp({ runner, env: { SCRAPE2LEAD_EXPORT_DIR: exportDir } });

    const response = await fetch(`${app.url}/api/v1/jobs/kz-export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(202);
    const { job } = await response.json() as { job: { id: string; args: string[] } };
    const outIdx = job.args.indexOf("--out");
    expect(outIdx).toBeGreaterThanOrEqual(0);
    expect(job.args[outIdx + 1]).toBe(path.join(exportDir, `kz-${job.id}.xlsx`));

    await waitForStatus(app, job.id, "completed");

    const list = await (await fetch(`${app.url}/api/v1/jobs/${job.id}/artifacts`)).json() as {
      artifacts: Array<{ id: number; name: string }>;
    };
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0]?.name).toBe(`kz-${job.id}.xlsx`);

    const download = await fetch(`${app.url}/api/v1/artifacts/${list.artifacts[0]?.id}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("fake-xlsx");
  });

  it("kz-export with exports/ out registers artifact in SCRAPE2LEAD_EXPORT_DIR and downloads via API", async () => {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-export-prefix-"));
    const runner = new FakeRunner();
    runner.autoExit = false;
    const originalStart = runner.start.bind(runner);
    runner.start = (command, args, options) => {
      const proc = originalStart(command, args, options) as import("node:child_process").ChildProcessWithoutNullStreams;
      const outIdx = args.indexOf("--out");
      const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
      queueMicrotask(() => {
        setTimeout(() => {
          if (outPath) {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, "fake-prefix-xlsx", "utf8");
          }
          (proc.stdout as NodeJS.WriteStream | null)?.write("ok\n");
          (proc.stdout as NodeJS.WriteStream | null)?.end();
          (proc.stderr as NodeJS.WriteStream | null)?.end();
          proc.emit("exit", 0, null);
        }, 50);
      });
      return proc;
    };
    const app = await makeApp({ runner, env: { SCRAPE2LEAD_EXPORT_DIR: exportDir } });

    const response = await fetch(`${app.url}/api/v1/jobs/kz-export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ out: "exports/custom-name.xlsx" })
    });
    expect(response.status).toBe(202);
    const { job } = await response.json() as { job: { id: string; args: string[] } };
    const outIdx = job.args.indexOf("--out");
    expect(outIdx).toBeGreaterThanOrEqual(0);
    expect(job.args[outIdx + 1]).toBe(path.join(exportDir, "custom-name.xlsx"));

    await waitForStatus(app, job.id, "completed");

    const list = await (await fetch(`${app.url}/api/v1/jobs/${job.id}/artifacts`)).json() as {
      artifacts: Array<{ id: number; name: string }>;
    };
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0]?.name).toBe("custom-name.xlsx");

    const download = await fetch(`${app.url}/api/v1/artifacts/${list.artifacts[0]?.id}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("fake-prefix-xlsx");
  });

  it("exposes /api/v1 routes and keeps /api compatibility aliases", async () => {
    const app = await makeApp();
    const createViaV1 = await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    });
    expect(createViaV1.status).toBe(202);
    const { job } = await createViaV1.json() as { job: { id: string } };

    await waitForStatus(app, job.id, "completed");

    const listV1 = await fetch(`${app.url}/api/v1/jobs`);
    expect(listV1.status).toBe(200);
    const listLegacy = await fetch(`${app.url}/api/jobs`);
    expect(listLegacy.status).toBe(200);

    const detailV1 = await fetch(`${app.url}/api/v1/jobs/${job.id}`);
    const detailLegacy = await fetch(`${app.url}/api/jobs/${job.id}`);
    expect(detailV1.status).toBe(200);
    expect(detailLegacy.status).toBe(200);

    const logsV1 = await fetch(`${app.url}/api/v1/jobs/${job.id}/logs`);
    const logsLegacy = await fetch(`${app.url}/api/jobs/${job.id}/logs`);
    expect(logsV1.status).toBe(200);
    expect(logsLegacy.status).toBe(200);
  });

  it("lists jobs with status filter and pagination", async () => {
    const app = await makeApp();
    const runner = new FakeRunner();
    runner.autoExit = false;
    const firstApp = await makeApp({ runner });

    const create = await fetch(`${firstApp.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    });
    const { job } = await create.json() as { job: { id: string } };

    await waitForStatus(firstApp, job.id, "running");

    const runningResponse = await fetch(`${firstApp.url}/api/v1/jobs?status=running`);
    const runningBody = await runningResponse.json() as { jobs: unknown[]; total: number };
    expect(runningBody.total).toBe(1);

    const queuedResponse = await fetch(`${firstApp.url}/api/v1/jobs?status=queued`);
    const queuedBody = await queuedResponse.json() as { jobs: unknown[]; total: number };
    expect(queuedBody.total).toBe(0);

    const limited = await fetch(`${firstApp.url}/api/v1/jobs?limit=0`);
    expect((await limited.json() as { jobs: unknown[] }).jobs).toHaveLength(1);

    runner.processes[0]?.emit("exit", 0, null);
  });

  it("queues jobs and limits concurrent execution to 1 by default", async () => {
    const runner = new FakeRunner();
    runner.autoExit = false;
    const app = await makeApp({ runner });

    const first = await (await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    })).json() as { job: { id: string } };
    const second = await (await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["061040006408"] })
    })).json() as { job: { id: string } };

    await waitForStatus(app, first.job.id, "running");
    const secondJob = await app.jobStore.getJob(second.job.id);
    expect(secondJob?.status).toBe("queued");

    runner.processes[0]?.emit("exit", 0, null);
    await waitForStatus(app, second.job.id, "running");
    runner.processes[1]?.emit("exit", 0, null);

    await waitForStatus(app, second.job.id, "completed");
    expect(runner.calls).toHaveLength(2);
  });

  it("persists logs after the process exits and the server is recreated", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-"));
    const dbPath = path.join(cwd, "jobs.db");
    const runner = new FakeRunner();
    runner.autoExit = true;
    const firstApp = await makeApp({ cwd, runner, sqliteDb: new Database(dbPath) });

    const create = await fetch(`${firstApp.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    });
    const { job } = await create.json() as { job: { id: string } };

    await waitForStatus(firstApp, job.id, "completed");
    apps.splice(apps.indexOf(firstApp), 1);
    await close(firstApp);

    const secondApp = await makeApp({ cwd, runner, sqliteDb: new Database(dbPath) });
    const logsResponse = await fetch(`${secondApp.url}/api/v1/jobs/${job.id}/logs`);
    const logsBody = await logsResponse.json() as { logs: Array<{ line: string }> };
    expect(logsBody.logs.some((l) => l.line === "ok")).toBe(true);

    const detailResponse = await fetch(`${secondApp.url}/api/v1/jobs/${job.id}`);
    const detailBody = await detailResponse.json() as { job: { status: string } };
    expect(detailBody.job.status).toBe("completed");
  });

  it("marks stale running jobs as interrupted on startup", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-"));
    const dbPath = path.join(cwd, "jobs.db");
    const runner = new FakeRunner();
    runner.autoExit = false;
    const firstApp = await makeApp({ cwd, runner, sqliteDb: new Database(dbPath) });

    const create = await fetch(`${firstApp.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    });
    const { job } = await create.json() as { job: { id: string } };
    await waitForStatus(firstApp, job.id, "running");

    // Simulate a crash by closing the server without letting the process exit.
    apps.splice(apps.indexOf(firstApp), 1);
    await close(firstApp);

    const secondApp = await makeApp({ cwd, runner, sqliteDb: new Database(dbPath) });
    const detail = await (await fetch(`${secondApp.url}/api/v1/jobs/${job.id}`)).json() as { job: { status: string } };
    expect(detail.job.status).toBe("interrupted");
  });

  it("cancels queued jobs immediately and running jobs via SIGTERM", async () => {
    const runner = new FakeRunner();
    runner.autoExit = false;
    const app = await makeApp({ runner });

    const first = await (await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    })).json() as { job: { id: string } };

    const second = await (await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["061040006408"] })
    })).json() as { job: { id: string } };

    await waitForStatus(app, first.job.id, "running");

    const cancelQueued = await fetch(`${app.url}/api/v1/jobs/${second.job.id}/cancel`, { method: "POST" });
    expect(cancelQueued.status).toBe(200);
    const queuedJob = await app.jobStore.getJob(second.job.id);
    expect(queuedJob?.status).toBe("cancelled");

    const cancelRunning = await fetch(`${app.url}/api/v1/jobs/${first.job.id}/cancel`, { method: "POST" });
    expect(cancelRunning.status).toBe(200);
    await waitForStatus(app, first.job.id, "cancelled");
    expect(runner.processes[0]?.killed).toBe(true);

    const cancelCompleted = await fetch(`${app.url}/api/v1/jobs/${first.job.id}/cancel`, { method: "POST" });
    expect(cancelCompleted.status).toBe(409);
  });

  it("rejects artifact path traversal and unknown / unpersisted files", async () => {
    const app = await makeApp();
    const jobId = await seedJob(app.jobStore);

    const traversal = await fetch(`${app.url}/api/v1/artifacts/../package.json`);
    expect(traversal.status).toBe(404);

    const absolute = await fetch(`${app.url}/api/v1/artifacts/C:/Windows/win.ini`);
    expect(absolute.status).toBe(404);

    const unknownNumeric = await fetch(`${app.url}/api/v1/artifacts/424242`);
    expect(unknownNumeric.status).toBe(404);

    const jobArtifactsTraversal = await fetch(`${app.url}/api/v1/jobs/${jobId}/artifacts/..%2F..%2Fpackage.json`);
    expect(jobArtifactsTraversal.status).toBe(400);

    const slashTraversal = await fetch(`${app.url}/api/v1/jobs/${jobId}/artifacts/${encodeURIComponent("sub/file.csv")}`);
    expect(slashTraversal.status).toBe(400);
  });

  it("rejects a remote bind without an API token", () => {
    expect(() => validateRemoteBind("0.0.0.0", undefined)).toThrow();
    expect(() => validateRemoteBind("192.168.1.1", undefined)).toThrow();
    expect(() => validateRemoteBind("0.0.0.0", "secret")).not.toThrow();
    expect(() => validateRemoteBind("127.0.0.1", undefined)).not.toThrow();
    expect(() => validateRemoteBind("::1", undefined)).not.toThrow();
  });
});

async function seedLogs(jobStore: IJobStore, jobId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await jobStore.appendLog(jobId, "stdout", `line-${i}`);
  }
}

async function seedJob(jobStore: IJobStore, suffix = ""): Promise<string> {
  const id = `seed-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`;
  await jobStore.createJob({
    id,
    type: "scrape",
    command: "node",
    args: [],
    request: {},
    cwd: process.cwd()
  });
  return id;
}

describe("scrape2lead API server — artifacts jobStore contract", () => {
  it("lists artifacts persisted in the job store", async () => {
    const app = await makeApp();
    const jobId = await seedJob(app.jobStore);
    const writeDir = path.resolve(cwdOr(app), "exports");
    fs.mkdirSync(writeDir, { recursive: true });
    const filename = `report-${jobId}.csv`;
    const filePath = path.join(writeDir, filename);
    fs.writeFileSync(filePath, "bin\n061040006408\n", "utf8");

    await app.jobStore.saveArtifacts(jobId, [
      { name: filename, path: filePath, size: fs.statSync(filePath).size, mtime: fs.statSync(filePath).mtime.toISOString() }
    ]);

    const listResponse = await fetch(`${app.url}/api/v1/artifacts`);
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as { artifacts: Array<{ id: number; name: string; jobId: string; size: number; mtime: string }>; source: string };
    expect(listBody.source).toBe("jobStore");
    expect(listBody.artifacts).toHaveLength(1);
    expect(listBody.artifacts[0]).toMatchObject({ name: filename, jobId, size: fs.statSync(filePath).size });
    expect(listBody.artifacts[0]?.id).toBeGreaterThan(0);
    expect(listBody.artifacts[0]?.mtime).toBe(fs.statSync(filePath).mtime.toISOString());

    fs.rmSync(filePath, { force: true });
  });

  it("downloads a persisted artifact by id and by job name", async () => {
    const app = await makeApp();
    const jobId = await seedJob(app.jobStore);
    const writeDir = path.resolve(cwdOr(app), "exports");
    fs.mkdirSync(writeDir, { recursive: true });
    const filename = `payload-${jobId}.csv`;
    const filePath = path.join(writeDir, filename);
    const body = "bin\n960440000716\n";
    fs.writeFileSync(filePath, body, "utf8");
    await app.jobStore.saveArtifacts(jobId, [
      { name: filename, path: filePath, size: Buffer.byteLength(body), mtime: fs.statSync(filePath).mtime.toISOString() }
    ]);

    const list = await (await fetch(`${app.url}/api/v1/artifacts`)).json() as { artifacts: Array<{ id: number; name: string }> };
    const id = list.artifacts[0]?.id;
    expect(id).toBeGreaterThan(0);

    const byId = await fetch(`${app.url}/api/v1/artifacts/${id}`);
    expect(byId.status).toBe(200);
    expect(await byId.text()).toBe(body);

    const byJobName = await fetch(`${app.url}/api/v1/jobs/${jobId}/artifacts/${encodeURIComponent(filename)}`);
    expect(byJobName.status).toBe(200);
    expect(await byJobName.text()).toBe(body);

    const perJobList = await (await fetch(`${app.url}/api/v1/jobs/${jobId}/artifacts`)).json() as { artifacts: Array<{ name: string }> };
    expect(perJobList.artifacts).toHaveLength(1);
    expect(perJobList.artifacts[0]?.name).toBe(filename);

    // Download must be denied after the file is removed.
    fs.rmSync(filePath, { force: true });
    const stale = await fetch(`${app.url}/api/v1/artifacts/${id}`);
    expect([404, 410]).toContain(stale.status);
  });

  it("rejects artifact download for unpersisted files by default and only serves them via explicit legacy fallback", async () => {
    const app = await makeApp();
    const writeDir = path.resolve(cwdOr(app), "exports");
    fs.mkdirSync(writeDir, { recursive: true });
    const filename = `unpersisted-${Date.now()}.csv`;
    const filePath = path.join(writeDir, filename);
    fs.writeFileSync(filePath, "should not be served", "utf8");

    const direct = await fetch(`${app.url}/api/v1/artifacts/${encodeURIComponent(filename)}`);
    expect(direct.status).toBe(404);

    // The job store has no record, and the numeric id is invalid: still 404.
    const numeric = await fetch(`${app.url}/api/v1/artifacts/${encodeURIComponent(filename)}?legacy=0`);
    expect(numeric.status).toBe(404);

    fs.rmSync(filePath, { force: true });
  });

  it("legacy fallback surfaces exports only when explicitly enabled and never over the API by default", async () => {
    const app = await makeApp();
    const writeDir = path.resolve(cwdOr(app), "exports");
    fs.mkdirSync(writeDir, { recursive: true });
    const filename = `compat-${Date.now()}.csv`;
    const filePath = path.join(writeDir, filename);
    fs.writeFileSync(filePath, "compat", "utf8");

    const defaultList = await (await fetch(`${app.url}/api/v1/artifacts`)).json() as { artifacts: Array<{ name: string }>; source: string };
    expect(defaultList.source).toBe("jobStore");
    expect(defaultList.artifacts.some((a) => a.name === filename)).toBe(false);

    const legacyList = await (await fetch(`${app.url}/api/v1/artifacts?legacy=1`)).json() as { artifacts: Array<{ id: number; name: string; jobId: string }>; source: string };
    expect(legacyList.source).toBe("jobStore+exports");
    const compat = legacyList.artifacts.find((a) => a.name === filename);
    expect(compat).toBeDefined();
    expect(compat?.jobId).toBe("legacy-exports");

    fs.rmSync(filePath, { force: true });
  });
});

describe("scrape2lead API server — logs limit", () => {
  it("caps default log responses to maxLogLines", async () => {
    const app = await makeApp({ maxLogLines: 5 });
    const jobId = await seedJob(app.jobStore);
    await seedLogs(app.jobStore, jobId, 20);

    const detail = await (await fetch(`${app.url}/api/v1/jobs/${jobId}`)).json() as { job: { logs: unknown[]; maxLogLines?: number } };
    expect(detail.job.logs).toHaveLength(5);

    const logs = await (await fetch(`${app.url}/api/v1/jobs/${jobId}/logs`)).json() as { logs: unknown[]; total: number; limit: number; maxLogLines: number };
    expect(logs.logs).toHaveLength(5);
    expect(logs.total).toBe(20);
    expect(logs.limit).toBe(5);
    expect(logs.maxLogLines).toBe(5);
  });

  it("applies limit/offset query parameters to the logs endpoint", async () => {
    const app = await makeApp({ maxLogLines: 100 });
    const jobId = await seedJob(app.jobStore);
    await seedLogs(app.jobStore, jobId, 12);

    const limited = await (await fetch(`${app.url}/api/v1/jobs/${jobId}/logs?limit=3&offset=2`)).json() as { logs: Array<{ line: string }>; limit: number; offset: number };
    expect(limited.logs.map((l) => l.line)).toEqual(["line-2", "line-3", "line-4"]);
    expect(limited.limit).toBe(3);
    expect(limited.offset).toBe(2);

    const tail = await (await fetch(`${app.url}/api/v1/jobs/${jobId}/logs?limit=2&offset=10`)).json() as { logs: Array<{ line: string }> };
    expect(tail.logs.map((l) => l.line)).toEqual(["line-10", "line-11"]);

    const outOfRange = await (await fetch(`${app.url}/api/v1/jobs/${jobId}/logs?limit=5&offset=100`)).json() as { logs: unknown[] };
    expect(outOfRange.logs).toHaveLength(0);
  });

  it("clamps the requested limit to maxLogLines", async () => {
    const app = await makeApp({ maxLogLines: 5 });
    const jobId = await seedJob(app.jobStore);
    await seedLogs(app.jobStore, jobId, 20);

    const oversized = await (await fetch(`${app.url}/api/v1/jobs/${jobId}/logs?limit=10000`)).json() as { logs: unknown[]; limit: number };
    expect(oversized.logs).toHaveLength(5);
    expect(oversized.limit).toBe(5);
  });

  it("falls back to the default maxLogLines when env is not set", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-env-"));
    const jobStore = new SqliteJobStore(new Database(":memory:"));
    const server = createApiServer({ cwd, jobStore, env: {} });
    apps.push({ server, url: "", cwd, jobStore });
    // safeListen is the public listener entry-point; we use it to read the actual port.
    const { port } = await safeListen(server, { port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${port}`;
    const jobId = await seedJob(jobStore);
    await seedLogs(jobStore, jobId, 600);

    const logs = await (await fetch(`${base}/api/v1/jobs/${jobId}/logs`)).json() as { logs: unknown[]; limit: number; maxLogLines: number };
    expect(logs.maxLogLines).toBe(500);
    expect(logs.limit).toBe(500);
    expect(logs.logs).toHaveLength(500);
  });
});

describe("scrape2lead API server — safeListen", () => {
  it("refuses to bind a remote host without an API token", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-listen-"));
    const jobStore = new SqliteJobStore(new Database(":memory:"));
    const server = createApiServer({ cwd, jobStore });
    // safeListen validates synchronously before returning a promise, so the
    // unsafe-bind check must throw immediately to fail fast.
    expect(() => safeListen(server, { port: 0, host: "0.0.0.0" })).toThrow(/SCRAPE2LEAD_API_TOKEN/);
    server.close();
    jobStore.close();
  });

  it("binds a remote host when an API token is provided", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-listen-"));
    const jobStore = new SqliteJobStore(new Database(":memory:"));
    const server = createApiServer({ cwd, jobStore, apiToken: "secret" });
    const info = await safeListen(server, { port: 0, host: "127.0.0.1", apiToken: "secret" });
    expect(info.port).toBeGreaterThan(0);
    server.close();
    jobStore.close();
  });
});

function seedOutreachPair(
  db: Database.Database,
  bin: string,
  tenderNumber: string,
  kind: "winner" | "prospect",
  createdAt: string
): void {
  runMigrations(db);
  db.prepare(`
    INSERT INTO outreach_seen (bin, tender_number, kind, first_seen_at)
    VALUES (?, ?, ?, ?)
  `).run(bin, tenderNumber, kind, createdAt);
  db.prepare(`
    INSERT INTO outreach_items (run_id, bin, tender_number, kind, created_at)
    VALUES (NULL, ?, ?, ?, ?)
  `).run(bin, tenderNumber, kind, createdAt);
}

function seedKzOutreachDatabase(
  kzDbPath: string,
  bin: string,
  tenderNumber: string,
  kind: "winner" | "prospect",
  createdAt: string
): void {
  const db = new Database(kzDbPath);
  seedOutreachPair(db, bin, tenderNumber, kind, createdAt);
  db.close();
}

describe("scrape2lead API server — outreach status", () => {
  it("GET list requires auth when API token is set", async () => {
    const kzDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-kz-"));
    const kzDb = path.join(kzDir, "kz.db");
    seedKzOutreachDatabase(kzDb, "061040006408", "CT-100", "winner", "2026-06-01T10:00:00.000Z");
    const app = await makeApp({ apiToken: "secret", env: { KZ_DATABASE_PATH: kzDb } });

    const unauthorized = await fetch(`${app.url}/api/v1/outreach/items`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${app.url}/api/v1/outreach/items`, {
      headers: { Authorization: "Bearer secret" }
    });
    expect(authorized.status).toBe(200);
    const body = await authorized.json() as { items: Array<{ status: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.status).toBe("new");
  });

  it("PATCH validates status, kind, and body", async () => {
    const kzDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-kz-"));
    const kzDb = path.join(kzDir, "kz.db");
    seedKzOutreachDatabase(kzDb, "061040006408", "CT-100", "winner", "2026-06-01T10:00:00.000Z");
    const app = await makeApp({ env: { KZ_DATABASE_PATH: kzDb } });
    const base = `${app.url}/api/v1/outreach/items/061040006408/CT-100`;

    const badStatus = await fetch(`${base}/winner`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "bogus" })
    });
    expect(badStatus.status).toBe(400);

    const badKind = await fetch(`${base}/invalid-kind`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "contacted" })
    });
    expect(badKind.status).toBe(400);

    const badNote = await fetch(`${base}/winner`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "contacted", note: 123 })
    });
    expect(badNote.status).toBe(400);

    const ok = await fetch(`${base}/winner`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "contacted", note: "called" })
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { item: { status: string; note: string } };
    expect(body.item.status).toBe("contacted");
    expect(body.item.note).toBe("called");
  });

  it("jobs and artifacts endpoints still work alongside outreach routes", async () => {
    const kzDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-kz-"));
    const kzDb = path.join(kzDir, "kz.db");
    seedKzOutreachDatabase(kzDb, "061040006408", "CT-100", "winner", "2026-06-01T10:00:00.000Z");
    const app = await makeApp({ env: { KZ_DATABASE_PATH: kzDb } });

    const jobs = await fetch(`${app.url}/api/v1/jobs`);
    expect(jobs.status).toBe(200);
    const jobsBody = await jobs.json() as { jobs: unknown[] };
    expect(Array.isArray(jobsBody.jobs)).toBe(true);

    const artifacts = await fetch(`${app.url}/api/v1/artifacts`);
    expect(artifacts.status).toBe(200);
    const artifactsBody = await artifacts.json() as { artifacts: unknown[] };
    expect(Array.isArray(artifactsBody.artifacts)).toBe(true);

    const outreach = await fetch(`${app.url}/api/v1/outreach/items`);
    expect(outreach.status).toBe(200);
  });

  it("reads outreach from KZ database path independent of job store database", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-kz-split-"));
    const jobDb = path.join(cwd, "job.db");
    const kzDb = path.join(cwd, "kz.db");

    seedKzOutreachDatabase(kzDb, "061040006408", "CT-200", "prospect", "2026-06-02T10:00:00.000Z");

    const jobSqlite = new Database(jobDb);
    runMigrations(jobSqlite);

    const app = await makeApp({
      cwd,
      sqliteDb: jobSqlite,
      env: {
        SCRAPE2LEAD_DATABASE_PATH: jobDb,
        KZ_DATABASE_PATH: kzDb
      }
    });

    const res = await fetch(`${app.url}/api/v1/outreach/items`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ bin: string; tenderNumber: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.bin).toBe("061040006408");
    expect(body.items[0]?.tenderNumber).toBe("CT-200");

    const jobRow = jobSqlite.prepare("SELECT COUNT(*) AS n FROM api_jobs").get() as { n: number };
    expect(jobRow.n).toBe(0);
  });
});

describe("scrape2lead API server — operator UI static serving", () => {
  function seedOperatorFolder(cwd: string, files: Record<string, string> = {}): void {
    const dir = path.join(cwd, "public", "operator");
    fs.mkdirSync(dir, { recursive: true });
    const defaults: Record<string, string> = {
      "index.html": "<!doctype html><html><body>operator</body></html>",
      "operator.js": "window.S2L={};\n",
      "operator.css": "body{color:#000;}\n"
    };
    const all = Object.assign({}, defaults, files);
    for (const [name, content] of Object.entries(all)) {
      fs.writeFileSync(path.join(dir, name), content, "utf8");
    }
  }

  it("serves /operator and /operator/ as index.html without auth", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd, apiToken: "secret" });

    const root = await fetch(`${app.url}/operator`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toMatch(/^text\/html/);
    const rootBody = await root.text();
    expect(rootBody).toContain("operator");

    const trailing = await fetch(`${app.url}/operator/`);
    expect(trailing.status).toBe(200);
    expect(trailing.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("serves sibling static assets (js, css) with correct content types", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    const js = await fetch(`${app.url}/operator/operator.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^application\/javascript/);
    const jsBody = await js.text();
    expect(jsBody).toContain("S2L");

    const css = await fetch(`${app.url}/operator/operator.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    const cssBody = await css.text();
    expect(cssBody).toContain("color");
  });

  it("rejects path traversal attempts in /operator/* paths", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    // Drop a file at the project root and inside public/ outside the operator folder
    fs.writeFileSync(path.join(cwd, "secret.txt"), "TOP_SECRET", "utf8");
    fs.mkdirSync(path.join(cwd, "public"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "public", "secret.txt"), "PUBLIC_SECRET", "utf8");
    const app = await makeApp({ cwd });

    // Class A: Node's HTTP layer (and the URL parser) normalize `..` segments
    // and decoded `%2e%2e` between path separators. The result is either a
    // non-operator path (which 404s via the default handler) or a normalized
    // operator path that doesn't exist (which 404s via the static handler).
    // Either way, the secret files are never exposed.
    const direct = await fetch(`${app.url}/operator/../public/secret.txt`);
    expect(direct.status).toBe(404);

    const encoded = await fetch(`${app.url}/operator/%2e%2e/public/secret.txt`);
    expect(encoded.status).toBe(404);

    const dotdotNested = await fetch(`${app.url}/operator/foo/%2e%2e/bar`);
    expect(dotdotNested.status).toBe(404);

    const singleDot = await fetch(`${app.url}/operator/foo/.%2e/bar`);
    expect(singleDot.status).toBe(404);

    // Class B: encoded variants where the URL parser / Node HTTP layer keeps
    // the encoded form (no slashes between the encoded `..` segments, or
    // encoded separators that aren't decoded to a real path separator). The
    // raw-URL safety check in serveOperatorStatic rejects these with 400
    // before any fs resolution. The decoded segment either contains path
    // separators or a Windows drive letter.
    const encodedAll = await fetch(`${app.url}/operator/%2e%2e%2fpublic%2fsecret.txt`);
    expect(encodedAll.status).toBe(400);

    const encodedSlashInName = await fetch(`${app.url}/operator/foo%2Fbar`);
    expect(encodedSlashInName.status).toBe(400);

    const encodedBackslash = await fetch(`${app.url}/operator/foo%5Cbar`);
    expect(encodedBackslash.status).toBe(400);

    const drive = await fetch(`${app.url}/operator/C%3A%5Csecret.txt`);
    expect(drive.status).toBe(400);

    // Forbid files are still on disk and untouched.
    expect(fs.readFileSync(path.join(cwd, "secret.txt"), "utf8")).toBe("TOP_SECRET");
    expect(fs.readFileSync(path.join(cwd, "public", "secret.txt"), "utf8")).toBe("PUBLIC_SECRET");
  });

  it("returns 404 when the operator folder is missing or has no index.html", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    const app = await makeApp({ cwd });

    const root = await fetch(`${app.url}/operator`);
    expect(root.status).toBe(404);
  });

  it("does not block /api/v1 routes after the operator route is added", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    const list = await fetch(`${app.url}/api/v1/jobs?limit=5&offset=0`);
    expect(list.status).toBe(200);
    const listBody = await list.json() as { jobs: unknown[]; total: number };
    expect(Array.isArray(listBody.jobs)).toBe(true);
    expect(listBody.total).toBe(0);

    const create = await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"] })
    });
    expect(create.status).toBe(202);
    const { job } = await create.json() as { job: { id: string; status: string } };
    expect(job.id).toBeTruthy();
    await waitForStatus(app, job.id, "completed");
  });

  it("serves the operator UI even when an API token is configured", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd, apiToken: "secret" });

    // /operator must NOT require the token — that's the whole point of a
    // browser-based UI where the operator types the token into a form.
    const noAuth = await fetch(`${app.url}/operator`);
    expect(noAuth.status).toBe(200);
    expect(noAuth.headers.get("content-type")).toMatch(/^text\/html/);

    // /health, on the other hand, IS still auth-gated.
    const healthNoAuth = await fetch(`${app.url}/health`);
    expect(healthNoAuth.status).toBe(401);
    const healthWithAuth = await fetch(`${app.url}/health`, { headers: { Authorization: "Bearer secret" } });
    expect(healthWithAuth.status).toBe(200);
  });

  it("sets conservative security headers on /operator static responses", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    // Headers should be set on the HTML entry point and on sibling static assets
    // (JS, CSS) — the static handler applies the same headers to every file it
    // serves, so a single configuration is enough to cover all of them.
    const targets = [
      `${app.url}/operator`,
      `${app.url}/operator/operator.js`,
      `${app.url}/operator/operator.css`
    ];
    for (const url of targets) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toMatch(/script-src 'self'/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
    }
  });

  it("supports HEAD on /operator static with the same headers as GET and an empty body", async () => {
    // HEAD is useful for HTTP probes, monitoring, and link rel=preload. The
    // contract is: same status, same headers (including CSP / Cache-Control /
    // Content-Length), no body. We compare HEAD against GET per target so the
    // test does not lock in the full CSP string and stays robust to future
    // header tweaks.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    const targets = [
      `${app.url}/operator`,
      `${app.url}/operator/operator.js`,
      `${app.url}/operator/operator.css`
    ];
    for (const url of targets) {
      const getRes = await fetch(url);
      const headRes = await fetch(url, { method: "HEAD" });

      expect(getRes.status).toBe(200);
      expect(headRes.status).toBe(200);

      // Headers that must match exactly between GET and HEAD.
      const headerNames = [
        "content-type",
        "content-length",
        "content-security-policy",
        "x-content-type-options",
        "x-frame-options",
        "referrer-policy",
        "cache-control",
        "etag",
        "last-modified"
      ] as const;
      for (const name of headerNames) {
        const a = getRes.headers.get(name);
        const b = headRes.headers.get(name);
        expect({ name, get: a, head: b }).toEqual({ name, get: a, head: a });
      }

      // Body must be empty on HEAD.
      expect(await headRes.text()).toBe("");
    }
  });

  it("serves the real checked-in /operator index.html with operator-root-relative asset paths", async () => {
    // The previous version of public/operator/index.html used path-relative
    // href/src for the CSS/JS assets, which 404'd when the page was served
    // at /operator (no trailing slash) because the browser resolved them to
    // /operator.css and /operator.js at the root. The static handler only
    // serves /operator/*, so the page rendered unstyled and non-functional.
    // The fix is to use operator-root-relative URLs. This test copies the
    // real checked-in files into a temp cwd and verifies the contract end to
    // end: the HTML references the right paths, the assets are reachable,
    // and the old wrong paths are 404.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-real-"));
    const realDir = path.resolve(process.cwd(), "public", "operator");
    const tempDir = path.join(cwd, "public", "operator");
    fs.mkdirSync(tempDir, { recursive: true });
    for (const name of fs.readdirSync(realDir)) {
      fs.copyFileSync(path.join(realDir, name), path.join(tempDir, name));
    }
    const app = await makeApp({ cwd });

    // 1. /operator HTML references the assets via operator-root-relative paths.
    const htmlRes = await fetch(`${app.url}/operator`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toMatch(/href="\/operator\/operator\.css"/);
    expect(html).toMatch(/src="\/operator\/operator\.js"/);
    // And it does not regress to the old path-relative form.
    expect(html).not.toMatch(/href="operator\.css"/);
    expect(html).not.toMatch(/src="operator\.js"/);

    // 2. The referenced assets are actually reachable.
    const cssRes = await fetch(`${app.url}/operator/operator.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toMatch(/^text\/css/);
    const jsRes = await fetch(`${app.url}/operator/operator.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toMatch(/^application\/javascript/);

    // 3. The old wrong root-level paths are 404, so the page no longer
    //    depends on them. This guards against a future regression.
    const wrongCss = await fetch(`${app.url}/operator.css`);
    expect(wrongCss.status).toBe(404);
    const wrongJs = await fetch(`${app.url}/operator.js`);
    expect(wrongJs.status).toBe(404);
  });

  it("locks Cache-Control: no-cache and Content-Length on /operator static 200 responses", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    const expectations: Array<{ url: string; relPath: string }> = [
      { url: `${app.url}/operator`, relPath: "public/operator/index.html" },
      { url: `${app.url}/operator/operator.js`, relPath: "public/operator/operator.js" },
      { url: `${app.url}/operator/operator.css`, relPath: "public/operator/operator.css" }
    ];

    for (const { url, relPath } of expectations) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const expected = fs.statSync(path.join(cwd, relPath)).size;
      expect(res.headers.get("content-length")).toBe(String(expected));
    }
  });

  it("returns JSON 404 without static-only security headers when an /operator asset is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    for (const method of ["GET", "HEAD"] as const) {
      const res = await fetch(`${app.url}/operator/missing.js`, { method });

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);

      for (const h of [
        "content-security-policy",
        "x-frame-options",
        "x-content-type-options",
        "referrer-policy",
        "cache-control",
        "etag",
        "last-modified"
      ]) {
        expect(res.headers.get(h)).toBeNull();
      }

      if (method === "GET") {
        const body = await res.json() as { error?: string };
        expect(body.error).toBe("not_found");
      }
    }
  });

  it("sets ETag and Last-Modified on /operator static 200 responses", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    const expectations: Array<{ url: string; relPath: string }> = [
      { url: `${app.url}/operator`, relPath: "public/operator/index.html" },
      { url: `${app.url}/operator/operator.js`, relPath: "public/operator/operator.js" },
      { url: `${app.url}/operator/operator.css`, relPath: "public/operator/operator.css" }
    ];

    for (const { url, relPath } of expectations) {
      const stat = fs.statSync(path.join(cwd, relPath));
      const expectedEtag = `"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;

      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("etag")).toBe(expectedEtag);
      expect(Number.isNaN(Date.parse(first.headers.get("last-modified") ?? ""))).toBe(false);

      const second = await fetch(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("etag")).toBe(expectedEtag);
      expect(second.headers.get("last-modified")).toBe(first.headers.get("last-modified"));
    }
  });

  it("returns 304 with static headers and no body on GET with matching If-None-Match", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    const url = `${app.url}/operator/operator.js`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const notModified = await fetch(url, { headers: { "If-None-Match": etag ?? "" } });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    for (const h of [
      "etag",
      "last-modified",
      "cache-control",
      "content-security-policy",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy"
    ]) {
      expect(notModified.headers.get(h)).toBe(first.headers.get(h));
    }

    // 304 must not advertise a body length. Node strips Content-Length on
    // chunked/empty responses; we allow either "0" or null, but not the
    // actual file size.
    const cl = notModified.headers.get("content-length");
    expect([null, "0"]).toContain(cl);
  });

  it("returns 304 on HEAD with matching If-None-Match and no body", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    seedOperatorFolder(cwd);
    const app = await makeApp({ cwd });

    const url = `${app.url}/operator/operator.css`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const notModified = await fetch(url, { method: "HEAD", headers: { "If-None-Match": etag ?? "" } });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    expect(notModified.headers.get("etag")).toBe(etag);
    expect(notModified.headers.get("last-modified")).toBe(first.headers.get("last-modified"));
    for (const h of [
      "cache-control",
      "content-security-policy",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy"
    ]) {
      expect(notModified.headers.get(h)).not.toBeNull();
    }
  });

  it("returns 200 with body when If-None-Match does not match", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-"));
    const realDir = path.resolve(process.cwd(), "public", "operator");
    const tempDir = path.join(cwd, "public", "operator");
    fs.mkdirSync(tempDir, { recursive: true });
    for (const name of fs.readdirSync(realDir)) {
      fs.copyFileSync(path.join(realDir, name), path.join(tempDir, name));
    }
    const app = await makeApp({ cwd });

    const res = await fetch(`${app.url}/operator`, {
      headers: { "If-None-Match": '"definitely-not-the-etag"' }
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Scrape2Lead Operator");
    expect(res.headers.get("etag")).not.toBeNull();
    expect(res.headers.get("last-modified")).not.toBeNull();
  });

  it("serves the real checked-in /operator index.html with the kz-export submit form", async () => {
    // The dashboard exposes a small "Export KZ report" card that POSTs to
    // /api/v1/jobs/kz-export. This test guards the static contract so the
    // form does not regress to a non-functional state (e.g. after a card
    // rename) without the build breaking. We do not run JS — we just assert
    // the served HTML/JS contain the expected control ids and submit
    // handler marker. No jsdom dependency is introduced.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-export-"));
    const realDir = path.resolve(process.cwd(), "public", "operator");
    const tempDir = path.join(cwd, "public", "operator");
    fs.mkdirSync(tempDir, { recursive: true });
    for (const name of fs.readdirSync(realDir)) {
      fs.copyFileSync(path.join(realDir, name), path.join(tempDir, name));
    }
    const app = await makeApp({ cwd });

    const htmlRes = await fetch(`${app.url}/operator`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();

    // Export card scaffolding.
    expect(html).toMatch(/id="card-export"/);
    expect(html).toMatch(/id="export-form"/);
    expect(html).toMatch(/<h2>Export KZ report<\/h2>/);

    // Form controls: optional BIN textarea, optional filename input, submit button.
    expect(html).toMatch(/id="export-bins"/);
    expect(html).toMatch(/id="export-filename"/);
    expect(html).toMatch(/placeholder="kz-report\.xlsx"/);
    expect(html).toMatch(/data-action="submit-export"/);
    expect(html).toMatch(/>Export report</);

    // The export BIN textarea must be OPTIONAL — empty BINs export all DB
    // companies, so the helper text must be present in the served HTML.
    expect(html).toMatch(/Leave empty to export all companies/);

    // operator.js must contain the export submit handler marker. We do not
    // run the script, just verify the source served by /operator wires up
    // the form.
    const jsRes = await fetch(`${app.url}/operator/operator.js`);
    expect(jsRes.status).toBe(200);
    const js = await jsRes.text();
    expect(js).toMatch(/submitExportJob/);
    expect(js).toMatch(/exportForm\.addEventListener\("submit", submitExportJob\)/);
    expect(js).toMatch(/\/jobs\/kz-export/);
  });

  it("serves the real checked-in /operator index.html with the Outreach status card", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-api-ui-outreach-"));
    const realDir = path.resolve(process.cwd(), "public", "operator");
    const tempDir = path.join(cwd, "public", "operator");
    fs.mkdirSync(tempDir, { recursive: true });
    for (const name of fs.readdirSync(realDir)) {
      fs.copyFileSync(path.join(realDir, name), path.join(tempDir, name));
    }
    const app = await makeApp({ cwd });

    const htmlRes = await fetch(`${app.url}/operator`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();

    expect(html).toMatch(/id="card-outreach"/);
    expect(html).toMatch(/<h2>Outreach status<\/h2>/);
    expect(html).toMatch(/id="outreach-body"/);
    expect(html).toMatch(/data-action="refresh-outreach"/);

    const jsRes = await fetch(`${app.url}/operator/operator.js`);
    expect(jsRes.status).toBe(200);
    const js = await jsRes.text();
    expect(js).toMatch(/loadOutreach/);
    expect(js).toMatch(/saveOutreachItem/);
    expect(js).toMatch(/save-outreach/);
    expect(js).toMatch(/\/outreach\/items/);
  });
});

describe("scrape2lead API server — kz-export job contract", () => {
  it("starts kz-export jobs with an empty body (export all) and custom out", async () => {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-export-"));
    const app = await makeApp({ env: { SCRAPE2LEAD_EXPORT_DIR: exportDir } });
    const response = await fetch(`${app.url}/api/v1/jobs/kz-export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "xlsx", out: "exports/test-report.xlsx" })
    });
    expect(response.status).toBe(202);
    const body = await response.json() as {
      job: { id: string; type: string; status: string; args: string[] };
    };
    expect(body.job.type).toBe("kz-export");

    const job = await waitForStatus(app, body.job.id, "completed");
    expect(job.status).toBe("completed");
    expect(job.exit_code).toBe(0);

    // CLI invocation must include the kz export subcommand, the format flag,
    // the custom out (resolved under SCRAPE2LEAD_EXPORT_DIR), and MUST NOT
    // include --bins when no bins are provided.
    expect(body.job.args).toContain("export");
    expect(body.job.args).toContain("--format");
    expect(body.job.args).toContain("xlsx");
    expect(body.job.args).toContain("--out");
    const outIdx = body.job.args.indexOf("--out");
    expect(outIdx).toBeGreaterThan(-1);
    const outValue = body.job.args[outIdx + 1];
    expect(outValue).toBe(path.join(exportDir, "test-report.xlsx"));
    expect(path.basename(outValue)).toBe("test-report.xlsx");
    // Guard: the literal UI-supplied prefix must be rewritten, not passed through.
    expect(body.job.args).not.toContain("exports/test-report.xlsx");
    expect(body.job.args).not.toContain("--bins");
  });

  it("starts kz-export jobs with explicit inline BINs and materializes them into a CSV", async () => {
    const app = await makeApp();
    const response = await fetch(`${app.url}/api/v1/jobs/kz-export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "xlsx", bins: ["960440000716", "061040006408"] })
    });
    expect(response.status).toBe(202);
    const body = await response.json() as {
      job: { id: string; type: string; args: string[] };
    };
    expect(body.job.type).toBe("kz-export");

    const job = await waitForStatus(app, body.job.id, "completed");
    expect(job.status).toBe("completed");
    expect(job.exit_code).toBe(0);

    // --bins should point to a real CSV written under data/server-jobs.
    const binsIdx = body.job.args.indexOf("--bins");
    expect(binsIdx).toBeGreaterThan(-1);
    const csvPath = body.job.args[binsIdx + 1];
    expect(typeof csvPath).toBe("string");
    expect(csvPath).toMatch(/data[\\/]server-jobs[\\/].+-export-bins\.csv$/);
    expect(fs.readFileSync(csvPath, "utf8")).toBe(
      "bin\n960440000716\n061040006408\n"
    );
  });

  it("builds the kz-export CLI invocation from whitelisted fields only", () => {
    // Pure builder test: confirms the field set the UI relies on is honored
    // and that the format defaults to xlsx when the UI omits it. Use a temp
    // cwd because inline bins are materialized to data/server-jobs/bins.csv.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-kz-export-invoke-"));
    const invocation = buildJobInvocation(
      "kz-export",
      { bins: ["061040006408"] },
      "job-x",
      cwd
    );

    expect(invocation.args).toContain("export");
    expect(invocation.args).toContain("--format");
    expect(invocation.args).toContain("xlsx");
    expect(invocation.args).toContain("--bins");
  });
});

describe("scrape2lead API server — Windows-safe job spawn", () => {
  it("npxCommand returns npx.cmd on Windows", () => {
    if (process.platform !== "win32") return;
    expect(npxCommand()).toBe("npx.cmd");
  });

  it("resolveCliInvocation uses process.execPath + local tsx in dev mode", () => {
    const cwd = process.cwd();
    const invocation = resolveCliInvocation(cwd, path.join(cwd, "src", "server.ts"));
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toMatch(/tsx[\\/]dist[\\/]cli\.mjs$/);
    expect(invocation.args[1]).toBe(path.join(cwd, "src", "cli.ts"));
    expect(invocation.command).not.toMatch(/npx/i);
  });

  it("resolveCliInvocation uses process.execPath + dist cli when server runs from dist", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-spawn-dist-"));
    const distCli = path.join(cwd, "dist", "src", "cli.js");
    fs.mkdirSync(path.dirname(distCli), { recursive: true });
    fs.writeFileSync(distCli, "export {};\n", "utf8");

    const invocation = resolveCliInvocation(cwd, path.join(cwd, "dist", "src", "server.js"));
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([distCli]);
  });

  it("normalizeSpawnInvocation rejects missing cwd", () => {
    expect(() => normalizeSpawnInvocation(process.execPath, ["--version"], path.join(os.tmpdir(), "missing-cwd-dir")))
      .toThrow(/spawn cwd does not exist/);
  });

  it("records spawn command and cwd in job logs when spawn fails synchronously", async () => {
    const runner = {
      start() {
        const error = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
        throw error;
      }
    } satisfies SpawnRunner;
    const app = await makeApp({ runner });
    const response = await fetch(`${app.url}/api/v1/jobs/kz-enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: ["960440000716"], skipStat: true, delayMs: 0 })
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { job: { id: string } };
    const job = await waitForStatus(app, body.job.id, "failed");
    expect(job.error).toMatch(/spawn EINVAL/i);

    const logsResponse = await fetch(`${app.url}/api/v1/jobs/${body.job.id}/logs`);
    const logsBody = await logsResponse.json() as { logs: Array<{ stream: string; line: string }> };
    const lines = logsBody.logs.map((entry) => entry.line).join("\n");
    expect(lines).toMatch(/Spawn error: spawn EINVAL/);
    expect(lines).toMatch(/Spawn command:/);
    expect(lines).toMatch(/Spawn cwd:/);
  });
});

describe("scrape2lead API server — handleStaticStreamError", () => {
  // Minimal stand-in for http.ServerResponse — we only need to verify
  // which of {writeHead, end, destroy} the error handler calls. No real
  // socket or fs involved, so the test isn't brittle.
  function makeMockResponse(initialHeadersSent: boolean) {
    const calls = { writeHead: [] as Array<{ status: number; headers: Record<string, unknown> }>, end: [] as string[], destroyed: 0 };
    const res = {
      headersSent: initialHeadersSent,
      writeHead(status: number, headers: Record<string, unknown>): void {
        calls.writeHead.push({ status, headers });
        this.headersSent = true;
      },
      end(body?: string): void {
        calls.end.push(body ?? "");
      },
      destroy(): void {
        calls.destroyed += 1;
      }
    };
    return { res: res as unknown as import("node:http").ServerResponse, calls };
  }

  function makeMockState(): Parameters<typeof handleStaticStreamError>[1] {
    return {} as Parameters<typeof handleStaticStreamError>[1];
  }

  it("sends JSON 500 with the error message when headers have not been sent", () => {
    const { res, calls } = makeMockResponse(false);
    const err = new Error("disk gone");

    handleStaticStreamError(res, makeMockState(), err);

    expect(calls.writeHead).toHaveLength(1);
    expect(calls.writeHead[0]?.status).toBe(500);
    expect(calls.writeHead[0]?.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(calls.end).toHaveLength(1);
    const body = JSON.parse(calls.end[0] ?? "{}") as { error: string; message: string };
    expect(body.error).toBe("static_read_error");
    expect(body.message).toBe("disk gone");
    expect(calls.destroyed).toBe(0);
  });

  it("destroys the response without writing when headers were already sent", () => {
    const { res, calls } = makeMockResponse(true);
    const err = new Error("truncated mid-stream");

    handleStaticStreamError(res, makeMockState(), err);

    expect(calls.writeHead).toHaveLength(0);
    expect(calls.end).toHaveLength(0);
    expect(calls.destroyed).toBe(1);
  });
});

function cwdOr(app: App): string {
  return app.cwd;
}
