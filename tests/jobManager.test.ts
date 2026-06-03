import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { JobManager } from "../src/core/jobManager.js";
import { logger } from "../src/logger.js";
import { RATE_LIMIT_WINDOW_MS } from "../src/core/rateLimiter.js";
import { Storage } from "../src/storage/storage.js";
import { SoftBlockError } from "../src/adapters/2gis/softBlock.js";
import type { ProxyRotator, ProxyRuntimeState } from "../src/proxy/proxyRotator.js";
import type {
  ISourceAdapter,
  Lead,
  RawCardDetail,
  RawCompanyCard,
  RawContacts,
  RateLimitPolicy,
  RuntimeConfig,
  SourceCapabilities
} from "../src/types.js";

// Stub the exporter module so JobManager.run() can resolve under
// `vi.useFakeTimers()`. ExcelJS uses stream APIs scheduled via setImmediate
// internally; faked timers swallow those events and `xlsx.writeFile` never
// settles. No test in this file asserts on csvPath/xlsxPath, so a fast
// no-op stub is sufficient. Real export behaviour is covered by
// tests/snapshotsDisk.test.ts and downstream consumers.
vi.mock("../src/export/exporter.js", () => ({
  exportLeads: async () => ({ csvPath: "<stub>", xlsxPath: "<stub>" })
}));

interface FakeAdapterOptions {
  cards: RawCompanyCard[];
  failOn?: Map<string, () => Error>;
  incomplete?: Set<string>;
  /** If set, getCardDetail sleeps this many ms before returning/throwing. */
  delayMs?: number;
  contactsById?: Map<string, Partial<RawContacts>>;
}

