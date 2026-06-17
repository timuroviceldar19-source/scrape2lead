import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJobStore,
  SqliteJobStore,
  type ApiJob,
  type ApiJobArtifact,
  type ApiJobLog,
  type ApiJobStatus,
  type ApiJobType,
  type IJobStore,
  type JobStoreOptions
} from "./storage/apiJobStore.js";

type JobStatus = ApiJobStatus;
type JobType = ApiJobType;

export interface SpawnedProcess {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface SpawnRunner {
  start(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): SpawnedProcess;
}

interface ApiServerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  apiToken?: string;
  maxLogLines?: number;
  maxConcurrentJobs?: number;
  spawnRunner?: SpawnRunner;
  jobStore?: IJobStore;
  jobStoreOptions?: JobStoreOptions;
}

interface ServerState {
  cwd: string;
  env: NodeJS.ProcessEnv;
  apiToken?: string;
  maxLogLines: number;
  maxConcurrentJobs: number;
  jobStore: IJobStore;
  processes: Map<string, SpawnedProcess>;
  spawnRunner: SpawnRunner;
  isDraining: boolean;
  allowLegacyArtifactFallback: boolean;
}

export interface ApiServer extends http.Server {
  jobStore: IJobStore;
}

const JOB_TYPES = new Set<JobType>(["scrape", "kz-enrich", "kz-export", "kz-autopilot"]);
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_MAX_LOG_LINES = 500;
const MAX_LOG_LINES_HARD_CAP = 5000;
const MAX_LOG_TAIL_LINES = 20;

const defaultSpawnRunner: SpawnRunner = {
  start(command, args, options) {
    const normalized = normalizeSpawnInvocation(command, args, options.cwd);
    return spawn(normalized.command, normalized.args, {
      cwd: normalized.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }
};

export function createApiServer(options: ApiServerOptions = {}): ApiServer {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = { ...process.env, ...(options.env ?? {}) };
  const apiToken = options.apiToken ?? env.SCRAPE2LEAD_API_TOKEN;
  const maxLogLines = normalizeMaxLogLines(
    options.maxLogLines ?? parsePositiveIntEnv(env.SCRAPE2LEAD_MAX_LOG_LINES) ?? DEFAULT_MAX_LOG_LINES
  );
  const maxConcurrentJobs = Math.max(1, (options.maxConcurrentJobs ?? Number(env.SCRAPE2LEAD_MAX_CONCURRENT_JOBS)) || 1);

  const jobStore = options.jobStore ?? createDefaultJobStore(cwd, options.jobStoreOptions);

  const state: ServerState = {
    cwd,
    env,
    apiToken,
    maxLogLines,
    maxConcurrentJobs,
    jobStore,
    processes: new Map(),
    spawnRunner: options.spawnRunner ?? defaultSpawnRunner,
    isDraining: false,
    allowLegacyArtifactFallback: parseBoolEnv(env.SCRAPE2LEAD_ARTIFACT_LEGACY_FALLBACK) === true
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, state).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
        return;
      }
      sendJson(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }) as ApiServer;

  server.jobStore = jobStore;

  // Recover any jobs that were running when the previous process died, then
  // drain the queue so queued jobs can start if slots are available.
  // Retention pruning runs immediately after `resetRunningJobs()` so a fresh
  // boot never starts work on jobs that are about to be deleted.
  const retentionDays = parseRetentionDays(env.SCRAPE2LEAD_JOB_RETENTION_DAYS);
  void Promise.resolve()
    .then(() => jobStore.resetRunningJobs())
    .then(async () => {
      if (retentionDays === null) return;
      const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const cutoffIso = new Date(cutoffMs).toISOString();
      const pruned = await jobStore.pruneTerminalJobsBefore(cutoffIso);
      console.log(`Pruned ${pruned} terminal API jobs older than ${retentionDays} days`);
    })
    .then(() => drainQueue(state))
    .catch((error) => {
      console.error("Failed to initialize job queue:", error);
    });

  return server;
}

function createDefaultJobStore(cwd: string, options?: JobStoreOptions): IJobStore {
  const databasePath = options?.databasePath ?? process.env.SCRAPE2LEAD_DATABASE_PATH ?? path.join(cwd, "data", "scrape2lead.db");
  if (options?.sqliteDb) {
    return new SqliteJobStore(options.sqliteDb);
  }
  return new SqliteJobStore(databasePath);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, state: ServerState): Promise<void> {
  applyCors(req, res, state);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Operator UI: static files served from public/operator/. Exposed before the
  // auth gate so the operator can open the dashboard, paste a token, and
  // start calling the API. The static handler is path-traversal-safe and
  // reads only from the operator folder. HEAD is supported alongside GET so
  // monitoring tools, link rel=preload, and HTTP probes get the same
  // response headers (CSP, security headers, Cache-Control, Content-Length,
  // Content-Type) without a body.
  if ((req.method === "GET" || req.method === "HEAD") && isOperatorRequest(url)) {
    serveOperatorStatic(res, state, req.method ?? "GET", req.headers["if-none-match"], req.url);
    return;
  }

  if (!isAuthorized(req, state)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    await handleHealth(res, state);
    return;
  }

  if (segments[0] === "api") {
    const version = segments[1];
    const isV1 = version === "v1";
    const baseIndex = isV1 ? 2 : 1;
    if (segments[baseIndex] === "jobs") {
      await handleJobsRoute(req, res, state, segments.slice(baseIndex));
      return;
    }
    if (segments[baseIndex] === "artifacts") {
      await handleArtifactsRoute(req, res, state, segments.slice(baseIndex));
      return;
    }
  }

  sendJson(res, 404, { error: "not_found" });
}

