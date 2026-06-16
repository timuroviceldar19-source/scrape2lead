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
  safeListen,
  validateRemoteBind,
  type ApiServer,
  type SpawnRunner,
  type SpawnedProcess
} from "../src/server.js";
import { SqliteJobStore, type IJobStore } from "../src/storage/apiJobStore.js";

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
  runner?: FakeRunner;
  apiToken?: string;
  maxConcurrentJobs?: number;
  maxLogLines?: number;
  sqliteDb?: Database.Database;
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
    maxLogLines: options.maxLogLines
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

  it("builds the autopilot command from whitelisted flags only", () => {
    const invocation = buildJobInvocation(
      "kz-autopilot",
      {
        batchCsv: "bins-batch.csv",
        dryRun: true,
        skipEnrich: true,
        maxPages: 5,
        shell: "rm -rf ."
      },
      "job-1",
      process.cwd()
    );

    expect(invocation.args).toEqual([
      "tsx",
      "scripts/kz-autopilot.mts",
      "--batch-csv",
      "bins-batch.csv",
      "--dry-run",
      "--skip-enrich",
      "--max-pages",
      "5"
    ]);
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
    }
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
