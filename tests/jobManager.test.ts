import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { JobManager } from "../src/core/jobManager.js";
import { Storage } from "../src/storage/storage.js";
import type { ProxyRotator, ProxyRuntimeState } from "../src/proxy/proxyRotator.js";
import type {
  ISourceAdapter,
  Lead,
  RawCardDetail,
  RawCompanyCard,
  RawContacts,
  RuntimeConfig,
  SourceCapabilities
} from "../src/types.js";

interface FakeAdapterOptions {
  cards: RawCompanyCard[];
  failOn?: Map<string, () => Error>;
  incomplete?: Set<string>;
}

class FakeAdapter implements ISourceAdapter {
  source = "2gis";
  constructor(private readonly opts: FakeAdapterOptions) {}

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
    return this.opts.cards;
  }

  async listCards(): Promise<RawCompanyCard[]> {
    return this.opts.cards;
  }

  async getCardDetail(card: RawCompanyCard): Promise<RawCardDetail> {
    const make = this.opts.failOn?.get(card.externalId);
    if (make) throw make();
    return { ...card, payload: { source: "fixture", externalId: card.externalId } };
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
      incomplete: this.opts.incomplete?.has(detail.externalId) ?? false
    };
  }
}

function makeCard(externalId: string, name = `Company ${externalId}`): RawCompanyCard {
  return { source: "2gis", externalId, name, payload: { id: externalId } };
}

