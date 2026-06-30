import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Storage } from "../src/storage/storage.js";

function makeStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-tel-"));
  const dbPath = path.join(dir, "test.db");
  const storage = new Storage(dbPath);
  const db = (storage as unknown as { db: Database.Database }).db;
  return {
    storage,
    db,
    cleanup: () => {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("getJobTelemetry", () => {
  let storage: Storage;
  let db: Database.Database;
  let cleanup: () => void;
  let parseJobId: string;

  beforeEach(async () => {
    ({ storage, db, cleanup } = makeStorage());
    parseJobId = await storage.createParseJob({ source: "2gis", city: "moscow", category: "test" });
  });
  afterEach(() => cleanup());

  it("returns zero rates and null timings for a job with only pending tasks", async () => {
    await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: "ext-1" });
    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.success_rate).toBe(0);
    expect(t.partial_rate).toBe(0);
    expect(t.failed_rate).toBe(0);
    expect(t.terminal_count).toBe(0);
    expect(t.captcha_count).toBe(0);
    expect(t.ban_count).toBe(0);
    expect(t.proxy_rotation_count).toBe(0);
    expect(t.average_parse_time).toBeNull();
  });

  it("computes task rates from mixed terminal statuses", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: `ext-${i}` }));
    }
    // 2 success, 1 partial, 1 failed, 1 blocked
    db.prepare("UPDATE company_tasks SET status = 'success' WHERE id IN (?, ?)").run(ids[0], ids[1]);
    db.prepare("UPDATE company_tasks SET status = 'partial' WHERE id = ?").run(ids[2]);
    db.prepare("UPDATE company_tasks SET status = 'failed'  WHERE id = ?").run(ids[3]);
    db.prepare("UPDATE company_tasks SET status = 'blocked' WHERE id = ?").run(ids[4]);

    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.terminal_count).toBe(5);
    expect(t.success_rate).toBeCloseTo(2 / 5);
    expect(t.partial_rate).toBeCloseTo(1 / 5);
    expect(t.failed_rate).toBeCloseTo(2 / 5); // failed + blocked
    // rates must sum to 1
    expect(t.success_rate + t.partial_rate + t.failed_rate).toBeCloseTo(1);
  });

  it("counts captcha events only from this job's tasks", async () => {
    const taskId = await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: "ext-1" });

    const otherJobId = await storage.createParseJob({ source: "2gis", city: "spb", category: "test" });
    const otherTaskId = await storage.enqueueCompanyTask({ parseJobId: otherJobId, source: "2gis", externalId: "ext-x" });

    await storage.saveCaptchaEvent({ source: "2gis", action: "detected", companyTaskId: taskId });
    await storage.saveCaptchaEvent({ source: "2gis", action: "rotated",  companyTaskId: taskId });
    // Other job's event — must not be counted.
    await storage.saveCaptchaEvent({ source: "2gis", action: "detected", companyTaskId: otherTaskId });

    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.captcha_count).toBe(2);
  });

  it("ban_count covers result='blocked' and error_type='blocked', not plain failures", async () => {
    const taskId = await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: "ext-1" });
    // result='blocked' → counted
    await storage.saveAttempt({ source: "2gis", externalId: "ext-1", status: "blocked", companyTaskId: taskId });
    // error_type='blocked' with a different result → also counted
    await storage.saveAttempt({ source: "2gis", externalId: "ext-1", status: "error", errorType: "blocked", companyTaskId: taskId });
    // plain failure — must not be counted
    await storage.saveAttempt({ source: "2gis", externalId: "ext-1", status: "failed", companyTaskId: taskId });
    // success — must not be counted
    await storage.saveAttempt({ source: "2gis", externalId: "ext-1", status: "success", companyTaskId: taskId });

    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.ban_count).toBe(2);
  });

  it("counts proxy rotations within the job time window only", async () => {
    const start = "2026-06-01T10:00:00.000Z";
    const end   = "2026-06-01T11:00:00.000Z";
    db.prepare("UPDATE parse_jobs SET created_at = ?, finished_at = ? WHERE id = ?")
      .run(start, end, parseJobId);

    // Inside window.
    db.prepare("INSERT INTO proxy_history (reason, created_at) VALUES (?, ?)").run("N_cards", "2026-06-01T10:30:00.000Z");
    db.prepare("INSERT INTO proxy_history (reason, created_at) VALUES (?, ?)").run("N_cards", "2026-06-01T10:59:00.000Z");
    // On the boundary (inclusive >=, <=): start is included.
    db.prepare("INSERT INTO proxy_history (reason, created_at) VALUES (?, ?)").run("N_cards", start);
    // Outside window.
    db.prepare("INSERT INTO proxy_history (reason, created_at) VALUES (?, ?)").run("N_cards", "2026-06-01T09:59:59.000Z");
    db.prepare("INSERT INTO proxy_history (reason, created_at) VALUES (?, ?)").run("N_cards", "2026-06-01T11:01:00.000Z");

    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.proxy_rotation_count).toBe(3);
  });

  it("computes average_parse_time from non-null durations only", async () => {
    const taskId = await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: "ext-1" });
    await storage.saveAttempt({ source: "2gis", externalId: "ext-1", status: "success", companyTaskId: taskId, durationMs: 100 });
    await storage.saveAttempt({ source: "2gis", externalId: "ext-1", status: "error",   companyTaskId: taskId, durationMs: 200 });
    // No durationMs — excluded from average.
    await storage.saveAttempt({ source: "2gis", externalId: "ext-1", status: "failed",  companyTaskId: taskId });

    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.average_parse_time).toBeCloseTo(150);
  });

  it("returns null average_parse_time when no attempts carry a duration", async () => {
    const taskId = await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: "ext-1" });
    await storage.saveAttempt({ source: "2gis", externalId: "ext-1", status: "failed", companyTaskId: taskId });

    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.average_parse_time).toBeNull();
  });

  it("computes cards_per_hour from total task count and elapsed hours", async () => {
    const start = "2026-06-01T10:00:00.000Z";
    const end   = "2026-06-01T12:00:00.000Z"; // 2 h
    db.prepare("UPDATE parse_jobs SET created_at = ?, finished_at = ? WHERE id = ?")
      .run(start, end, parseJobId);

    for (let i = 0; i < 4; i++) {
      await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: `ext-${i}` });
    }

    const t = await storage.getJobTelemetry(parseJobId);
    // 4 tasks / 2 hours = 2 cards/hour
    expect(t.cards_per_hour).toBeCloseTo(2);
  });

  it("returns null cards_per_hour when start == end (zero elapsed time)", async () => {
    const now = "2026-06-01T10:00:00.000Z";
    db.prepare("UPDATE parse_jobs SET created_at = ?, finished_at = ? WHERE id = ?")
      .run(now, now, parseJobId);
    await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: "ext-1" });

    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.cards_per_hour).toBeNull();
  });

  it("isolates all metrics per job — another job's data does not bleed in", async () => {
    const taskId = await storage.enqueueCompanyTask({ parseJobId, source: "2gis", externalId: "ext-1" });
    db.prepare("UPDATE company_tasks SET status = 'success' WHERE id = ?").run(taskId);

    const otherJobId = await storage.createParseJob({ source: "2gis", city: "spb", category: "test" });
    const otherTaskId = await storage.enqueueCompanyTask({ parseJobId: otherJobId, source: "2gis", externalId: "ext-x" });
    db.prepare("UPDATE company_tasks SET status = 'failed' WHERE id = ?").run(otherTaskId);
    await storage.saveAttempt({ source: "2gis", status: "blocked", companyTaskId: otherTaskId });
    await storage.saveCaptchaEvent({ source: "2gis", action: "detected", companyTaskId: otherTaskId });

    const t = await storage.getJobTelemetry(parseJobId);
    expect(t.terminal_count).toBe(1);
    expect(t.success_rate).toBe(1);
    expect(t.failed_rate).toBe(0);
    expect(t.ban_count).toBe(0);
    expect(t.captcha_count).toBe(0);
  });

  it("handles an unknown parseJobId gracefully — all zeros / nulls", async () => {
    const t = await storage.getJobTelemetry("nonexistent-job-id");
    expect(t.terminal_count).toBe(0);
    expect(t.success_rate).toBe(0);
    expect(t.captcha_count).toBe(0);
    expect(t.ban_count).toBe(0);
    expect(t.proxy_rotation_count).toBe(0);
    expect(t.average_parse_time).toBeNull();
    expect(t.cards_per_hour).toBeNull();
  });
});