interface LastAutopilotRun {
  id: string;
  status: ApiJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  artifacts: string[];
}

async function handleHealth(res: ServerResponse, state: ServerState): Promise<void> {
  const payload: {
    ok: boolean;
    service: string;
    time: string;
    uptimeSeconds: number;
    lastAutopilotRun: LastAutopilotRun | null;
    jobStore: { ok: true } | { ok: false; error: string };
  } = {
    ok: true,
    service: "scrape2lead-api",
    time: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    lastAutopilotRun: null,
    jobStore: { ok: true }
  };
  try {
    const latest = await state.jobStore.getLatestJobByType("kz-autopilot");
    if (latest) {
      payload.lastAutopilotRun = {
        id: latest.id,
        status: latest.status,
        createdAt: latest.created_at,
        startedAt: latest.started_at,
        finishedAt: latest.finished_at,
        exitCode: latest.exit_code,
        error: latest.error,
        artifacts: latest.artifacts
      };
    }
  } catch (error) {
    payload.jobStore = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  sendJson(res, 200, payload, state);
}

async function handleJobsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  segments: string[]
): Promise<void> {
  if (req.method === "GET" && segments.length === 1) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const filter = {
      status: parseJobStatus(url.searchParams.get("status")),
      limit: parsePositiveInt(url.searchParams.get("limit")),
      offset: parseNonNegativeInt(url.searchParams.get("offset"))
    };
    const result = await state.jobStore.listJobs(filter);
    const jobs = await Promise.all(result.jobs.map((job) => publicJob(state.jobStore, job, false, { tailLimit: MAX_LOG_TAIL_LINES })));
    sendJson(res, 200, { jobs, total: result.total }, state);
    return;
  }

  if (req.method === "GET" && segments.length === 2) {
    const job = await state.jobStore.getJob(segments[1] ?? "");
    if (!job) {
      sendJson(res, 404, { error: "job_not_found" }, state);
      return;
    }
    const detailLogLimit = parseLogLimitFromUrl(req.url, state.maxLogLines);
    sendJson(res, 200, { job: await publicJob(state.jobStore, job, true, { logLimit: detailLogLimit }) }, state);
    return;
  }

  if (req.method === "GET" && segments.length === 3 && segments[2] === "logs") {
    const job = await state.jobStore.getJob(segments[1] ?? "");
    if (!job) {
      sendJson(res, 404, { error: "job_not_found" }, state);
      return;
    }
    const allLogs = await state.jobStore.getLogs(job.id);
    const { limit, offset } = parseLogRangeFromUrl(req.url, state.maxLogLines);
    const logs = limitLogs(allLogs, limit, offset);
    sendJson(res, 200, {
      jobId: job.id,
      logs,
      total: allLogs.length,
      limit,
      offset,
      maxLogLines: state.maxLogLines
    }, state);
    return;
  }

  if (req.method === "GET" && segments.length === 3 && segments[2] === "artifacts") {
    const job = await state.jobStore.getJob(segments[1] ?? "");
    if (!job) {
      sendJson(res, 404, { error: "job_not_found" }, state);
      return;
    }
    const artifacts = await state.jobStore.listArtifacts(job.id);
    sendJson(res, 200, { jobId: job.id, artifacts: publicArtifacts(artifacts) }, state);
    return;
  }

  if (req.method === "GET" && segments.length === 4 && segments[2] === "artifacts") {
    const job = await state.jobStore.getJob(segments[1] ?? "");
    if (!job) {
      sendJson(res, 404, { error: "job_not_found" }, state);
      return;
    }
    const name = decodeURIComponent(segments[3] ?? "");
    if (!isSafeArtifactName(name)) {
      sendJson(res, 400, { error: "invalid_artifact_name" }, state);
      return;
    }
    const artifacts = await state.jobStore.listArtifacts(job.id);
    const match = artifacts.find((a) => a.name === name);
    if (!match) {
      sendJson(res, 404, { error: "artifact_not_found" }, state);
      return;
    }
    serveArtifact(res, state, match);
    return;
  }

  if (req.method === "POST" && segments.length === 3 && segments[2] === "cancel") {
    const job = await state.jobStore.getJob(segments[1] ?? "");
    if (!job) {
      sendJson(res, 404, { error: "job_not_found" }, state);
      return;
    }

    if (job.status === "cancelled" || job.status === "completed" || job.status === "failed" || job.status === "interrupted") {
      sendJson(res, 409, { error: "job_not_cancellable", job: await publicJob(state.jobStore, job, true, { logLimit: state.maxLogLines }) }, state);
      return;
    }

    if (job.status === "running") {
      const processRef = state.processes.get(job.id);
      if (processRef) {
        await state.jobStore.appendLog(job.id, "system", "Cancellation requested");
        await state.jobStore.cancelJob(job.id);
        processRef.kill("SIGTERM");
      } else {
        // The process is already gone; finish it immediately so the slot frees up.
        await state.jobStore.finishJob(job.id, "cancelled", null, null, "cancelled by operator");
        void drainQueue(state);
      }
    } else {
      await state.jobStore.cancelJob(job.id);
      void drainQueue(state);
    }

    const updated = await state.jobStore.getJob(job.id);
    sendJson(res, 200, { job: await publicJob(state.jobStore, updated ?? job, true, { logLimit: state.maxLogLines }) }, state);
    return;
  }

  if (req.method === "POST" && segments.length === 2 && JOB_TYPES.has(segments[1] as JobType)) {
    const body = await readJsonBody(req);
    const job = await startJob(segments[1] as JobType, body, state);
    sendJson(res, 202, { job: await publicJob(state.jobStore, job, true, { logLimit: state.maxLogLines }) }, state);
    return;
  }

  sendJson(res, 404, { error: "not_found" }, state);
}