function makeWorkspace(): {
  storage: Storage;
  config: RuntimeConfig;
  cleanup: () => void;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-jm-"));
  const storage = new Storage(path.join(root, "test.db"));
  const config: RuntimeConfig = {
    source: "2gis",
    geo: "moscow",
    category: "autoservice",
    limit: 100,
    databasePath: path.join(root, "test.db"),
    exportDir: path.join(root, "exports"),
    delayRangeMs: [0, 1],
    rotateEveryN: 50,
    maxRetries: 2,
    concurrency: 1,
    headless: true,
    rawSnapshotDir: path.join(root, "raw")
  };
  return {
    storage,
    config,
    root,
    cleanup: () => {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("JobManager queue/state integration", () => {
  let ws: ReturnType<typeof makeWorkspace>;
  beforeEach(() => {
    ws = makeWorkspace();
  });
  afterEach(() => {
    ws.cleanup();
  });

  it("reclaims a crashed processing task on the next run and resumes the same parse_job", async () => {
    const cards = [makeCard("ext-1"), makeCard("ext-2")];
    const adapter = new FakeAdapter({ cards });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    // Simulate a crashed prior run: a parse_job in 'running' with one task stuck in 'processing'
    // whose lease has expired.
    const priorJobId = ws.storage.createParseJob({
      source: "2gis",
      city: "moscow",
      category: "autoservice"
    });
    const stuckTaskId = ws.storage.enqueueCompanyTask({
      parseJobId: priorJobId,
      source: "2gis",
      externalId: "ext-1"
    });
    ws.storage.claimNextTask({ parseJobId: priorJobId, workerId: "dead", leaseMs: 10 });
    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE company_tasks SET lease_until = ? WHERE id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      stuckTaskId
    );

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 5, capMs: 20, jitter: 0 },
      emptyPollMs: 10
    });
    const result = await manager.run();

    // No new parse_job created — the crashed one is resumed.
    expect(result.jobId).toBe(priorJobId);
    expect(result.status).toBe("completed");

    const tasks = ws.storage.listCompanyTasks(priorJobId);
    expect(tasks).toHaveLength(2);
    const reclaimed = tasks.find((t) => t.id === stuckTaskId);
    expect(reclaimed?.status).toBe("success");
    // attempts increments: first dead claim = 1, recovered + re-claimed = 2.
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.lease_until).toBeNull();
    expect(reclaimed?.worker_id).toBeNull();
    expect(result.leads.map((l) => l.external_id).sort()).toEqual(["ext-1", "ext-2"]);
  });

  it("caps blocked errors at maxAttempts and marks the task failed", async () => {
    const cards = [makeCard("ext-blocked")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-blocked", () => new Error("HTTP 429 Too Many Requests"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const tasks = ws.storage.listCompanyTasks(result.jobId);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.status).toBe("failed");
    expect(task.attempts).toBe(ws.config.maxRetries + 1); // 3 attempts total
    expect(task.last_error).toContain("429");
    expect(result.status).toBe("failed");
  });

  it("parse_job aggregate status is 'completed' when some tasks fail but others succeed", async () => {
    const cards = [makeCard("ext-ok"), makeCard("ext-bad")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-bad", () => new Error("permanent boom"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    expect(result.status).toBe("completed");
    const tasks = ws.storage.listCompanyTasks(result.jobId);
    const byId = new Map(tasks.map((t) => [t.external_id, t]));
    expect(byId.get("ext-ok")?.status).toBe("success");
    expect(byId.get("ext-bad")?.status).toBe("failed");

    const job = ws.storage.getParseJob(result.jobId);
    expect(job?.status).toBe("completed");
    expect(job?.finished_at).not.toBeNull();
  });

  it("parse_job aggregate status is 'failed' when every task fails", async () => {
    const cards = [makeCard("ext-a"), makeCard("ext-b")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-a", () => new Error("boom"));
    failOn.set("ext-b", () => new Error("boom"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();
    expect(result.status).toBe("failed");
    expect(ws.storage.getParseJob(result.jobId)?.status).toBe("failed");
  });
});

describe("JobManager non-retryable outcomes", () => {
  let ws: ReturnType<typeof makeWorkspace>;
  beforeEach(() => {
    ws = makeWorkspace();
  });
  afterEach(() => {
    ws.cleanup();
  });

  it("deleted card (404/not found) is terminal failed after exactly one attempt even when maxRetries > 0", async () => {
    const cards = [makeCard("ext-deleted")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-deleted", () => new Error("404 not found"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const tasks = ws.storage.listCompanyTasks(result.jobId);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.status).toBe("failed");
    // Must have terminated after the first (and only) attempt, not after maxRetries+1.
    expect(task.attempts).toBe(1);

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const attempt = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(attempt.result).toBe("failed");
    expect(attempt.error_type).toBe("deleted_card");
  });

  it("no-data outcome is terminal partial after exactly one attempt", async () => {
    const cards = [makeCard("ext-empty")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-empty", () => new Error("no data available for this company"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const tasks = ws.storage.listCompanyTasks(result.jobId);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.status).toBe("partial");
    expect(task.attempts).toBe(1);

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const attempt = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(attempt.result).toBe("partial");
    expect(attempt.error_type).toBe("no_data");
  });

  it("generic error still retries until maxRetries + 1 then marks failed", async () => {
    const cards = [makeCard("ext-generic")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-generic", () => new Error("internal server error"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const tasks = ws.storage.listCompanyTasks(result.jobId);
    expect(tasks[0].status).toBe("failed");
    // maxRetries = 2 → 3 total attempts
    expect(tasks[0].attempts).toBe(ws.config.maxRetries + 1);
  });

  it("blocked/429 still retries until maxRetries + 1 then marks failed", async () => {
    const cards = [makeCard("ext-rate-limited")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-rate-limited", () => new Error("HTTP 429 Too Many Requests"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const tasks = ws.storage.listCompanyTasks(result.jobId);
    expect(tasks[0].status).toBe("failed");
    expect(tasks[0].attempts).toBe(ws.config.maxRetries + 1);

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const attempts = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .all(tasks[0].id) as Array<Record<string, unknown>>;
    expect(attempts.every((a) => a.result === "blocked")).toBe(true);
    expect(attempts.every((a) => a.error_type === "blocked")).toBe(true);
  });

  it("deleted card with 'removed' keyword is also terminal after one attempt", async () => {
    const cards = [makeCard("ext-removed")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-removed", () => new Error("company removed from source"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const tasks = ws.storage.listCompanyTasks(result.jobId);
    expect(tasks[0].status).toBe("failed");
    expect(tasks[0].attempts).toBe(1);
  });

  it("403 is still classified blocked (not deleted_card) and retries", async () => {
    const cards = [makeCard("ext-403")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-403", () => new Error("403 Forbidden"));
    const adapter = new FakeAdapter({ cards, failOn });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const tasks = ws.storage.listCompanyTasks(result.jobId);
    expect(tasks[0].status).toBe("failed");
    expect(tasks[0].attempts).toBe(ws.config.maxRetries + 1);

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const attempts = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .all(tasks[0].id) as Array<Record<string, unknown>>;
    expect(attempts.every((a) => a.error_type === "blocked")).toBe(true);
  });
});

describe("JobManager CAPTCHA event wiring", () => {
  let ws: ReturnType<typeof makeWorkspace>;
  beforeEach(() => { ws = makeWorkspace(); });
  afterEach(() => { ws.cleanup(); });

  function runBlocked(message: string) {
    const cards = [makeCard("ext-cap")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-cap", () => new Error(message));
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ cards, failOn }));
    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    return manager.run();
  }

  it("blocked/429 writes a captcha_events row linked to the company task", async () => {
    const result = await runBlocked("HTTP 429 Too Many Requests");
    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];

    const events = db
      .prepare("SELECT * FROM captcha_events WHERE company_task_id = ?")
      .all(task.id) as Array<Record<string, unknown>>;
    // One event per attempt: maxRetries+1 = 3 attempts → 3 events.
    expect(events).toHaveLength(ws.config.maxRetries + 1);
    expect(events[0].source).toBe("2gis");
    expect(events[0].action).toBe("blocked_detected");
    expect(events[0].company_task_id).toBe(task.id);
  });

  it("captcha_events.company_task_id becomes null when the task is deleted (FK ON DELETE SET NULL)", async () => {
    const result = await runBlocked("HTTP 429 Too Many Requests");
    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];

    const before = db
      .prepare("SELECT * FROM captcha_events WHERE company_task_id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(before).toBeDefined();
    const eventId = before.id as number;

    db.prepare("DELETE FROM company_tasks WHERE id = ?").run(task.id);

    const after = db
      .prepare("SELECT * FROM captcha_events WHERE id = ?")
      .get(eventId) as Record<string, unknown>;
    expect(after).toBeDefined();
    expect(after.company_task_id).toBeNull();
  });

  it("telemetry captcha_count equals the number of blocked attempts for the job", async () => {
    const result = await runBlocked("HTTP 429 Too Many Requests");
    const t = ws.storage.getJobTelemetry(result.jobId);
    // maxRetries=2 → 3 total attempts → 3 captcha events.
    expect(t.captcha_count).toBe(ws.config.maxRetries + 1);
  });

  it("each blocked event has a snapshot_id pointing to an error-purpose snapshot (429)", async () => {
    const result = await runBlocked("HTTP 429 Too Many Requests");
    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];

    const events = db
      .prepare("SELECT * FROM captcha_events WHERE company_task_id = ?")
      .all(task.id) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.snapshot_id).not.toBeNull();
      const snap = ws.storage.getRawSnapshot(ev.snapshot_id as number);
      expect(snap).not.toBeNull();
      expect(snap?.purpose).toBe("error");
      expect(snap?.company_task_id).toBe(task.id);
      const payload = JSON.parse(snap?.payload ?? "{}") as Record<string, unknown>;
      expect(payload.externalId).toBe("ext-cap");
      expect(payload.errorType).toBe("blocked");
    }
  });

  it("captcha keyword in error uses captcha purpose and captcha_detected action", async () => {
    const result = await runBlocked("captcha page detected, please solve");
    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];

    const events = db
      .prepare("SELECT * FROM captcha_events WHERE company_task_id = ?")
      .all(task.id) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].action).toBe("captcha_detected");

    const snap = ws.storage.getRawSnapshot(events[0].snapshot_id as number);
    expect(snap?.purpose).toBe("captcha");
  });
});