class FakeAdapter implements ISourceAdapter {
  source = "2gis";
  detailCalls: string[] = [];
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
    this.detailCalls.push(card.externalId);
    if (this.opts.delayMs) await sleep(this.opts.delayMs);
    const make = this.opts.failOn?.get(card.externalId);
    if (make) throw make();
    return { ...card, payload: { source: "fixture", externalId: card.externalId } };
  }

  async getContacts(detail: RawCardDetail): Promise<RawContacts> {
    const override = this.opts.contactsById?.get(detail.externalId) ?? {};
    return {
      externalId: detail.externalId,
      phones: override.phones ?? ["+71234567890"],
      email: override.email ?? null,
      website: override.website ?? null,
      socialLinks: override.socialLinks ?? [],
      messengerLinks: override.messengerLinks ?? [],
      payload: override.payload ?? { contacts: true }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const priorJobId = await ws.storage.createParseJob({
      source: "2gis",
      city: "moscow",
      category: "autoservice"
    });
    const stuckTaskId = await ws.storage.enqueueCompanyTask({
      parseJobId: priorJobId,
      source: "2gis",
      externalId: "ext-1"
    });
    await ws.storage.claimNextTask({ parseJobId: priorJobId, workerId: "dead", leaseMs: 10 });
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

    const tasks = await ws.storage.listCompanyTasks(priorJobId);
    expect(tasks).toHaveLength(2);
    const reclaimed = tasks.find((t) => t.id === stuckTaskId);
    expect(reclaimed?.status).toBe("success");
    // attempts increments: first dead claim = 1, recovered + re-claimed = 2.
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.lease_until).toBeNull();
    expect(reclaimed?.worker_id).toBeNull();
    expect(result.leads.map((l) => l.external_id).sort()).toEqual(["ext-1", "ext-2"]);
  });

  it("prioritizes sparse discovery cards before rich cards when the session cap stops early", async () => {
    ws.config.rateLimit = { maxCardsPerSession: 1 };
    const rich = {
      ...makeCard("rich", "Rich Company"),
      address: "Lenina 1",
      url: "https://2gis.ru/moscow/firm/rich",
      payload: {
        id: "rich",
        phone: "+71234567890",
        email: "rich@example.com",
        website: "https://rich.example.com",
        messengers: [{ provider: "Telegram" }]
      }
    };
    const sparse = makeCard("sparse", "Sparse Company");
    const adapter = new FakeAdapter({ cards: [rich, sparse] });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      emptyPollMs: 5
    });
    const result = await manager.run();

    expect(adapter.detailCalls).toEqual(["sparse"]);
    expect(result.status).toBe("running");
    expect(result.leads.map((lead) => lead.external_id)).toEqual(["sparse"]);
  });

  it("logs enrichment diagnostics for detail success and contact additions", async () => {
    const contactsById = new Map<string, Partial<RawContacts>>();
    contactsById.set("sparse", {
      email: "sparse@example.com",
      website: "https://sparse.example.com",
      messengerLinks: ["WhatsApp"]
    });
    const adapter = new FakeAdapter({ cards: [makeCard("sparse", "Sparse Company")], contactsById });
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const infoSpy = vi.spyOn(logger, "info");

    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      emptyPollMs: 5
    });
    await manager.run();

    const diagnosticsCall = infoSpy.mock.calls.find(([message]) => message === "enrichment diagnostics");
    expect(diagnosticsCall?.[1]).toMatchObject({
      detailsAttempted: 1,
      detailsSucceeded: 1,
      detailsFailed: 0,
      contactsImproved: 1,
      websiteAdded: 1,
      emailAdded: 1,
      messengersAdded: 1
    });
    infoSpy.mockRestore();
  });

  it("crawls company website for missing email after detail enrichment", async () => {
    const contactsById = new Map<string, Partial<RawContacts>>();
    contactsById.set("site-only", {
      website: "https://example.com"
    });
    const fetchSpy = vi.fn(async () => new Response(
      "<html><a href='mailto:hello@example.com'>hello@example.com</a></html>",
      { headers: { "content-type": "text/html" } }
    ));
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = new FakeAdapter({ cards: [makeCard("site-only", "Site Only")], contactsById });
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const infoSpy = vi.spyOn(logger, "info");

    try {
      const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
        emptyPollMs: 5
      });
      const result = await manager.run();

      expect(result.leads[0].email).toBe("hello@example.com");
      const diagnosticsCall = infoSpy.mock.calls.find(([message]) => message === "enrichment diagnostics");
      expect(diagnosticsCall?.[1]).toMatchObject({
        websiteCrawlAttempted: 1,
        websiteCrawlSucceeded: 1,
        websiteCrawlEmailFound: 1,
        websiteCrawlPagesVisited: 1
      });
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("discovers a missing company website and crawls it for email", async () => {
    const contactsById = new Map<string, Partial<RawContacts>>();
    contactsById.set("no-site", {
      phones: ["+71234567890"],
      email: null,
      website: null
    });
    ws.config.websiteDiscovery = {
      enabled: true,
      maxSearches: 1,
      maxCandidates: 1,
      timeoutMs: 100
    };
    ws.config.websiteCrawl = {
      enabled: true,
      maxPages: 2,
      timeoutMs: 100
    };

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("duckduckgo.com/html")) {
        return new Response("<a href='https://site-only.example'>Site Only official</a>", {
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://site-only.example") {
        return new Response("Site Only moscow Lenina 1 +7 123 456-78-90", {
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://site-only.example/contacts") {
        return new Response("<a href='mailto:hello@site-only.example'>Email</a>", {
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = new FakeAdapter({ cards: [makeCard("no-site", "Site Only")], contactsById });
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const infoSpy = vi.spyOn(logger, "info");

    try {
      const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
        emptyPollMs: 5
      });
      const result = await manager.run();

      expect(result.leads[0].website).toBe("https://site-only.example");
      expect(result.leads[0].email).toBe("hello@site-only.example");
      const diagnosticsCall = infoSpy.mock.calls.find(([message]) => message === "enrichment diagnostics");
      expect(diagnosticsCall?.[1]).toMatchObject({
        websiteDiscoveryAttempted: 1,
        websiteDiscoverySucceeded: 1,
        websiteDiscoveryWebsiteFound: 1,
        websiteCrawlAttempted: 1,
        websiteCrawlEmailFound: 1
      });
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("enriches missing contacts through directory contact discovery", async () => {
    const contactsById = new Map<string, Partial<RawContacts>>();
    contactsById.set("dir-only", {
      phones: ["+79130000000"],
      email: null,
      website: null
    });
    ws.config.directoryContactDiscovery = {
      enabled: true,
      maxSearches: 1,
      maxCandidates: 1,
      allowlist: ["zoon.ru"]
    };

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("duckduckgo.com") || url.includes("bing.com")) {
        return new Response('<a href="https://zoon.ru/nsk/test/">Test</a>', {
          headers: { "content-type": "text/html" }
        } as any);
      }
      if (url.includes("zoon.ru")) {
        return new Response("Email: found@zoon.ru Phone: 79130000000", {
          headers: { "content-type": "text/html" }
        } as any);
      }
      return new Response("", { status: 404 } as any);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new FakeAdapter({ cards: [makeCard("dir-only", "Dir Only")], contactsById });
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const infoSpy = vi.spyOn(logger, "info");

    try {
      const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
        emptyPollMs: 5
      });
      const result = await manager.run();

      expect(result.leads[0].email).toBe("found@zoon.ru");
      const diagnosticsCall = infoSpy.mock.calls.find(([message]) => message === "enrichment diagnostics");
      expect(diagnosticsCall?.[1]).toMatchObject({
        directoryDiscoveryAttempted: 1,
        directoryDiscoverySucceeded: 1,
        directoryDiscoveryEmailFound: 1
      });
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllGlobals();
    }
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

    const tasks = await ws.storage.listCompanyTasks(result.jobId);
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
    const tasks = await ws.storage.listCompanyTasks(result.jobId);
    const byId = new Map(tasks.map((t) => [t.external_id, t]));
    expect(byId.get("ext-ok")?.status).toBe("success");
    expect(byId.get("ext-bad")?.status).toBe("failed");

    const job = await ws.storage.getParseJob(result.jobId);
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
    expect((await ws.storage.getParseJob(result.jobId))?.status).toBe("failed");
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

    const tasks = await ws.storage.listCompanyTasks(result.jobId);
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

    const tasks = await ws.storage.listCompanyTasks(result.jobId);
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

    const tasks = await ws.storage.listCompanyTasks(result.jobId);
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

    const tasks = await ws.storage.listCompanyTasks(result.jobId);
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

    const tasks = await ws.storage.listCompanyTasks(result.jobId);
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

    const tasks = await ws.storage.listCompanyTasks(result.jobId);
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
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];

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
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];

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
    const t = await ws.storage.getJobTelemetry(result.jobId);
    // maxRetries=2 → 3 total attempts → 3 captcha events.
    expect(t.captcha_count).toBe(ws.config.maxRetries + 1);
  });

  it("each blocked event has a snapshot_id pointing to an error-purpose snapshot (429)", async () => {
    const result = await runBlocked("HTTP 429 Too Many Requests");
    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];

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
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];

    const events = db
      .prepare("SELECT * FROM captcha_events WHERE company_task_id = ?")
      .all(task.id) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].action).toBe("captcha_detected");

    const snap = ws.storage.getRawSnapshot(events[0].snapshot_id as number);
    expect(snap?.purpose).toBe("captcha");
  });
});