async function handleArtifactsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  segments: string[]
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 404, { error: "not_found" }, state);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const includeLegacy = url.searchParams.get("legacy") === "1"
    || url.searchParams.get("legacy") === "true"
    || state.allowLegacyArtifactFallback;

  if (segments.length === 1) {
    const persisted = await state.jobStore.listArtifacts();
    const artifacts = includeLegacy
      ? mergeArtifactsWithLegacy(publicArtifacts(persisted), listExportDirArtifacts(state))
      : publicArtifacts(persisted);
    sendJson(res, 200, { artifacts, source: includeLegacy ? "jobStore+exports" : "jobStore" }, state);
    return;
  }

  if (segments.length === 2) {
    const rawId = segments[1] ?? "";
    if (!/^\d+$/.test(rawId)) {
      // Legacy fallback: only when explicitly enabled. We still refuse path-like
      // inputs and resolve strictly inside the export directory.
      if (includeLegacy) {
        const name = decodeURIComponent(rawId);
        if (isSafeArtifactName(name)) {
          const exportPath = path.resolve(getExportDir(state), name);
          const exportDir = path.resolve(getExportDir(state));
          if (exportPath.startsWith(`${exportDir}${path.sep}`) && fs.existsSync(exportPath) && fs.statSync(exportPath).isFile()) {
            serveArtifactFile(res, exportPath);
            return;
          }
        }
      }
      sendJson(res, 404, { error: "artifact_not_found" }, state);
      return;
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1) {
      sendJson(res, 404, { error: "artifact_not_found" }, state);
      return;
    }
    const artifact = await state.jobStore.getArtifact(id);
    if (!artifact) {
      sendJson(res, 404, { error: "artifact_not_found" }, state);
      return;
    }
    serveArtifact(res, state, artifact);
    return;
  }

  sendJson(res, 404, { error: "not_found" }, state);
}

async function startJob(type: JobType, body: unknown, state: ServerState): Promise<ApiJob> {
  const id = randomUUID();
  const invocation = buildJobInvocation(type, body, id, state.cwd, state.env);
  await state.jobStore.createJob({
    id,
    type,
    command: invocation.command,
    args: invocation.args,
    request: asRecord(body),
    cwd: state.cwd
  });
  await state.jobStore.appendLog(id, "system", `Queued: ${invocation.command} ${invocation.args.join(" ")}`);
  const job = await state.jobStore.getJob(id);
  if (!job) throw new HttpError(500, "internal_error", "Failed to create job");
  void drainQueue(state);
  return job;
}

async function drainQueue(state: ServerState): Promise<void> {
  if (state.isDraining) return;
  state.isDraining = true;
  try {
    while (true) {
      const runningCount = await state.jobStore.countRunningJobs();
      if (runningCount >= state.maxConcurrentJobs) break;
      const job = await state.jobStore.claimNextQueuedJob();
      if (!job) break;
      await runClaimedJob(state, job);
    }
  } finally {
    state.isDraining = false;
  }
}