describe("JobManager proxy ID recording", () => {
  let ws: ReturnType<typeof makeWorkspace>;
  beforeEach(() => { ws = makeWorkspace(); });
  afterEach(() => { ws.cleanup(); });

  function makeFakeRotator(state: Partial<ProxyRuntimeState> = {}): ProxyRotator {
    const s: ProxyRuntimeState = { proxy: null, proxyChannel: null, ip: null, cardsOnIp: 0, ...state };
    return {
      getCurrentState: () => ({ ...s }),
      tick: async () => {},
      rotate: async (_reason: string) => {}
    } as unknown as ProxyRotator;
  }

  it("successful attempt records proxy_id from proxyChannel", async () => {
    const rotator = makeFakeRotator({ proxyChannel: "ch-1", proxy: "http://proxy:1234" });
    const cards = [makeCard("ext-ok")];
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ cards }));
    const manager = new JobManager(ws.config, registry, ws.storage, rotator, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];
    const attempt = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(attempt.proxy_id).toBe("ch-1");
  });

  it("fallback: uses proxy URL when proxyChannel is null", async () => {
    const rotator = makeFakeRotator({ proxyChannel: null, proxy: "http://proxy:1234" });
    const cards = [makeCard("ext-ok")];
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ cards }));
    const manager = new JobManager(ws.config, registry, ws.storage, rotator, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];
    const attempt = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(attempt.proxy_id).toBe("http://proxy:1234");
  });

  it("no rotator leaves proxy_id null on parse_attempts", async () => {
    const cards = [makeCard("ext-ok")];
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ cards }));
    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];
    const attempt = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(attempt.proxy_id).toBeNull();
  });

  it("blocked attempt records proxy_id on parse_attempts", async () => {
    const rotator = makeFakeRotator({ proxyChannel: "ch-block", proxy: "http://proxy:1234" });
    const cards = [makeCard("ext-blocked")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-blocked", () => new Error("HTTP 429 Too Many Requests"));
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ cards, failOn }));
    const manager = new JobManager(ws.config, registry, ws.storage, rotator, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];
    const attempts = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .all(task.id) as Array<Record<string, unknown>>;
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a) => a.proxy_id === "ch-block")).toBe(true);
  });

  it("blocked/CAPTCHA event records proxy_id on captcha_events", async () => {
    const rotator = makeFakeRotator({ proxyChannel: "ch-cap", proxy: "http://proxy:1234" });
    const cards = [makeCard("ext-cap")];
    const failOn = new Map<string, () => Error>();
    failOn.set("ext-cap", () => new Error("captcha detected"));
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ cards, failOn }));
    const manager = new JobManager(ws.config, registry, ws.storage, rotator, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = ws.storage.listCompanyTasks(result.jobId)[0];
    const events = db
      .prepare("SELECT * FROM captcha_events WHERE company_task_id = ?")
      .all(task.id) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.proxy_id === "ch-cap")).toBe(true);
  });
});
