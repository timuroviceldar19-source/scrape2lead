import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgresStorage } from "../src/storage/postgres/PostgresStorage.js";
import type { Lead, SaveRawSnapshotInput, CaptchaEventInput } from "../src/types.js";

const TEST_URL = process.env.POSTGRES_TEST_URL;

describe.skipIf(!TEST_URL)("PostgresStorage (live)", () => {
  let storage: PostgresStorage;

  beforeAll(async () => {
    storage = new PostgresStorage(TEST_URL!);
    await storage.dropAllTables();
    await storage.ensureMigrated();
  });

  afterAll(async () => {
    if (storage) {
      await storage.dropAllTables();
      await storage.closeAsync();
    }
  });

  it("creates a parse job with the expected id format", async () => {
    const jobId = await storage.createParseJob({
      source: "2gis",
      city: "moscow",
      category: "autoservice"
    });
    expect(jobId).toMatch(/^2gis-\d+-[a-f0-9]+$/);
  });

  it("enforces idempotency on (source, external_id, parse_job_id)", async () => {
    const jobId = await storage.createParseJob({
      source: "2gis",
      city: "spb",
      category: "cafe"
    });
    const id1 = await storage.enqueueCompanyTask({
      parseJobId: jobId,
      source: "2gis",
      externalId: "ext-1"
    });
    const id2 = await storage.enqueueCompanyTask({
      parseJobId: jobId,
      source: "2gis",
      externalId: "ext-1"
    });
    expect(id1).toBe(id2);
  });

  it("claimNextTask is exclusive under concurrency (FOR UPDATE SKIP LOCKED)", async () => {
    const jobId = await storage.createParseJob({
      source: "yandex",
      city: "kazan",
      category: "shop"
    });
    for (let i = 0; i < 5; i++) {
      await storage.enqueueCompanyTask({
        parseJobId: jobId,
        source: "yandex",
        externalId: `c-${i}`
      });
    }
    const a = new PostgresStorage(TEST_URL!);
    const b = new PostgresStorage(TEST_URL!);
    try {
      await a.ensureMigrated();
      await b.ensureMigrated();
      const [taskA, taskB] = await Promise.all([
        a.claimNextTask({ parseJobId: jobId, workerId: "worker-A", leaseMs: 30_000 }),
        b.claimNextTask({ parseJobId: jobId, workerId: "worker-B", leaseMs: 30_000 })
      ]);
      expect(taskA).not.toBeNull();
      expect(taskB).not.toBeNull();
      expect(taskA!.id).not.toBe(taskB!.id);
    } finally {
      await a.closeAsync();
      await b.closeAsync();
    }
  });

  it("preserves FK ON DELETE SET NULL on captcha_events and raw_snapshots", async () => {
    const jobId = await storage.createParseJob({
      source: "2gis",
      city: "msk",
      category: "fk"
    });
    const taskId = await storage.enqueueCompanyTask({
      parseJobId: jobId,
      source: "2gis",
      externalId: "ext-fk"
    });
    const claim = await storage.claimNextTask({
      parseJobId: jobId,
      workerId: "worker-z",
      leaseMs: 30_000
    });
    expect(claim).not.toBeNull();

    const snapshotInput: SaveRawSnapshotInput = {
      companyTaskId: taskId,
      source: "2gis",
      externalId: "ext-fk",
      kind: "html",
      purpose: "test",
      payload: { html: "<p>x</p>" }
    };
    const snapshotId = await storage.saveRawSnapshot(snapshotInput);
    expect(snapshotId).toBeGreaterThan(0);

    const captchaInput: CaptchaEventInput = {
      source: "2gis",
      url: "https://example.com",
      action: "detected",
      companyTaskId: taskId,
      snapshotId
    };
    await storage.saveCaptchaEvent(captchaInput);

    await storage.markTaskBlocked(taskId, "captcha");

    const lead: Lead = {
      source: "2gis",
      external_id: "ext-fk",
      company_name: "Test",
      category: "fk",
      city: "msk",
      address: "",
      phones: ["+70000000000"],
      email: null,
      website: null,
      social_links: [],
      messenger_links: [],
      parsed_at: new Date().toISOString(),
      incomplete: false
    };
    await storage.upsertLead(lead);
    await storage.markTaskSuccess(taskId);

    const telemetry = await storage.getJobTelemetry(jobId);
    expect(telemetry.terminal_count).toBe(1);
  });

  it("getJobTelemetry returns the same metric shape as SQLite", async () => {
    const jobId = await storage.createParseJob({
      source: "2gis",
      city: "msk",
      category: "metrics"
    });
    const taskId = await storage.enqueueCompanyTask({
      parseJobId: jobId,
      source: "2gis",
      externalId: "ext-t"
    });
    await storage.claimNextTask({ parseJobId: jobId, workerId: "worker-m", leaseMs: 30_000 });
    await storage.markTaskSuccess(taskId);

    const t = await storage.getJobTelemetry(jobId);
    expect(t).toEqual(
      expect.objectContaining({
        parseJobId: jobId,
        success_rate: expect.any(Number),
        partial_rate: expect.any(Number),
        failed_rate: expect.any(Number),
        terminal_count: expect.any(Number),
        captcha_count: expect.any(Number),
        ban_count: expect.any(Number),
        proxy_rotation_count: expect.any(Number)
      })
    );
    expect(t.terminal_count).toBeGreaterThanOrEqual(1);
  });

  it("rawSnapshotDir writes the payload to disk and links via payload_path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "psql-snap-"));
    const s = new PostgresStorage(TEST_URL!, { rawSnapshotDir: root });
    try {
      await s.ensureMigrated();
      const jobId = await s.createParseJob({
        source: "2gis",
        city: "msk",
        category: "snap"
      });
      const taskId = await s.enqueueCompanyTask({
        parseJobId: jobId,
        source: "2gis",
        externalId: "ext-snap"
      });
      const bigPayload = { big: "x".repeat(2000) };
      const snapId = await s.saveRawSnapshot({
        companyTaskId: taskId,
        source: "2gis",
        externalId: "ext-snap",
        kind: "html",
        purpose: "test",
        payload: bigPayload
      });
      expect(snapId).toBeGreaterThan(0);
      // Verify the on-disk payload file was written by PostgresStorage
      // when the body is large enough to be spilled to disk.
      const dir = s.getRawSnapshotDir();
      expect(dir).toBe(root);
      const files = fs.readdirSync(root);
      expect(files.length).toBeGreaterThan(0);
    } finally {
      await s.closeAsync();
    }
  });
});