async function runClaimedJob(state: ServerState, job: ApiJob): Promise<void> {
  await state.jobStore.appendLog(job.id, "system", `Starting: ${job.command} ${job.args.join(" ")}`);

  let child: SpawnedProcess;
  try {
    child = state.spawnRunner.start(job.command, job.args, {
      cwd: state.cwd,
      env: state.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await state.jobStore.finishJob(job.id, "failed", null, null, `Spawn error: ${message}`);
    await appendSpawnFailureLogs(state, job, message);
    return;
  }

  attachLogStream(state, job.id, child.stdout, "stdout");
  attachLogStream(state, job.id, child.stderr, "stderr");

  if (child.pid !== undefined) {
    state.processes.set(job.id, child);
    void state.jobStore.setJobPid(job.id, child.pid);
  }

  child.on("error", async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const current = await state.jobStore.getJob(job.id);
    if (current?.status === "running") {
      await state.jobStore.finishJob(job.id, "failed", null, null, message);
    }
    await state.jobStore.appendLog(job.id, "system", `Process error: ${message}`);
    await appendSpawnDiagnostics(state, job);
    await saveJobArtifacts(state, job.id);
    state.processes.delete(job.id);
    void drainQueue(state);
  });

  child.on("exit", async (code, signal) => {
    const current = await state.jobStore.getJob(job.id);
    if (current?.status === "running") {
      const finalStatus = code === 0 ? "completed" : "failed";
      await state.jobStore.finishJob(job.id, finalStatus, code, signal);
    }
    await state.jobStore.appendLog(job.id, "system", `Finished with code=${code ?? "null"} signal=${signal ?? "null"}`);
    await saveJobArtifacts(state, job.id);
    state.processes.delete(job.id);
    void drainQueue(state);
  });
}

async function saveJobArtifacts(state: ServerState, jobId: string): Promise<void> {
  const job = await state.jobStore.getJob(jobId);
  const startedAt = job?.started_at ? new Date(job.started_at) : undefined;
  const artifacts = listExportDirArtifacts(state, startedAt);
  if (artifacts.length === 0) return;
  await state.jobStore.saveArtifacts(
    jobId,
    artifacts.map((a) => ({
      name: a.name,
      path: path.resolve(getExportDir(state), a.name),
      size: a.size,
      mtime: a.mtime
    }))
  );
}

function attachLogStream(
  state: ServerState,
  jobId: string,
  stream: NodeJS.ReadableStream | null | undefined,
  kind: "stdout" | "stderr"
): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      void state.jobStore.appendLog(jobId, kind, line);
    }
  });
  stream.on("end", () => {
    if (buffer) {
      void state.jobStore.appendLog(jobId, kind, buffer);
    }
  });
}

interface PublicJobOptions {
  /** Cap on full log lines returned when includeLogs is true. */
  logLimit?: number;
  /** Cap on tail length when includeLogs is false (default MAX_LOG_TAIL_LINES). */
  tailLimit?: number;
}

async function publicJob(
  jobStore: IJobStore,
  job: ApiJob,
  includeLogs: boolean,
  options: PublicJobOptions = {}
): Promise<Omit<ApiJob, "request"> & { logs?: ApiJobLog[]; logTail?: ApiJobLog[] }> {
  const allLogs = await jobStore.getLogs(job.id);
  let logs: ApiJobLog[];
  if (includeLogs) {
    const limit = Math.max(0, options.logLimit ?? DEFAULT_MAX_LOG_LINES);
    logs = limitLogs(allLogs, limit, 0);
  } else {
    const limit = Math.max(0, options.tailLimit ?? MAX_LOG_TAIL_LINES);
    logs = allLogs.length > limit ? allLogs.slice(allLogs.length - limit) : allLogs.slice();
  }
  const { request: _request, ...rest } = job;
  void _request;
  const result: Omit<ApiJob, "request"> & { logs?: ApiJobLog[]; logTail?: ApiJobLog[] } = { ...rest };
  if (includeLogs) {
    result.logs = logs;
  } else {
    result.logTail = logs;
  }
  return result;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function resolveExportDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return path.resolve(cwd, env.SCRAPE2LEAD_EXPORT_DIR ?? "exports");
}

function getExportDir(state: ServerState): string {
  return resolveExportDir(state.cwd, state.env);
}