describe("JobManager discovery-phase block recording", () => {
  let ws: ReturnType<typeof makeWorkspace>;
  beforeEach(() => { ws = makeWorkspace(); });
  afterEach(() => { ws.cleanup(); });

  function runDiscoveryThrow(error: Error | string) {
    const adapter = new FakeAdapter({ cards: [] });
    (adapter as unknown as Record<string, unknown>)["searchCompanies"] = async () => {
      throw typeof error === "string" ? new Error(error) : error;
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const manager = new JobManager(ws.config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    return manager.run();
  }

  it("an anti-bot CAPTCHA during discovery rethrows AND records a captcha_events row (no false 'completed')", async () => {
    await expect(runDiscoveryThrow("CAPTCHA detected; screenshot saved to /tmp/x.png")).rejects.toThrow(
      /CAPTCHA detected/
    );

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const events = db.prepare("SELECT * FROM captcha_events").all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("2gis");
    expect(events[0].action).toBe("captcha_detected");
    // Discovery has no company task yet — the event is job-level (null FK).
    expect(events[0].company_task_id).toBeNull();

    const snap = ws.storage.getRawSnapshot(events[0].snapshot_id as number);
    expect(snap?.purpose).toBe("captcha");
    const payload = JSON.parse(snap?.payload ?? "{}") as Record<string, unknown>;
    expect(payload.phase).toBe("discovery");
  });

  it("a non-block discovery error rethrows without recording a captcha event", async () => {
    await expect(runDiscoveryThrow("network failure")).rejects.toThrow(/network failure/);
    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const events = db.prepare("SELECT * FROM captcha_events").all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(0);
  });

  it("a discovery soft block records distinct throttled evidence and does not complete", async () => {
    const error = new SoftBlockError(
      "throttled: 2GIS rendered an empty-results page with throttling/soft-block signals; screenshot saved to /tmp/throttle.png",
      {
        reason: "throttled",
        evidence: [{
          signal: "search_attributes",
          reason: "throttled",
          firmCount: 0,
          url: "catalog.api.2gis/markers/clustered",
          searchAttributes: { is_throttled: true, is_partial: true }
        }]
      },
      "/tmp/throttle.png"
    );

    await expect(runDiscoveryThrow(error)).rejects.toThrow(/throttled/);

    const db = (ws.storage as unknown as { db: import("better-sqlite3").Database }).db;
    const jobs = db.prepare("SELECT * FROM parse_jobs").all() as Array<Record<string, unknown>>;
    expect(jobs[0].status).not.toBe("completed");

    const events = db.prepare("SELECT * FROM captcha_events").all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("throttled_detected");
    expect(events[0].screenshot_path).toBe("/tmp/throttle.png");

    const snap = ws.storage.getRawSnapshot(events[0].snapshot_id as number);
    expect(snap?.purpose).toBe("soft_blocked");
    const payload = JSON.parse(snap?.payload ?? "{}") as Record<string, unknown>;
    expect(payload.reason).toBe("soft_blocked");
    expect(JSON.stringify(payload)).toContain("search_attributes");
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
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];
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
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];
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
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];
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
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];
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
    const task = (await ws.storage.listCompanyTasks(result.jobId))[0];
    const events = db
      .prepare("SELECT * FROM captcha_events WHERE company_task_id = ?")
      .all(task.id) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.proxy_id === "ch-cap")).toBe(true);
  });
});

