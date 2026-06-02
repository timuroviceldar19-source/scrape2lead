import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Storage } from "../src/storage/storage.js";

function makeStorage(): { storage: Storage; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-queue-"));
  const dbPath = path.join(dir, "test.db");
  return { storage: new Storage(dbPath), dbPath };
}

describe("queue / state layer", () => {
  let storage: Storage;
  let dbPath: string;
  let jobId: string;

  beforeEach(() => {
    ({ storage, dbPath } = makeStorage());
    jobId = storage.createParseJob({ source: "2gis", city: "moscow", category: "autoservice" });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("enqueueCompanyTask is idempotent on (source, external_id, parse_job_id)", () => {
    const a = storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-1" });
    const b = storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-1" });
    expect(a).toBe(b);
    expect(storage.listCompanyTasks(jobId)).toHaveLength(1);

    const otherJob = storage.createParseJob({ source: "2gis", city: "spb", category: "autoservice" });
    const c = storage.enqueueCompanyTask({ parseJobId: otherJob, source: "2gis", externalId: "ext-1" });
    expect(c).not.toBe(a);
    expect(storage.listCompanyTasks(otherJob)).toHaveLength(1);
  });

  it("claimNextTask is exclusive between concurrent claimants", () => {
    storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-1" });
    storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-2" });

    const first = storage.claimNextTask({ parseJobId: jobId, workerId: "w-1", leaseMs: 30_000 });
    const second = storage.claimNextTask({ parseJobId: jobId, workerId: "w-2", leaseMs: 30_000 });
    const third = storage.claimNextTask({ parseJobId: jobId, workerId: "w-3", leaseMs: 30_000 });

    expect(first?.external_id).toBe("ext-1");
    expect(first?.status).toBe("processing");
    expect(first?.worker_id).toBe("w-1");
    expect(first?.attempts).toBe(1);

    expect(second?.external_id).toBe("ext-2");
    expect(second?.worker_id).toBe("w-2");

    expect(third).toBeNull();
  });

  it("recoverExpiredLeases moves stale processing tasks back to retry_scheduled", () => {
    const taskId = storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-1" });
    const claimed = storage.claimNextTask({ parseJobId: jobId, workerId: "w-dead", leaseMs: 30_000 });
    expect(claimed?.id).toBe(taskId);

    // Simulate expired lease by rewinding lease_until into the past.
    const db = (storage as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE company_tasks SET lease_until = ? WHERE id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      taskId
    );

    const recovered = storage.recoverExpiredLeases();
    expect(recovered).toBe(1);
    const row = storage.getCompanyTask(taskId);
    expect(row?.status).toBe("retry_scheduled");
    expect(row?.worker_id).toBeNull();
    expect(row?.lease_until).toBeNull();
    expect(row?.next_run_at).not.toBeNull();

    const reclaimed = storage.claimNextTask({ parseJobId: jobId, workerId: "w-alive", leaseMs: 30_000 });
    expect(reclaimed?.id).toBe(taskId);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("scheduleTaskRetry transitions processing→retry_scheduled and respects next_run_at", () => {
    const taskId = storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-1" });
    const claimed = storage.claimNextTask({ parseJobId: jobId, workerId: "w-1", leaseMs: 30_000 });
    expect(claimed?.id).toBe(taskId);

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(storage.scheduleTaskRetry(taskId, "network timeout", future)).toBe(true);

    let row = storage.getCompanyTask(taskId);
    expect(row?.status).toBe("retry_scheduled");
    expect(row?.last_error).toBe("network timeout");
    expect(row?.next_run_at).toBe(future);

    // next_run_at is in the future → should not be claimable.
    expect(storage.claimNextTask({ parseJobId: jobId, workerId: "w-2", leaseMs: 30_000 })).toBeNull();

    // Move it to the past and reclaim.
    const past = new Date(Date.now() - 1000).toISOString();
    expect(storage.scheduleTaskRetry(taskId, "network timeout", past)).toBe(false); // not in 'processing'

    (storage as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("UPDATE company_tasks SET next_run_at = ? WHERE id = ?")
      .run(past, taskId);
    const reclaimed = storage.claimNextTask({ parseJobId: jobId, workerId: "w-2", leaseMs: 30_000 });
    expect(reclaimed?.id).toBe(taskId);
    expect(reclaimed?.attempts).toBe(2);

    row = storage.getCompanyTask(taskId);
    expect(row?.worker_id).toBe("w-2");
  });

  it("terminal transitions are one-way and idempotent", () => {
    const taskId = storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-1" });
    storage.claimNextTask({ parseJobId: jobId, workerId: "w-1", leaseMs: 30_000 });

    expect(storage.markTaskSuccess(taskId)).toBe(true);
    expect(storage.getCompanyTask(taskId)?.status).toBe("success");

    // Re-applying success or any other terminal/state change is a no-op.
    expect(storage.markTaskSuccess(taskId)).toBe(false);
    expect(storage.markTaskFailed(taskId, "late failure")).toBe(false);
    expect(storage.markTaskPartial(taskId)).toBe(false);
    expect(storage.markTaskBlocked(taskId, "late block")).toBe(false);
    expect(
      storage.scheduleTaskRetry(taskId, "late retry", new Date().toISOString())
    ).toBe(false);

    const row = storage.getCompanyTask(taskId);
    expect(row?.status).toBe("success");
    expect(row?.last_error).toBeNull();

    // Terminal task is invisible to the claim query.
    expect(storage.claimNextTask({ parseJobId: jobId, workerId: "w-x", leaseMs: 30_000 })).toBeNull();
  });

  it("findResumableParseJob returns the most recent non-terminal match", () => {
    expect(
      storage.findResumableParseJob({ source: "2gis", city: "moscow", category: "autoservice" })?.id
    ).toBe(jobId);

    // Different triple → no match.
    expect(
      storage.findResumableParseJob({ source: "2gis", city: "spb", category: "autoservice" })
    ).toBeNull();

    // Terminal jobs are excluded.
    storage.setParseJobStatus(jobId, "completed");
    expect(
      storage.findResumableParseJob({ source: "2gis", city: "moscow", category: "autoservice" })
    ).toBeNull();

    // A new non-terminal job for the same triple is picked up.
    const newer = storage.createParseJob({ source: "2gis", city: "moscow", category: "autoservice" });
    expect(
      storage.findResumableParseJob({ source: "2gis", city: "moscow", category: "autoservice" })?.id
    ).toBe(newer);
  });

  it("finalizeParseJob reflects task outcomes", () => {
    const aId = storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-a" });
    const bId = storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-b" });

    storage.claimNextTask({ parseJobId: jobId, workerId: "w-1", leaseMs: 30_000 });
    storage.markTaskSuccess(aId);
    storage.claimNextTask({ parseJobId: jobId, workerId: "w-1", leaseMs: 30_000 });
    storage.markTaskFailed(bId, "boom");

    // Mixed → completed (at least one success).
    expect(storage.finalizeParseJob(jobId)).toBe("completed");
    expect(storage.getParseJob(jobId)?.status).toBe("completed");
    expect(storage.getParseJob(jobId)?.finished_at).not.toBeNull();

    // All-failed → failed.
    const failedJob = storage.createParseJob({ source: "2gis", city: "kazan", category: "autoservice" });
    const cId = storage.enqueueCompanyTask({ parseJobId: failedJob, source: "2gis", externalId: "ext-c" });
    storage.claimNextTask({ parseJobId: failedJob, workerId: "w-1", leaseMs: 30_000 });
    storage.markTaskFailed(cId, "boom");
    expect(storage.finalizeParseJob(failedJob)).toBe("failed");
    expect(storage.getParseJob(failedJob)?.status).toBe("failed");
  });

  it("blocked tasks can be moved into retry_scheduled (post-rotation)", () => {
    const taskId = storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-1" });
    storage.claimNextTask({ parseJobId: jobId, workerId: "w-1", leaseMs: 30_000 });
    expect(storage.markTaskBlocked(taskId, "HTTP 429")).toBe(true);
    expect(storage.getCompanyTask(taskId)?.status).toBe("blocked");

    const past = new Date(Date.now() - 1000).toISOString();
    expect(storage.scheduleTaskRetry(taskId, "HTTP 429", past)).toBe(true);
    expect(storage.getCompanyTask(taskId)?.status).toBe("retry_scheduled");

    const reclaimed = storage.claimNextTask({ parseJobId: jobId, workerId: "w-2", leaseMs: 30_000 });
    expect(reclaimed?.id).toBe(taskId);
  });
});
