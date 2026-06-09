/**
 * Storage abstraction tests.
 *
 * Goal: prove that runtime/core modules depend on the narrow `IStorage`
 * contract, not on the concrete SQLite `Storage` class. A focused fake
 * implementation in this file exercises the same code paths the
 * SQLite-backed `Storage` does, without spinning up `better-sqlite3`.
 *
 * What is covered:
 *  - `JobManager` end-to-end against an in-memory `IStorage`
 *    (resumable jobs, claim exclusivity, terminal state machine,
 *     telemetry).
 *  - `ProxyRotator` can receive a storage through the `IStorage`
 *    interface and `saveProxyRotation` flows through it.
 *  - Type-level / structural checks that the SQLite `Storage` class
 *    satisfies the `IStorage` contract.
 *  - Sanity: the existing SQLite-backed tests still pass (covered by
 *    the suite as a whole; this file does not duplicate them).
 */
import { describe, expect, it, vi } from "vitest";
import { JobManager } from "../src/core/jobManager.js";
import { ProxyRotator } from "../src/proxy/proxyRotator.js";
import { Storage } from "../src/storage/storage.js";
import type { AdapterRegistry } from "../src/adapters/registry.js";
import type { BrowserSessionManager } from "../src/browser/browserSessionManager.js";
import type {
  ClaimTaskInput,
  CreateParseJobInput,
  EnqueueCompanyTaskInput,
  IStorage
} from "../src/storage/interface.js";
import type {
  CaptchaEventInput,
  CompanyTaskRow,
  CompanyTaskStatus,
  Lead,
  ParseAttempt,
  ParseJobRow,
  ParseJobStatus,
  ProxyRotationInput,
  SaveRawSnapshotInput,
  SourceId
} from "../src/types.js";
import type { JobTelemetry } from "../src/core/telemetry.js";
import type { ISourceAdapter, RawCardDetail, RawCompanyCard, RawContacts, RuntimeConfig, SourceCapabilities } from "../src/types.js";

// ---------------------------------------------------------------------------
// Stub the exporter for the JobManager tests (real exporter needs fs paths).
// ---------------------------------------------------------------------------
vi.mock("../src/export/exporter.js", () => ({
  exportLeads: async () => ({ csvPath: "<stub>", xlsxPath: "<stub>" })
}));

// ---------------------------------------------------------------------------
// In-memory IStorage implementation.
// ---------------------------------------------------------------------------
class FakeStorage implements IStorage {
  private readonly leads = new Map<string, Lead>();
  private readonly parseJobs = new Map<string, ParseJobRow & { seq: number }>();
  private readonly tasks = new Map<number, CompanyTaskRow>();
  private readonly attempts: Array<ParseAttempt & { _id: number }> = [];
  private readonly captchaEvents: Array<CaptchaEventInput & { id: number }> = [];
  private readonly proxyRotations: ProxyRotationInput[] = [];
  private readonly rawSnapshots = new Map<number, SaveRawSnapshotInput & { id: number; createdAt: string }>();
  private taskSeq = 0;
  private snapSeq = 0;
  private captchaSeq = 0;
  private attemptSeq = 0;
  private closed = false;