describe("JobManager lease watchdog", () => {
  it("watchdog recovers an expired processing task injected after startup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-wd-"));
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
    try {
      // One card that takes 200 ms — gives the watchdog time to fire mid-run.
      const cards = [makeCard("ext-main")];
      const registry = new AdapterRegistry();
      registry.register(new FakeAdapter({ cards, delayMs: 200 }));

      const manager = new JobManager(config, registry, storage, undefined, {
        leaseWatchdogMs: 40,
        backoff: { baseMs: 1, capMs: 2, jitter: 0 },
        emptyPollMs: 5
      });

      // Start run without awaiting so we can inject a task mid-flight.
      const runPromise = manager.run();

      // Let startup recovery pass (it's sync), then inject a stuck task.
      await sleep(15);
      const sideJobId = await storage.createParseJob({ source: "2gis", city: "spb", category: "watchdog-test" });
      const stuckId = await storage.enqueueCompanyTask({ parseJobId: sideJobId, source: "2gis", externalId: "ext-stuck" });
      const db = (storage as unknown as { db: import("better-sqlite3").Database }).db;
      db.prepare("UPDATE company_tasks SET status='processing', lease_until=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), stuckId);

      // Verify the task is stuck at this point (startup recovery already ran and missed it).
      const before = db.prepare("SELECT status FROM company_tasks WHERE id=?").get(stuckId) as Record<string, unknown>;
      expect(before.status).toBe("processing");

      // Wait for at least two watchdog ticks (2 × 40 ms = 80 ms + buffer).
      await sleep(120);

      // Watchdog should have reset it to retry_scheduled.
      const after = db.prepare("SELECT status FROM company_tasks WHERE id=?").get(stuckId) as Record<string, unknown>;
      expect(after.status).toBe("retry_scheduled");

      await runPromise;
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("timer is cleaned up after run() completes — no further watchdog calls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-wd-"));
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
    try {
      let recoverCallCount = 0;
      const origRecover = storage.recoverExpiredLeases.bind(storage);
      storage.recoverExpiredLeases = (...args: Parameters<typeof storage.recoverExpiredLeases>) => {
        recoverCallCount++;
        return origRecover(...args);
      };

      const registry = new AdapterRegistry();
      registry.register(new FakeAdapter({ cards: [makeCard("ext-1")] }));
      const manager = new JobManager(config, registry, storage, undefined, {
        leaseWatchdogMs: 20,
        backoff: { baseMs: 1, capMs: 2, jitter: 0 },
        emptyPollMs: 5
      });

      await manager.run();
      const countAtCompletion = recoverCallCount;

      // Wait two watchdog intervals — no new calls should happen.
      await sleep(60);
      expect(recoverCallCount).toBe(countAtCompletion);
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("timer is cleaned up when run() throws (adapter error)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-wd-"));
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
    try {
      let recoverCallCount = 0;
      const origRecover = storage.recoverExpiredLeases.bind(storage);
      storage.recoverExpiredLeases = (...args: Parameters<typeof storage.recoverExpiredLeases>) => {
        recoverCallCount++;
        return origRecover(...args);
      };

      const throwingAdapter = new FakeAdapter({ cards: [] });
      // Override searchCompanies to throw after a short async gap (giving watchdog a chance to arm).
      (throwingAdapter as unknown as Record<string, unknown>)["searchCompanies"] = async () => {
        await sleep(30);
        throw new Error("network failure");
      };
      const registry = new AdapterRegistry();
      registry.register(throwingAdapter);

      const manager = new JobManager(config, registry, storage, undefined, {
        leaseWatchdogMs: 20,
        backoff: { baseMs: 1, capMs: 2, jitter: 0 },
        emptyPollMs: 5
      });

      await expect(manager.run()).rejects.toThrow("network failure");
      const countAtThrow = recoverCallCount;

      // Wait two watchdog intervals — timer must be dead.
      await sleep(60);
      expect(recoverCallCount).toBe(countAtThrow);
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("guard prevents concurrent recovery calls (maxConcurrent ≤ 1)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-wd-"));
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
    try {
      let currentDepth = 0;
      let maxDepth = 0;
      let totalCalls = 0;
      const origRecover = storage.recoverExpiredLeases.bind(storage);
      storage.recoverExpiredLeases = (...args: Parameters<typeof storage.recoverExpiredLeases>) => {
        totalCalls++;
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
        const result = origRecover(...args);
        currentDepth--;
        return result;
      };

      const registry = new AdapterRegistry();
      // Slow adapter keeps the run alive long enough for multiple watchdog ticks.
      registry.register(new FakeAdapter({ cards: [makeCard("ext-1"), makeCard("ext-2")], delayMs: 60 }));
      const manager = new JobManager(config, registry, storage, undefined, {
        leaseWatchdogMs: 15,
        backoff: { baseMs: 1, capMs: 2, jitter: 0 },
        emptyPollMs: 5
      });

      await manager.run();

      // Guard must ensure calls never overlapped (depth ≤ 1).
      expect(maxDepth).toBe(1);
      // Watchdog must have fired at least once beyond startup recovery.
      expect(totalCalls).toBeGreaterThanOrEqual(2);
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Rate-limit policy integration tests.
 *
 * The policy layer is opt-in: when no `rateLimit` block is present the
 * JobManager must behave exactly as before. Tests below cover the
 * persisted/per-session caps (real time, deterministic counts) and the
 * transient per-minute/per-proxy-request caps (vitest fake timers so the
 * 60s sliding window completes instantly).
 */
describe("JobManager rate-limit policy", () => {
  let ws: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    ws = makeWorkspace();
  });
  afterEach(() => {
    ws.cleanup();
  });

  function withPolicy(policy: RateLimitPolicy | undefined): RuntimeConfig {
    return { ...ws.config, rateLimit: policy };
  }

  it("unset policy preserves existing behaviour — every card is processed", async () => {
    const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3")];
    const adapter = new FakeAdapter({ cards });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(withPolicy(undefined), registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    expect(result.leads.map((l) => l.external_id).sort()).toEqual(["c1", "c2", "c3"]);
    const tasks = await ws.storage.listCompanyTasks(result.jobId);
    expect(tasks.every((t) => t.status === "success")).toBe(true);
  });

  it("max_cards_per_session: stops extra tasks from processing once the cap is reached", async () => {
    const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3"), makeCard("c4"), makeCard("c5")];
    const adapter = new FakeAdapter({ cards });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(withPolicy({ maxCardsPerSession: 2 }), registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    // Exactly two cards became leads; the remaining tasks stay pending.
    expect(result.leads).toHaveLength(2);
    const tasks = await ws.storage.listCompanyTasks(result.jobId);
    const byStatus = tasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStatus["success"]).toBe(2);
    expect(byStatus["pending"]).toBe(3);

    // parse_attempts reflects the same number as the cap (durable source of truth).
    expect(await ws.storage.countParseAttempts(result.jobId)).toBe(2);
  });

  it("max_cards_per_minute: 3rd card is delayed until the sliding window clears", async () => {
    vi.useFakeTimers();
    try {
      const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3")];
      const adapter = new FakeAdapter({ cards });
      const registry = new AdapterRegistry();
      registry.register(adapter);

      const manager = new JobManager(
        withPolicy({ maxCardsPerMinute: 2 }),
        registry,
        ws.storage,
        undefined,
        {
          backoff: { baseMs: 1, capMs: 2, jitter: 0 },
          emptyPollMs: 5
        }
      );

      const promise = manager.run();

      // Give cards 1 and 2 time to complete under fake timers. Both card
      // starts must succeed (window has room) and their processing is
      // bounded by delayRangeMs + setTimeout(0) housekeeping.
      await vi.advanceTimersByTimeAsync(200);

      // The 3rd start is now blocked on the 60s window — it has not been
      // claimed/processed yet. Verify by snapshotting the leads count.
      const midLeads = (await ws.storage.listLeads()).filter((l) =>
        l.external_id === "c1" || l.external_id === "c2" || l.external_id === "c3"
      );
      expect(midLeads).toHaveLength(2);

      // Advance past the 60s window — the oldest entries slide out and the
      // 3rd card can start.
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await promise;
      const externalIds = result.leads.map((l) => l.external_id).sort();
      expect(externalIds).toEqual(["c1", "c2", "c3"]);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("max_session_duration: stops new starts but allows in-flight completion", async () => {
    // Real time test: each card takes 100ms; session duration is 80ms; only
    // one card can be in-flight at a time. The 1st card finishes cleanly,
    // the 2nd claim is blocked because the duration was already exceeded
    // when the worker came back around.
    const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3")];
    const adapter = new FakeAdapter({ cards, delayMs: 100 });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const manager = new JobManager(withPolicy({ maxSessionDurationMs: 80 }), registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    // The 1st card is the in-flight one — it completed cleanly. No further
    // cards were claimed once the duration cap was crossed.
    expect(result.leads).toHaveLength(1);
    const tasks = await ws.storage.listCompanyTasks(result.jobId);
    const pending = tasks.filter((t) => t.status === "pending");
    expect(pending).toHaveLength(2);
  });

  it("max_cards_per_proxy: triggers rotate before next card when cardsOnIp hits the cap", async () => {
    const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3"), makeCard("c4"), makeCard("c5")];
    const adapter = new FakeAdapter({ cards });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    // Fake rotator whose cardsOnIp increments on every tick() and resets to
    // 0 on every rotate(). The real ProxyRotator does the same.
    let cardsOnIp = 0;
    const rotateMock = vi.fn(async (_reason: string) => {
      cardsOnIp = 0;
    });
    const rotator = {
      getCurrentState: (): ProxyRuntimeState => ({
        proxy: "http://rotator.test:8080",
        proxyChannel: "ch-test",
        ip: "1.2.3.4",
        cardsOnIp
      }),
      tick: vi.fn(async () => {
        cardsOnIp += 1;
      }),
      rotate: rotateMock
    } as unknown as ProxyRotator;

    const manager = new JobManager(
      withPolicy({ maxCardsPerProxy: 2 }),
      registry,
      ws.storage,
      rotator,
      { backoff: { baseMs: 1, capMs: 2, jitter: 0 }, emptyPollMs: 5 }
    );
    const result = await manager.run();

    // All 5 cards still get processed — rotation just keeps the cap rolling.
    expect(result.leads).toHaveLength(5);
    // Rotation must have been invoked before the 3rd, 4th, and 5th cards.
    expect(rotateMock).toHaveBeenCalled();
    const rotateReasons = rotateMock.mock.calls.map((c) => c[0]);
    expect(rotateReasons.every((r) => r === "cards_per_proxy_cap")).toBe(true);
  });

  it("max_requests_per_minute_per_proxy: gates detail/contact requests per proxy ID", async () => {
    vi.useFakeTimers();
    try {
      const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3")];
      const adapter = new FakeAdapter({ cards });
      const registry = new AdapterRegistry();
      registry.register(adapter);

      // Each card performs 2 requests (getCardDetail + getContacts) → 6 total.
      // cap=4 lets the first 4 fire immediately, the 5th and 6th wait.
      const rotator = {
        getCurrentState: (): ProxyRuntimeState => ({
          proxy: "http://rotator.test:8080",
          proxyChannel: "ch-budget",
          ip: "1.2.3.4",
          cardsOnIp: 0
        }),
        tick: vi.fn(async () => {}),
        rotate: vi.fn(async (_reason: string) => {})
      } as unknown as ProxyRotator;

      const manager = new JobManager(
        withPolicy({ maxRequestsPerMinutePerProxy: 4 }),
        registry,
        ws.storage,
        rotator,
        { backoff: { baseMs: 1, capMs: 2, jitter: 0 }, emptyPollMs: 5 }
      );

      const promise = manager.run();

      // Let the first 4 requests fire — cards 1 and 2 should both complete
      // (2 requests each, neither blocked).
      await vi.advanceTimersByTimeAsync(200);
      const midLeads = (await ws.storage.listLeads()).filter((l) =>
        l.external_id === "c1" || l.external_id === "c2" || l.external_id === "c3"
      );
      expect(midLeads).toHaveLength(2);

      // Advance past the 60s window so the 5th and 6th requests can fire.
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await promise;
      expect(result.leads).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("max_requests_per_minute_per_proxy: no-rotator path uses a stable direct bucket", async () => {
    vi.useFakeTimers();
    try {
      const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3")];
      const adapter = new FakeAdapter({ cards });
      const registry = new AdapterRegistry();
      registry.register(adapter);

      // No rotator. The request budget is scoped to the literal "direct" bucket.
      const manager = new JobManager(
        withPolicy({ maxRequestsPerMinutePerProxy: 4 }),
        registry,
        ws.storage,
        undefined,
        { backoff: { baseMs: 1, capMs: 2, jitter: 0 }, emptyPollMs: 5 }
      );

      const promise = manager.run();

      // First 4 requests (cards 1 and 2) should complete in this window.
      await vi.advanceTimersByTimeAsync(200);
      const midLeads = (await ws.storage.listLeads()).filter((l) =>
        l.external_id === "c1" || l.external_id === "c2" || l.external_id === "c3"
      );
      expect(midLeads).toHaveLength(2);

      // Advance past the 60s window — the 5th and 6th direct-bucket
      // requests can now fire and card 3 completes.
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await promise;
      expect(result.leads).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("max_cards_per_session: atomic reservation prevents overshoot under concurrency > 1", async () => {
    // 3 workers run in parallel; each card takes long enough that all
    // three race past the durable-count check before any of them writes
    // a parse_attempt row. Without the atomic reservation the cap of 2
    // would be silently overshot to 3.
    const cards = [
      makeCard("c1"),
      makeCard("c2"),
      makeCard("c3"),
      makeCard("c4"),
      makeCard("c5")
    ];
    const adapter = new FakeAdapter({ cards, delayMs: 40 });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const config: RuntimeConfig = { ...ws.config, concurrency: 3, rateLimit: { maxCardsPerSession: 2 } };

    const manager = new JobManager(config, registry, ws.storage, undefined, {
      backoff: { baseMs: 1, capMs: 2, jitter: 0 },
      emptyPollMs: 5
    });
    const result = await manager.run();

    expect(result.leads).toHaveLength(2);
    expect(await ws.storage.countParseAttempts(result.jobId)).toBe(2);
  });

  it("max_requests_per_minute_per_proxy: failed getCardDetail still consumes a request slot", async () => {
    vi.useFakeTimers();
    try {
      const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3")];

      // Every card fails on getCardDetail. With maxRetries=0 each card
      // contributes exactly one request to the per-proxy budget.
      // cap=2: under the old (buggy) behaviour, the failed requests were
      // *not* recorded, so the 3rd request would fire immediately and
      // the run would finish with no waits. The fix records the request
      // in `finally`, so the 3rd one blocks until the window slides.
      const failOn = new Map<string, () => Error>();
      for (const c of cards) failOn.set(c.externalId, () => new Error("HTTP 500 boom"));

      const adapter = new FakeAdapter({ cards, failOn });
      const registry = new AdapterRegistry();
      registry.register(adapter);

      // Fresh config: maxRetries=0 so each card makes exactly one request
      // before going terminal-failed. Keeps the test deterministic.
      const config: RuntimeConfig = { ...ws.config, maxRetries: 0, rateLimit: { maxRequestsPerMinutePerProxy: 2 } };
      const manager = new JobManager(config, registry, ws.storage, undefined, {
        backoff: { baseMs: 1, capMs: 2, jitter: 0 },
        emptyPollMs: 5
      });

      const promise = manager.run();

      // Let the first 2 requests fire and fail. With the fix in place,
      // these count, so the 3rd request is gated.
      await vi.advanceTimersByTimeAsync(200);

      // 2 tasks completed and failed; 1 task is claimed and waiting on
      // the per-minute window — its status is 'processing' because the
      // worker has already called `claimNextTask` for it.
      const jobsBefore = await ws.storage.findResumableParseJob({
        source: "2gis",
        city: "moscow",
        category: "autoservice"
      });
      expect(jobsBefore).toBeDefined();
      const partialTasks = await ws.storage.listCompanyTasks(jobsBefore!.id);
      const partialFailed = partialTasks.filter((t) => t.status === "failed").length;
      const partialProcessing = partialTasks.filter((t) => t.status === "processing").length;
      expect(partialFailed).toBe(2);
      expect(partialProcessing).toBe(1);

      // Advance past the 60s window so the 3rd request can fire.
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await promise;
      const finalTasks = await ws.storage.listCompanyTasks(result.jobId);
      expect(finalTasks.filter((t) => t.status === "failed")).toHaveLength(3);
      expect(result.leads).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("max_cards_per_proxy: worker exits cleanly when rotation cannot lower cardsOnIp", async () => {
    const cards = [makeCard("c1"), makeCard("c2"), makeCard("c3")];
    const adapter = new FakeAdapter({ cards });
    const registry = new AdapterRegistry();
    registry.register(adapter);

    // Stuck rotator — never reduces cardsOnIp (simulates a real rotator
    // whose proxy API keeps returning the same over-burdened proxy or
    // fails outright). Without the MAX_PROXY_ROTATION_ATTEMPTS guard the
    // worker would loop forever.
    const rotateMock = vi.fn(async (_reason: string) => {
      // No-op: cardsOnIp stays at 5.
    });
    const rotator = {
      getCurrentState: (): ProxyRuntimeState => ({
        proxy: "http://rotator.test:8080",
        proxyChannel: "ch-stuck",
        ip: "1.2.3.4",
        cardsOnIp: 5
      }),
      tick: vi.fn(async () => {}),
      rotate: rotateMock
    } as unknown as ProxyRotator;

    const manager = new JobManager(
      withPolicy({ maxCardsPerProxy: 3 }),
      registry,
      ws.storage,
      rotator,
      { backoff: { baseMs: 1, capMs: 2, jitter: 0 }, emptyPollMs: 5 }
    );

    // Run completes (does not hang) — workers exit after the rotation
    // overflow error is caught in `runWorker`.
    const result = await manager.run();

    expect(result.leads).toHaveLength(0);
    const tasks = await ws.storage.listCompanyTasks(result.jobId);
    // No lead was ever produced. One task is left in 'processing' (the
    // one the worker claimed before the rotation overflow) — its lease
    // will be recovered on the next run by `recoverExpiredLeases`. The
    // other two were never claimed and stay 'pending'.
    const pending = tasks.filter((t) => t.status === "pending").length;
    const processing = tasks.filter((t) => t.status === "processing").length;
    expect(pending + processing).toBe(3);
    expect(processing).toBeGreaterThanOrEqual(1);
    // The limiter tried exactly MAX_PROXY_ROTATION_ATTEMPTS rotations
    // before giving up.
    expect(rotateMock).toHaveBeenCalledTimes(5);
    expect(rotateMock.mock.calls.every((c) => c[0] === "cards_per_proxy_cap")).toBe(true);
  });

  it("max_session_duration: recheck after waitForCardStart prevents late starts", async () => {
    // Set up a scenario where the per-minute wait would naturally run
    // *past* the session-duration cap. The worker must not start the
    // card once the duration has been exceeded, even if the per-minute
    // gate has just opened.
    vi.useFakeTimers();
    try {
      const cards = [makeCard("c1"), makeCard("c2")];
      const adapter = new FakeAdapter({ cards });
      const registry = new AdapterRegistry();
      registry.register(adapter);

      const manager = new JobManager(
        withPolicy({ maxSessionDurationMs: 100, maxCardsPerMinute: 1 }),
        registry,
        ws.storage,
        undefined,
        { backoff: { baseMs: 1, capMs: 2, jitter: 0 }, emptyPollMs: 5 }
      );

      const promise = manager.run();

      // Card 1 starts at t=0, completes very quickly. The 2nd card is
      // claimed shortly after, then waitForCardStart blocks for ~60s
      // (the per-minute window) because card 1's start is still in it.
      await vi.advanceTimersByTimeAsync(200);

      // Advance past the 60s window. The per-minute gate opens, but the
      // session duration (100ms) has long since passed — the recheck
      // must catch this and the worker must exit without starting c2.
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await promise;
      expect(result.leads).toHaveLength(1);
      const c2 = (await ws.storage.listCompanyTasks(result.jobId)).find(
        (t) => t.external_id === "c2"
      );
      // c2 was claimed before the recheck, so its status is 'processing'
      // (a lease-recovery concern, not a rate-limit concern). The key
      // invariant is that no lead was produced for c2.
      expect(c2).toBeDefined();
      expect(result.leads.find((l) => l.external_id === "c2")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("max_cards_per_minute: concurrency > 1 — cap is not exceeded in the first 60s window", async () => {
    // Concurrency > 1 stress test for the per-minute card-start budget.
    // With the old separate wait+record design, the `await` inside
    // waitForCardStart created a microtask boundary that let all N
    // workers pass the empty-window check before any of them recorded,
    // overshooting the cap. With the atomic check+reserve in
    // acquireCardStart, only `cap` cards start in the first 60s window.
    vi.useFakeTimers();
    try {
      // 6 cards, concurrency 3, cap 2 per minute. Each card takes ~10ms
      // + jitter to process — fast enough that 3 workers are all
      // contending for the cap at t=0.
      const cards = Array.from({ length: 6 }, (_, i) => makeCard(`c${i + 1}`));
      const adapter = new FakeAdapter({ cards, delayMs: 10 });
      const registry = new AdapterRegistry();
      registry.register(adapter);

      const config: RuntimeConfig = {
        ...ws.config,
        concurrency: 3,
        rateLimit: { maxCardsPerMinute: 2 }
      };
      const manager = new JobManager(config, registry, ws.storage, undefined, {
        backoff: { baseMs: 1, capMs: 2, jitter: 0 },
        emptyPollMs: 5
      });

      const promise = manager.run();

      // Let the first batch process. With the atomic check+reserve only 2
      // cards can start; the 3rd worker parks on the per-minute window.
      await vi.advanceTimersByTimeAsync(500);

      // At t=500ms (within the first 60s window), exactly 2 leads should
      // exist. The 3rd card is in 'processing' state (claimed) but is
      // blocked on the per-minute window.
      const midLeads = await ws.storage.listLeads();
      expect(midLeads).toHaveLength(2);

      // Advance past the 60s window repeatedly so the remaining 4 cards
      // can each start as room opens up.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS * 3);

      const result = await promise;
      expect(result.leads).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("max_requests_per_minute_per_proxy: concurrency > 1 — request cap is not exceeded for a proxy bucket", async () => {
    // Concurrency > 1 stress test for the per-proxy request budget. Each
    // card makes 2 requests (getCardDetail + getContacts). With the old
    // separate wait+record design, the `await` inside waitForRequest
    // created a microtask boundary that let multiple workers pass the
    // empty-bucket check before any of them recorded, overshooting the
    // cap. With the atomic check+reserve in acquireRequest, only `cap`
    // requests fire in the first 60s window.
    vi.useFakeTimers();
    try {
      const cards = Array.from({ length: 6 }, (_, i) => makeCard(`c${i + 1}`));
      const adapter = new FakeAdapter({ cards, delayMs: 10 });
      const registry = new AdapterRegistry();
      registry.register(adapter);

      const rotator = {
        getCurrentState: (): ProxyRuntimeState => ({
          proxy: "http://rotator.test:8080",
          proxyChannel: "ch-budget",
          ip: "1.2.3.4",
          cardsOnIp: 0
        }),
        tick: vi.fn(async () => {}),
        rotate: vi.fn(async (_reason: string) => {})
      } as unknown as ProxyRotator;

      // cap=4 lets exactly 4 requests fire in the first 60s window: the
      // 3 workers' detail requests (1, 2, 3) plus Worker 1's contacts
      // request (4). The other 2 workers' contacts are blocked because
      // the bucket is now at 4/4. Worker 1 completes its card → 1 lead;
      // workers 2 and 3 are blocked on contacts and produce no leads.
      const config: RuntimeConfig = {
        ...ws.config,
        concurrency: 3,
        rateLimit: { maxRequestsPerMinutePerProxy: 4 }
      };
      const manager = new JobManager(config, registry, ws.storage, rotator, {
        backoff: { baseMs: 1, capMs: 2, jitter: 0 },
        emptyPollMs: 5
      });

      const promise = manager.run();

      await vi.advanceTimersByTimeAsync(500);

      // At t=500ms, exactly 1 lead should exist (Worker 1 finished its
      // card). With the old separate wait+record design, all 3 workers
      // would have completed their cards (6 requests, overshoot by 2) →
      // 3 leads. The atomic check+reserve keeps the bucket at 4/4.
      const midLeads = await ws.storage.listLeads();
      expect(midLeads).toHaveLength(1);

      // Advance past the 60s window repeatedly so the remaining 4 cards
      // (8 requests) can complete as the bucket slides.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS * 3);

      const result = await promise;
      expect(result.leads).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

    it("max_requests_per_minute_per_proxy: concurrency > 1 — failed request still consumes a reserved slot", async () => {
      // Concurrency > 1 stress test for the "failed request still consumes
      // a slot" invariant. With the old separate wait+record design, the
      // record happened in `finally` after the adapter call, but the gap
      // between the wait and the record let multiple workers pass the
      // empty-bucket check before any of them recorded. The atomic
      // acquireRequest closes that gap: the slot is reserved *before* the
      // adapter call, so a throw still consumes the slot.
      vi.useFakeTimers();
      try {
      const cards = Array.from({ length: 3 }, (_, i) => makeCard(`c${i + 1}`));

      // Every card fails on getCardDetail. With maxRetries=0 each card
      // contributes exactly one request (detail) before going
      // terminal-failed. The contacts call is never reached.
      const failOn = new Map<string, () => Error>();
      for (const c of cards) failOn.set(c.externalId, () => new Error("HTTP 500 boom"));

      const adapter = new FakeAdapter({ cards, failOn });
      const registry = new AdapterRegistry();
      registry.register(adapter);

      // cap=2 with concurrency=3: 2 requests fire immediately and fail
      // (slot consumed), the 3rd parks on the bucket. The other 2
      // workers have no more tasks to claim after the first 2 fail.
      const config: RuntimeConfig = {
        ...ws.config,
        concurrency: 3,
        maxRetries: 0,
        rateLimit: { maxRequestsPerMinutePerProxy: 2 }
      };
      const manager = new JobManager(config, registry, ws.storage, undefined, {
        backoff: { baseMs: 1, capMs: 2, jitter: 0 },
        emptyPollMs: 5
      });

      const promise = manager.run();

      await vi.advanceTimersByTimeAsync(500);

      const jobsBefore = await ws.storage.findResumableParseJob({
        source: "2gis",
        city: "moscow",
        category: "autoservice"
      });
      expect(jobsBefore).toBeDefined();
      const partialTasks = await ws.storage.listCompanyTasks(jobsBefore!.id);
      // 2 cards failed (the 2 whose requests fired), 1 card is claimed
      // and waiting on the per-minute window.
      expect(partialTasks.filter((t) => t.status === "failed")).toHaveLength(2);
      expect(partialTasks.filter((t) => t.status === "processing")).toHaveLength(1);

      // Advance past the 60s window so the 3rd request can fire.
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await promise;
      const finalTasks = await ws.storage.listCompanyTasks(result.jobId);
      // The 3rd card finishes failing. With maxRetries=0 and only 3
      // cards, all 3 cards eventually attempt and fail.
      expect(finalTasks.filter((t) => t.status === "failed")).toHaveLength(3);
      expect(result.leads).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