function listExportDirArtifacts(
  state: ServerState,
  modifiedSince?: Date
): Array<{ name: string; size: number; mtime: string }> {
  const exportDir = getExportDir(state);
  if (!fs.existsSync(exportDir)) return [];
  return fs.readdirSync(exportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => isSafeArtifactName(entry.name))
    .map((entry) => {
      const filePath = path.join(exportDir, entry.name);
      const stat = fs.statSync(filePath);
      return { name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .filter((entry) => !modifiedSince || new Date(entry.mtime) >= modifiedSince)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function isSafeArtifactName(name: string): boolean {
  if (!name) return false;
  if (name.length > 255) return false;
  if (name !== path.basename(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  if (/^[A-Za-z]:/.test(name)) return false; // Windows drive letter
  return true;
}

function publicArtifacts(artifacts: ApiJobArtifact[]): Array<{
  id: number;
  jobId: string;
  name: string;
  size: number;
  mtime: string;
}> {
  return artifacts.map((a) => ({
    id: a.id,
    jobId: a.job_id,
    name: a.name,
    size: a.size,
    mtime: a.mtime
  }));
}

function mergeArtifactsWithLegacy(
  persisted: ReturnType<typeof publicArtifacts>,
  legacy: Array<{ name: string; size: number; mtime: string }>
): ReturnType<typeof publicArtifacts> {
  const persistedNames = new Set(persisted.map((a) => a.name));
  const merged: ReturnType<typeof publicArtifacts> = persisted.slice();
  for (const entry of legacy) {
    if (persistedNames.has(entry.name)) continue;
    merged.push({ id: -1, jobId: "legacy-exports", name: entry.name, size: entry.size, mtime: entry.mtime });
  }
  return merged;
}

function serveArtifact(res: ServerResponse, state: ServerState, artifact: ApiJobArtifact): void {
  if (!isSafeArtifactName(artifact.name)) {
    sendJson(res, 400, { error: "invalid_artifact_name" }, state);
    return;
  }
  const exportDir = getExportDir(state);
  const exportPath = path.resolve(exportDir, artifact.name);
  if (!exportPath.startsWith(`${exportDir}${path.sep}`)) {
    sendJson(res, 400, { error: "invalid_artifact_path" }, state);
    return;
  }
  if (!fs.existsSync(exportPath) || !fs.statSync(exportPath).isFile()) {
    sendJson(res, 410, { error: "artifact_file_missing" }, state);
    return;
  }
  serveArtifactFile(res, exportPath);
}

function serveArtifactFile(res: ServerResponse, exportPath: string): void {
  const stat = fs.statSync(exportPath);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(exportPath),
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${path.basename(exportPath).replaceAll("\"", "")}"`
  });
  fs.createReadStream(exportPath).pipe(res);
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".csv") return "text/csv; charset=utf-8";
  if (ext === ".json" || ext === ".map") return "application/json; charset=utf-8";
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".txt" || ext === ".log") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function isOperatorRequest(url: URL): boolean {
  return url.pathname === "/operator"
    || url.pathname === "/operator/"
    || url.pathname.startsWith("/operator/");
}

function serveOperatorStatic(
  res: ServerResponse,
  state: ServerState,
  method: string,
  ifNoneMatch: string | string[] | undefined,
  rawUrl: string | undefined
): void {
  const operatorDir = path.resolve(state.cwd, "public", "operator");
  // The URL parser normalizes `..` segments away, which is great for routing
  // but means encoded `..` (e.g. `%2e%2e`) and double-encoded variants can
  // slip past it. We pull the raw request URL and apply path-traversal
  // checks against the literal segments before any fs resolution.
  const rawPath = (rawUrl ?? "/").split("?")[0]?.split("#")[0] ?? "/";
  if (rawPath !== "/operator" && rawPath !== "/operator/" && !rawPath.startsWith("/operator/")) {
    sendJson(res, 404, { error: "not_found" }, state);
    return;
  }
  const tail = rawPath === "/operator" || rawPath === "/operator/"
    ? ""
    : rawPath.slice("/operator/".length);
  const segments = tail.split("/").filter(Boolean);

  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
    if (decoded === "." || decoded === "..") {
      sendJson(res, 400, { error: "invalid_path" }, state);
      return;
    }
    if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      sendJson(res, 400, { error: "invalid_path" }, state);
      return;
    }
    if (/^[A-Za-z]:/.test(decoded)) {
      sendJson(res, 400, { error: "invalid_path" }, state);
      return;
    }
  }

  let filePath = segments.length === 0
    ? path.join(operatorDir, "index.html")
    : path.resolve(operatorDir, segments.join(path.sep));

  if (filePath !== operatorDir && !filePath.startsWith(operatorDir + path.sep)) {
    sendJson(res, 400, { error: "invalid_path" }, state);
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { error: "not_found" }, state);
    return;
  }
  if (stat.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    try {
      stat = fs.statSync(filePath);
    } catch {
      sendJson(res, 404, { error: "not_found" }, state);
      return;
    }
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: "not_found" }, state);
    return;
  }

  // Strong validator built from size + mtime. Math.trunc on mtimeMs keeps
  // the ETag integer-only so two requests against an unchanged file produce
  // byte-identical tags.
  const etag = `"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
  const lastModified = stat.mtime.toUTCString();

  const baseHeaders: Record<string, string | number> = {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "ETag": etag,
    "Last-Modified": lastModified
  };

  // If-None-Match: list of candidate tags. Treat as a match when any item
  // equals our current ETag. No wildcard `*` (we never need it for a
  // single-file static UI and it adds ambiguity for a 404 path we don't
  // want to cache anyway).
  if (ifNoneMatch !== undefined) {
    const candidates = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch];
    if (candidates.some((c) => c === etag)) {
      res.writeHead(304, baseHeaders);
      res.end();
      return;
    }
  }

  res.writeHead(200, { ...baseHeaders, "Content-Length": stat.size });
  // HEAD shares the same headers as GET (Content-Length still reports the
  // would-be body size, per RFC 9110 §9.3.2) but must not include a body.
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => handleStaticStreamError(res, state, err));
  stream.pipe(res);
}

/**
 * Handle an error from a static-asset read stream. Exported for unit tests:
 * if headers have not been flushed yet we send a JSON 500; if they have
 * (the body was already partially written) we destroy the response so the
 * client sees a truncated response and the connection is closed cleanly.
 */
export function handleStaticStreamError(
  res: ServerResponse,
  state: ServerState,
  err: Error
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, 500, { error: "static_read_error", message: err.message }, state);
}

function sendJson(res: ServerResponse, status: number, payload: unknown, _state?: ServerState): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function applyCors(req: IncomingMessage, res: ServerResponse, state: ServerState): void {
  const origin = state.env.SCRAPE2LEAD_CORS_ORIGIN ?? "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
  void req;
}

function isAuthorized(req: IncomingMessage, state: ServerState): boolean {
  if (!state.apiToken) return true;
  const authorization = req.headers.authorization;
  if (authorization === `Bearer ${state.apiToken}`) return true;
  return req.headers["x-api-token"] === state.apiToken;
}

function parseJobStatus(value: string | null): JobStatus | undefined {
  if (!value) return undefined;
  const status = value as JobStatus;
  if (JOB_STATUSES.has(status)) return status;
  return undefined;
}

const JOB_STATUSES = new Set<JobStatus>(["queued", "running", "completed", "failed", "cancelled", "interrupted"]);

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

function parseNonNegativeInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function parsePositiveIntEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

/**
 * Parse `SCRAPE2LEAD_JOB_RETENTION_DAYS` into a positive integer (>= 1) or
 * `null` when retention is disabled. Disabled covers: unset env, empty
 * string, `0`, non-numeric input, negative numbers, and floats.
 */
function parseRetentionDays(value: string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function parseBoolEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeMaxLogLines(value: number | undefined): number {
  if (!value || !Number.isInteger(value) || value < 1) return DEFAULT_MAX_LOG_LINES;
  return Math.min(value, MAX_LOG_LINES_HARD_CAP);
}

function clampLogLimit(requested: number, ceiling: number): number {
  const safeCeiling = Math.min(Math.max(1, ceiling), MAX_LOG_LINES_HARD_CAP);
  const safeRequested = Math.max(1, requested);
  return Math.min(safeRequested, safeCeiling);
}

function limitLogs<T>(logs: T[], limit: number, offset: number): T[] {
  if (logs.length === 0) return [];
  if (!Number.isInteger(limit) || limit <= 0) return [];
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (offset >= logs.length) return [];
  return logs.slice(offset, offset + limit);
}

function parseLogRangeFromUrl(
  rawUrl: string | undefined,
  defaultLimit: number
): { limit: number; offset: number } {
  const url = new URL(rawUrl ?? "/", "http://localhost");
  const limitRaw = parsePositiveInt(url.searchParams.get("limit"));
  const limit = clampLogLimit(limitRaw ?? defaultLimit, defaultLimit);
  const offset = parseNonNegativeInt(url.searchParams.get("offset")) ?? 0;
  return { limit, offset };
}

function parseLogLimitFromUrl(rawUrl: string | undefined, defaultLimit: number): number {
  const url = new URL(rawUrl ?? "/", "http://localhost");
  const requested = parsePositiveInt(url.searchParams.get("logLimit")) ?? defaultLimit;
  return clampLogLimit(requested, defaultLimit);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function buildJobInvocation(
  type: JobType,
  body: unknown,
  jobId: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): { command: string; args: string[] } {
  const input = asRecord(body);
  switch (type) {
    case "scrape":
      return buildScrapeInvocation(input, cwd);
    case "kz-enrich":
      return buildKzEnrichInvocation(input, jobId, cwd);
    case "kz-export":
      return buildKzExportInvocation(input, jobId, cwd, env);
    case "kz-autopilot":
      return buildKzAutopilotInvocation(input, cwd);
  }
}

function buildScrapeInvocation(input: Record<string, unknown>, cwd: string): { command: string; args: string[] } {
  const invocation = cliInvocation(cwd);
  const args = [...invocation.args];
  pushStringFlag(args, "--config", input.configPath);
  pushStringFlag(args, "--source", input.source);
  pushStringFlag(args, "--geo", input.geo);
  pushStringFlag(args, "--category", input.category);
  pushPositiveIntFlag(args, "--limit", input.limit);
  if (input.headless === true) args.push("--headless");
  if (input.headed === true) args.push("--headed");
  pushStringFlag(args, "--fixture", input.fixture);
  return { command: invocation.command, args };
}

function buildKzEnrichInvocation(
  input: Record<string, unknown>,
  jobId: string,
  cwd: string
): { command: string; args: string[] } {
  const csvFile = resolveCsvInput(input, jobId, cwd, "enrich");
  const invocation = cliInvocation(cwd);
  const args = [...invocation.args, "kz", "enrich", csvFile];

  pushBooleanFlag(args, "--skip-stat", input.skipStat);
  pushBooleanFlag(args, "--skip-tenders", input.skipTenders);
  pushBooleanFlag(args, "--skip-zakup", input.skipZakup);
  pushBooleanFlag(args, "--skip-goszakup-registry", input.skipGoszakupRegistry);
  pushBooleanFlag(args, "--skip-goszakup-html", input.skipGoszakupHtml);
  pushBooleanFlag(args, "--registry-only", input.registryOnly);
  pushBooleanFlag(args, "--force-refresh", input.forceRefresh);
  pushBooleanFlag(args, "--goszakup-active-only", input.goszakupActiveOnly);
  pushNonNegativeIntFlag(args, "--delay-ms", input.delayMs);
  pushPositiveIntFlag(args, "--goszakup-max-pages", input.goszakupMaxPages);
  pushPositiveIntFlag(args, "--zakup-max-retries", input.zakupMaxRetries);

  return { command: invocation.command, args };
}

function resolveKzExportOutPath(explicitOut: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const exportDir = path.resolve(resolveExportDir(cwd, env));
  const basename = path.basename(explicitOut);
  if (!isSafeArtifactName(basename)) {
    throw new HttpError(400, "invalid_out", "Export `out` must resolve to a safe filename.");
  }
  if (path.isAbsolute(explicitOut)) {
    const absolute = path.resolve(explicitOut);
    if (!absolute.startsWith(`${exportDir}${path.sep}`)) {
      throw new HttpError(400, "invalid_out", "Export `out` must be inside SCRAPE2LEAD_EXPORT_DIR.");
    }
    return absolute;
  }
  return path.join(exportDir, basename);
}

function buildKzExportInvocation(
  input: Record<string, unknown>,
  jobId: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): { command: string; args: string[] } {
  const invocation = cliInvocation(cwd);
  const args = [...invocation.args, "kz", "export"];
  const csvFile = hasBinsInput(input) ? resolveCsvInput(input, jobId, cwd, "export") : undefined;
  pushStringFlag(args, "--bins", csvFile);
  const explicitOut = optionalString(input.out);
  const outPath = explicitOut
    ? resolveKzExportOutPath(explicitOut, cwd, env)
    : path.join(resolveExportDir(cwd, env), `kz-${jobId}.xlsx`);
  pushStringFlag(args, "--out", outPath);
  pushStringFlag(args, "--format", input.format ?? "xlsx");
  return { command: invocation.command, args };
}

function buildKzAutopilotInvocation(input: Record<string, unknown>, cwd: string): { command: string; args: string[] } {
  const invocation = tsxScriptInvocation(cwd, "scripts/kz-autopilot.mts");
  const args = [...invocation.args];
  pushStringFlag(args, "--batch-csv", input.batchCsv);
  pushStringFlag(args, "--top-a-csv", input.topACsv);
  pushStringFlag(args, "--out-dir", input.outDir);
  pushBooleanFlag(args, "--dry-run", input.dryRun);
  pushStringFlag(args, "--since", input.since);
  pushBooleanFlag(args, "--skip-enrich", input.skipEnrich);
  pushBooleanFlag(args, "--progress", input.progress);
  pushPositiveIntFlag(args, "--max-pages", input.maxPages);
  pushBooleanFlag(args, "--baseline", input.baseline);
  return { command: invocation.command, args };
}

export function resolveCliInvocation(
  cwd: string,
  serverModulePath: string = fileURLToPath(import.meta.url)
): { command: string; args: string[] } {
  const distCli = path.join(cwd, "dist", "src", "cli.js");
  if (isRunningFromDist(serverModulePath) && fs.existsSync(distCli)) {
    return { command: process.execPath, args: [distCli] };
  }
  return devCliInvocation(cwd);
}

function cliInvocation(cwd: string): { command: string; args: string[] } {
  return resolveCliInvocation(cwd);
}

function devCliInvocation(cwd: string): { command: string; args: string[] } {
  const tsxCli = localTsxCliPath(cwd);
  if (fs.existsSync(tsxCli)) {
    return { command: process.execPath, args: [tsxCli, path.join(cwd, "src", "cli.ts")] };
  }
  return { command: npxCommand(), args: ["tsx", "src/cli.ts"] };
}

export function tsxScriptInvocation(cwd: string, scriptPath: string): { command: string; args: string[] } {
  const tsxCli = localTsxCliPath(cwd);
  const script = path.isAbsolute(scriptPath) ? scriptPath : path.join(cwd, scriptPath);
  if (fs.existsSync(tsxCli)) {
    return { command: process.execPath, args: [tsxCli, script] };
  }
  return { command: npxCommand(), args: ["tsx", scriptPath] };
}

function isRunningFromDist(serverModulePath: string): boolean {
  return serverModulePath.replace(/\\/g, "/").includes("/dist/");
}

function localTsxCliPath(cwd: string): string {
  return path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs");
}

export function normalizeSpawnInvocation(
  command: string,
  args: string[],
  cwd: string
): { command: string; args: string[]; cwd: string } {
  const normalizedCommand = String(command ?? "").trim();
  if (!normalizedCommand) {
    throw new Error("spawn command is empty");
  }
  const normalizedArgs = args
    .filter((arg) => arg !== undefined && arg !== null)
    .map((arg) => String(arg));
  const normalizedCwd = path.resolve(cwd);
  if (!fs.existsSync(normalizedCwd)) {
    throw new Error(`spawn cwd does not exist: ${normalizedCwd}`);
  }
  return { command: normalizedCommand, args: normalizedArgs, cwd: normalizedCwd };
}

async function appendSpawnFailureLogs(state: ServerState, job: ApiJob, message: string): Promise<void> {
  await state.jobStore.appendLog(job.id, "system", `Spawn error: ${message}`);
  await appendSpawnDiagnostics(state, job);
}

async function appendSpawnDiagnostics(state: ServerState, job: ApiJob): Promise<void> {
  await state.jobStore.appendLog(job.id, "system", `Spawn command: ${job.command}`);
  await state.jobStore.appendLog(job.id, "system", `Spawn cwd: ${job.cwd}`);
  if (job.args.length > 0) {
    await state.jobStore.appendLog(job.id, "system", `Spawn args: ${job.args.join(" ")}`);
  }
}

function resolveCsvInput(
  input: Record<string, unknown>,
  jobId: string,
  cwd: string,
  suffix: string
): string {
  const csvFile = optionalString(input.csvFile ?? input.binsCsv);
  if (csvFile) return csvFile;

  const bins = parseBins(input.bins);
  if (bins.length === 0) {
    throw new HttpError(400, "missing_bins", "Provide `csvFile` or a non-empty `bins` array.");
  }

  const outDir = path.join(cwd, "data", "server-jobs");
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, `${jobId}-${suffix}-bins.csv`);
  fs.writeFileSync(csvPath, `bin\n${bins.join("\n")}\n`, "utf8");
  return csvPath;
}

function hasBinsInput(input: Record<string, unknown>): boolean {
  return Boolean(optionalString(input.csvFile ?? input.binsCsv)) || parseBins(input.bins).length > 0;
}

function parseBins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item).trim())
    .filter((item) => /^\d{12}$/.test(item)))];
}

function pushStringFlag(args: string[], flag: string, value: unknown): void {
  const parsed = optionalString(value);
  if (parsed) args.push(flag, parsed);
}

function pushPositiveIntFlag(args: string[], flag: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, "invalid_number", `${flag} must be an integer >= 1.`);
  }
  args.push(flag, String(parsed));
}

function pushNonNegativeIntFlag(args: string[], flag: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, "invalid_number", `${flag} must be an integer >= 0.`);
  }
  args.push(flag, String(parsed));
}

function pushBooleanFlag(args: string[], flag: string, value: unknown): void {
  if (value === true) args.push(flag);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 500) {
    throw new HttpError(400, "invalid_string", "String parameters must be 500 characters or shorter.");
  }
  return trimmed;
}

export function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * Validate that a non-localhost bind is protected by an API token.
 * Throws {@link HttpError} when the bind is unsafe.
 */
export function validateRemoteBind(host: string, apiToken: string | undefined): void {
  const normalized = host.toLowerCase().trim();
  const isLocal =
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1";
  if (!isLocal && !apiToken) {
    throw new HttpError(
      500,
      "unsafe_bind_requires_token",
      `Binding to ${host} requires SCRAPE2LEAD_API_TOKEN to be set.`
    );
  }
}

export interface SafeListenOptions {
  port: number;
  host: string;
  apiToken?: string;
  /** When `port` is `0` and the kernel assigns a port, that port is reported. */
  onListening?: (info: { port: number; address: string }) => void;
}

/**
 * Library-safe `server.listen` wrapper. Validates the bind host against
 * {@link validateRemoteBind} before delegating to Node so library callers
 * cannot accidentally expose the API to remote networks without a token.
 */
export function safeListen(server: http.Server, options: SafeListenOptions): Promise<{ port: number; address: string }> {
  validateRemoteBind(options.host, options.apiToken);
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Expected TCP server address"));
        return;
      }
      const info = { port: addr.port, address: addr.address };
      if (options.onListening) options.onListening(info);
      resolve(info);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const port = Number(process.env.PORT ?? process.env.SCRAPE2LEAD_PORT ?? DEFAULT_PORT);
  const host = process.env.SCRAPE2LEAD_HOST ?? "127.0.0.1";
  const apiToken = process.env.SCRAPE2LEAD_API_TOKEN;

  const maxConcurrentJobs = Number(process.env.SCRAPE2LEAD_MAX_CONCURRENT_JOBS) || 1;
  const postgresConnectionString = process.env.POSTGRES_CONNECTION_STRING;
  const databasePath = process.env.SCRAPE2LEAD_DATABASE_PATH;

  const jobStorePromise = postgresConnectionString
    ? createJobStore({ postgresConnectionString })
    : createJobStore({ databasePath });

  void jobStorePromise.then(async (jobStore) => {
    const server = createApiServer({ apiToken, maxConcurrentJobs, jobStore });
    try {
      const { port: actualPort } = await safeListen(server, { port, host, apiToken });
      console.log(`scrape2lead api listening on http://${host}:${actualPort}`);
    } catch (error) {
      console.error("Failed to start API server:", error);
      process.exit(1);
    }
  }).catch((error) => {
    console.error("Failed to start API server:", error);
    process.exit(1);
  });
}