  // --- Parse-job lifecycle ---
  async createParseJob(input: CreateParseJobInput): Promise<string> {
    if (this.closed) throw new Error("storage closed");
    const id = `${input.source}-fake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    this.parseJobs.set(id, {
      id,
      source: input.source,
      city: input.city,
      category: input.category,
      status: "running",
      total_found: 0,
      created_at: now,
      updated_at: now,
      finished_at: null,
      seq: this.parseJobs.size
    });
    return id;
  }

  async findResumableParseJob(input: CreateParseJobInput): Promise<ParseJobRow | null> {
    const matches = Array.from(this.parseJobs.values())
      .filter(
        (job) =>
          job.source === input.source &&
          job.city === input.city &&
          job.category === input.category &&
          job.status !== "completed" &&
          job.status !== "failed"
      )
      .sort((a, b) => b.seq - a.seq);
    if (matches.length === 0) return null;
    const { seq: _omit, ...row } = matches[0];
    void _omit;
    return row;
  }

  async updateParseJobTotalFound(parseJobId: string, totalFound: number): Promise<void> {
    const job = this.parseJobs.get(parseJobId);
    if (!job) return;
    job.total_found = totalFound;
    job.updated_at = new Date().toISOString();
  }

  async setParseJobStatus(parseJobId: string, status: ParseJobStatus): Promise<void> {
    const job = this.parseJobs.get(parseJobId);
    if (!job) return;
    const now = new Date().toISOString();
    job.status = status;
    job.updated_at = now;
    if (status === "completed" || status === "failed") {
      job.finished_at = now;
    }
  }

  async getParseJob(parseJobId: string): Promise<ParseJobRow | null> {
    const job = this.parseJobs.get(parseJobId);
    if (!job) return null;
    const { seq: _omit, ...row } = job;
    void _omit;
    return row;
  }

  async finalizeParseJob(parseJobId: string): Promise<ParseJobStatus> {
    const tasks = await this.listCompanyTasks(parseJobId);
    const done = tasks.filter((t) => t.status === "success" || t.status === "partial").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    const open = tasks.filter(
      (t) => t.status !== "success" && t.status !== "partial" && t.status !== "failed"
    ).length;
    let status: ParseJobStatus;
    if (open > 0) status = "running";
    else if (done > 0) status = "completed";
    else if (failed > 0) status = "failed";
    else status = "completed";
    await this.setParseJobStatus(parseJobId, status);
    return status;
  }

  // --- Company-task queue/state ---
  async enqueueCompanyTask(input: EnqueueCompanyTaskInput): Promise<number> {
    for (const t of this.tasks.values()) {
      if (
        t.parse_job_id === input.parseJobId &&
        t.source === input.source &&
        t.external_id === input.externalId
      ) {
        return t.id;
      }
    }
    const id = ++this.taskSeq;
    const now = new Date().toISOString();
    this.tasks.set(id, {
      id,
      parse_job_id: input.parseJobId,
      source: input.source,
      external_id: input.externalId,
      status: "pending",
      attempts: 0,
      next_run_at: null,
      worker_id: null,
      lease_until: null,
      last_error: null,
      created_at: now,
      updated_at: now
    });
    return id;
  }

  async claimNextTask(input: ClaimTaskInput): Promise<CompanyTaskRow | null> {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + input.leaseMs).toISOString();
    const candidate = Array.from(this.tasks.values())
      .filter(
        (t) =>
          t.parse_job_id === input.parseJobId &&
          (t.status === "pending" || t.status === "retry_scheduled") &&
          (t.next_run_at === null || t.next_run_at <= now)
      )
      .sort((a, b) => a.id - b.id)[0];
    if (!candidate) return null;
    candidate.status = "processing";
    candidate.worker_id = input.workerId;
    candidate.lease_until = leaseUntil;
    candidate.attempts += 1;
    candidate.updated_at = now;
    return { ...candidate };
  }

  async countOpenTasks(parseJobId: string): Promise<number> {
    return Array.from(this.tasks.values()).filter(
      (t) =>
        t.parse_job_id === parseJobId &&
        (t.status === "pending" ||
          t.status === "processing" ||
          t.status === "retry_scheduled" ||
          t.status === "blocked")
    ).length;
  }

  async listCompanyTasks(parseJobId: string): Promise<CompanyTaskRow[]> {
    return Array.from(this.tasks.values())
      .filter((t) => t.parse_job_id === parseJobId)
      .sort((a, b) => a.id - b.id)
      .map((t) => ({ ...t }));
  }

  private transition(taskId: number, to: CompanyTaskStatus, error: string | null): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (to === "blocked") {
      if (task.status !== "processing") return false;
    } else {
      if (task.status !== "processing") return false;
    }
    task.status = to;
    task.worker_id = null;
    task.lease_until = null;
    task.last_error = error;
    task.updated_at = new Date().toISOString();
    return true;
  }

  async markTaskSuccess(taskId: number): Promise<boolean> {
    return this.transition(taskId, "success", null);
  }
  async markTaskPartial(taskId: number): Promise<boolean> {
    return this.transition(taskId, "partial", null);
  }
  async markTaskFailed(taskId: number, error: string): Promise<boolean> {
    return this.transition(taskId, "failed", error);
  }
  async markTaskBlocked(taskId: number, error: string): Promise<boolean> {
    return this.transition(taskId, "blocked", error);
  }
  async scheduleTaskRetry(taskId: number, error: string, nextRunAt: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== "processing" && task.status !== "blocked") return false;
    task.status = "retry_scheduled";
    task.worker_id = null;
    task.lease_until = null;
    task.next_run_at = nextRunAt;
    task.last_error = error;
    task.updated_at = new Date().toISOString();
    return true;
  }

  async recoverExpiredLeases(referenceTime: Date = new Date()): Promise<number> {
    const cutoff = referenceTime.toISOString();
    let recovered = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "processing" && task.lease_until !== null && task.lease_until <= cutoff) {
        task.status = "retry_scheduled";
        task.worker_id = null;
        task.lease_until = null;
        task.next_run_at = cutoff;
        task.last_error = task.last_error ?? "lease expired";
        task.updated_at = cutoff;
        recovered += 1;
      }
    }
    return recovered;
  }

  // --- Lead / attempt / event writes ---
  async upsertLead(lead: Lead): Promise<void> {
    this.leads.set(`${lead.source}::${lead.external_id}`, { ...lead });
  }

  async listLeads(): Promise<Lead[]> {
    return Array.from(this.leads.values()).sort((a, b) =>
      a.company_name < b.company_name ? -1 : a.company_name > b.company_name ? 1 : 0
    );
  }

  async saveAttempt(attempt: ParseAttempt): Promise<void> {
    this.attempts.push({ ...attempt, _id: ++this.attemptSeq });
  }

  async countParseAttempts(parseJobId: string): Promise<number> {
    const taskIds = new Set(
      Array.from(this.tasks.values())
        .filter((t) => t.parse_job_id === parseJobId)
        .map((t) => t.id)
    );
    return this.attempts.filter((a) => a.companyTaskId !== undefined && taskIds.has(a.companyTaskId)).length;
  }

  async saveCaptchaEvent(input: CaptchaEventInput): Promise<number> {
    this.captchaSeq += 1;
    this.captchaEvents.push({ ...input, id: this.captchaSeq });
    return this.captchaSeq;
  }

  async saveRawSnapshot(input: SaveRawSnapshotInput): Promise<number> {
    this.snapSeq += 1;
    this.rawSnapshots.set(this.snapSeq, {
      ...input,
      id: this.snapSeq,
      createdAt: new Date().toISOString()
    });
    return this.snapSeq;
  }

  // --- Telemetry (in-memory aggregate) ---
  async getJobTelemetry(parseJobId: string): Promise<JobTelemetry> {
    const tasks = await this.listCompanyTasks(parseJobId);
    const terminal = tasks.filter(
      (t) => t.status === "success" || t.status === "partial" || t.status === "failed" || t.status === "blocked"
    );
    const successN = terminal.filter((t) => t.status === "success").length;
    const partialN = terminal.filter((t) => t.status === "partial").length;
    const failedN = terminal.filter((t) => t.status === "failed" || t.status === "blocked").length;
    const terminalCount = terminal.length;
    const job = this.parseJobs.get(parseJobId);
    const taskIds = new Set(tasks.map((t) => t.id));
    const captchaCount = this.captchaEvents.filter(
      (e) => e.companyTaskId !== undefined && e.companyTaskId !== null && taskIds.has(e.companyTaskId)
    ).length;
    const banCount = this.attempts.filter(
      (a) => a.companyTaskId !== undefined && taskIds.has(a.companyTaskId) && (a.status === "blocked" || a.errorType === "blocked")
    ).length;
    const durations = this.attempts
      .filter((a) => a.durationMs !== undefined && a.companyTaskId !== undefined && taskIds.has(a.companyTaskId))
      .map((a) => a.durationMs as number);
    const averageParseTime =
      durations.length > 0 ? durations.reduce((s, n) => s + n, 0) / durations.length : null;
    const jobStart = job?.created_at ?? null;
    const jobEnd = job?.finished_at ?? new Date().toISOString();
    const proxyRotationCount = jobStart
      ? this.proxyRotations.filter((_p, i) => {
          // No real timestamps stored on the input — use a stable counter proxy.
          void i;
          return true;
        }).length
      : 0;
    const elapsedHours = jobStart
      ? (new Date(jobEnd).getTime() - new Date(jobStart).getTime()) / 3_600_000
      : 0;
    const cardsPerHour = elapsedHours > 0 ? tasks.length / elapsedHours : null;
    return {
      parseJobId,
      success_rate: terminalCount > 0 ? successN / terminalCount : 0,
      partial_rate: terminalCount > 0 ? partialN / terminalCount : 0,
      failed_rate: terminalCount > 0 ? failedN / terminalCount : 0,
      terminal_count: terminalCount,
      captcha_count: captchaCount,
      ban_count: banCount,
      proxy_rotation_count: proxyRotationCount,
      average_parse_time: averageParseTime,
      cards_per_hour: cardsPerHour
    };
  }

  // --- Proxy lifecycle ---
  async saveProxyRotation(input: ProxyRotationInput): Promise<void> {
    this.proxyRotations.push({ ...input });
  }

  // --- Lifecycle ---
  close(): void {
    this.closed = true;
  }

  getRawSnapshotDir(): string | null {
    return null;
  }

  // Test helpers (not on the interface)
  attemptCount(): number {
    return this.attempts.length;
  }
  proxyRotationCount(): number {
    return this.proxyRotations.length;
  }
}

// ---------------------------------------------------------------------------
// Fake adapter for JobManager tests.
// ---------------------------------------------------------------------------
class FakeAdapter implements ISourceAdapter {
  source: SourceId = "2gis";
  constructor(private readonly cards: RawCompanyCard[]) {}
  capabilities(): SourceCapabilities {
    return {
      needsBrowser: false,
      needsProxy: false,
      handlesCaptcha: false,
      supportsApiCapture: true,
      supportsDomFallback: false
    };
  }
  async searchCompanies(): Promise<RawCompanyCard[]> {
    return this.cards;
  }
  async listCards(): Promise<RawCompanyCard[]> {
    return this.cards;
  }
  async getCardDetail(card: RawCompanyCard): Promise<RawCardDetail> {
    return { ...card, payload: { fixture: true, externalId: card.externalId } };
  }
  async getContacts(detail: RawCardDetail): Promise<RawContacts> {
    return {
      externalId: detail.externalId,
      phones: ["+71234567890"],
      email: null,
      website: null,
      socialLinks: [],
      messengerLinks: [],
      payload: { contacts: true }
    };
  }
  normalize(detail: RawCardDetail, contacts: RawContacts): Lead {
    return {
      source: this.source,
      external_id: detail.externalId,
      company_name: detail.name,
      category: detail.category ?? "test",
      city: detail.city ?? "moscow",
      address: detail.address ?? "Lenina 1",
      phones: contacts.phones,
      email: contacts.email ?? null,
      website: contacts.website ?? null,
      social_links: contacts.socialLinks,
      messenger_links: contacts.messengerLinks,
      parsed_at: new Date().toISOString(),
      incomplete: false
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeCard(externalId: string, name = `Company ${externalId}`): RawCompanyCard {
  return { source: "2gis", externalId, name, payload: { id: externalId } };
}

function makeConfig(): RuntimeConfig {
  return {
    source: "2gis",
    geo: "moscow",
    category: "autoservice",
    limit: 100,
    databasePath: "<fake>",
    exportDir: "<fake>",
    delayRangeMs: [0, 1],
    rotateEveryN: 50,
    maxRetries: 0,
    concurrency: 1,
    headless: true,
    rawSnapshotDir: "<fake>"
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("IStorage abstraction — type contract", () => {
  it("the SQLite Storage class structurally satisfies IStorage", () => {
    // Pure compile-time check. If Storage ever drifts away from the
    // contract, this assignment will fail to typecheck.
    const storage: IStorage = new Storage(":memory:");
    storage.close();
    expect(storage).toBeInstanceOf(Storage);
  });

  it("FakeStorage satisfies IStorage and is interchangeable with Storage at the type level", () => {
    const fake: IStorage = new FakeStorage();
    expect(fake).toBeInstanceOf(FakeStorage);
    fake.close();
  });
});

describe("JobManager against an in-memory IStorage", () => {
  it("runs a small job end-to-end and writes leads, attempts, and snapshots through the abstraction", async () => {
    const storage: IStorage = new FakeStorage();
    const cards = [makeCard("a"), makeCard("b")];
    const registry: AdapterRegistry = { resolve: () => new FakeAdapter(cards) } as unknown as AdapterRegistry;
    const manager = new JobManager(makeConfig(), registry, storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    expect(result.leads.map((l) => l.external_id).sort()).toEqual(["a", "b"]);
    expect(result.status).toBe("completed");

    const fake = storage as FakeStorage;
    expect(fake.attemptCount()).toBe(2); // one success attempt per card
    expect(fake.proxyRotationCount()).toBe(0);
  });

  it("recovers expired leases on startup via the IStorage contract", async () => {
    const storage: IStorage = new FakeStorage();
    const jobId = await storage.createParseJob({ source: "2gis", city: "moscow", category: "autoservice" });
    const taskId = await storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "x" });
    // Simulate a crashed prior run: claim with a 0ms lease so it's already expired.
    await storage.claimNextTask({ parseJobId: jobId, workerId: "dead", leaseMs: 0 });

    const cards = [makeCard("x")];
    const registry: AdapterRegistry = { resolve: () => new FakeAdapter(cards) } as unknown as AdapterRegistry;
    const manager = new JobManager(makeConfig(), registry, storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    // The recovered job is the same one we created — the JobManager
    // resumed it instead of allocating a new id.
    expect(result.jobId).toBe(jobId);
    const tasks = await (storage as FakeStorage).listCompanyTasks(jobId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(taskId);
    expect(tasks[0].attempts).toBe(2); // dead claim + recovered + re-claimed
  });

  it("uses the IStorage getJobTelemetry method for final telemetry", async () => {
    const storage: IStorage = new FakeStorage();
    const cards = [makeCard("a")];
    const registry: AdapterRegistry = { resolve: () => new FakeAdapter(cards) } as unknown as AdapterRegistry;
    const manager = new JobManager(makeConfig(), registry, storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    // The JobManager returns leads, not a telemetry object. To assert
    // getJobTelemetry was actually plumbed correctly, call it through
    // the abstraction: the in-memory implementation must report 1
    // terminal success.
    const t = await storage.getJobTelemetry(result.jobId);
    expect(t.terminal_count).toBe(1);
    expect(t.success_rate).toBe(1);
    expect(t.captcha_count).toBe(0);
  });
});

describe("ProxyRotator can receive storage through the IStorage interface", () => {
  it("forwards saveProxyRotation to the abstraction on a successful rotation", async () => {
    const storage: IStorage = new FakeStorage();
    const session: BrowserSessionManager = {
      restartWithProxy: vi.fn().mockResolvedValue(undefined)
    } as unknown as BrowserSessionManager;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ server: "http://1.2.3.4:8080", proxy_channel: "ch-x" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const config: RuntimeConfig = { ...makeConfig(), proxyApiUrl: "http://proxy.example/rotate" };
    const rotator = new ProxyRotator(config, storage, session);

    for (let i = 0; i < config.rotateEveryN; i++) await rotator.tick();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect((storage as FakeStorage).proxyRotationCount()).toBe(1);
    expect(session.restartWithProxy).toHaveBeenCalledWith({
      server: "http://1.2.3.4:8080",
      username: undefined,
      password: undefined
    });
  });

  it("records failed rotation through the interface without throwing", async () => {
    const storage: IStorage = new FakeStorage();
    const session: BrowserSessionManager = {
      restartWithProxy: vi.fn().mockResolvedValue(undefined)
    } as unknown as BrowserSessionManager;

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream timeout")));

    const config: RuntimeConfig = { ...makeConfig(), proxyApiUrl: "http://proxy.example/rotate" };
    const rotator = new ProxyRotator(config, storage, session);
    await expect(rotator.rotate("blocked")).resolves.toBeUndefined();

    expect((storage as FakeStorage).proxyRotationCount()).toBe(1);
    expect(session.restartWithProxy).not.toHaveBeenCalled();
  });
});
