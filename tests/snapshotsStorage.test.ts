import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Storage } from "../src/storage/storage.js";

interface ColumnInfo {
  name: string;
  notnull: number;
  type: string;
}

function makeStorage(): { storage: Storage; dbPath: string; db: Database.Database } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-snap-"));
  const dbPath = path.join(dir, "test.db");
  const storage = new Storage(dbPath);
  const db = (storage as unknown as { db: Database.Database }).db;
  return { storage, dbPath, db };
}

function tableColumns(db: Database.Database, table: string): Map<string, ColumnInfo> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return new Map(rows.map((r) => [r.name, r]));
}

describe("storage migration v3 shape", () => {
  let storage: Storage;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    ({ storage, dbPath, db } = makeStorage());
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("parse_attempts: job_id is nullable, result column exists, company_task_id is the FK", () => {
    const cols = tableColumns(db, "parse_attempts");
    expect(cols.has("result")).toBe(true);
    expect(cols.has("company_task_id")).toBe(true);
    expect(cols.has("attempt_no")).toBe(true);
    expect(cols.has("error_type")).toBe(true);
    expect(cols.has("proxy_id")).toBe(true);
    expect(cols.has("duration_ms")).toBe(true);

    // status column was renamed → must not exist any longer.
    expect(cols.has("status")).toBe(false);

    // job_id must be nullable now.
    expect(cols.get("job_id")?.notnull).toBe(0);

    // result must still be required.
    expect(cols.get("result")?.notnull).toBe(1);

    const fks = db.prepare("PRAGMA foreign_key_list(parse_attempts)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const taskFk = fks.find((fk) => fk.table === "company_tasks");
    expect(taskFk).toBeDefined();
    expect(taskFk?.from).toBe("company_task_id");
    expect(taskFk?.on_delete).toBe("SET NULL");
  });

  it("raw_snapshots: required columns and indexes exist", () => {
    const cols = tableColumns(db, "raw_snapshots");
    for (const name of [
      "snapshot_id",
      "company_task_id",
      "source",
      "external_id",
      "kind",
      "purpose",
      "payload",
      "payload_path",
      "created_at",
      "updated_at"
    ]) {
      expect(cols.has(name)).toBe(true);
    }
    const fks = db.prepare("PRAGMA foreign_key_list(raw_snapshots)").all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    const fk = fks.find((f) => f.table === "company_tasks");
    expect(fk?.from).toBe("company_task_id");
    expect(fk?.on_delete).toBe("SET NULL");

    const indexes = db.prepare("PRAGMA index_list(raw_snapshots)").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_raw_snapshots_purpose_time");
    expect(names).toContain("idx_raw_snapshots_task");
  });

  it("captcha_events gains company_task_id, proxy_id, snapshot_id with proper FKs", () => {
    const cols = tableColumns(db, "captcha_events");
    expect(cols.has("company_task_id")).toBe(true);
    expect(cols.has("proxy_id")).toBe(true);
    expect(cols.has("snapshot_id")).toBe(true);

    const fks = db.prepare("PRAGMA foreign_key_list(captcha_events)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;

    const taskFk = fks.find((fk) => fk.table === "company_tasks");
    expect(taskFk).toBeDefined();
    expect(taskFk?.from).toBe("company_task_id");
    expect(taskFk?.to).toBe("id");
    expect(taskFk?.on_delete).toBe("SET NULL");

    const snapFk = fks.find((fk) => fk.table === "raw_snapshots");
    expect(snapFk).toBeDefined();
    expect(snapFk?.from).toBe("snapshot_id");
    expect(snapFk?.to).toBe("snapshot_id");
    expect(snapFk?.on_delete).toBe("SET NULL");
  });

  it("proxy_history gains proxy_channel, ip, rotated_at, cards_on_ip", () => {
    const cols = tableColumns(db, "proxy_history");
    expect(cols.has("proxy_channel")).toBe(true);
    expect(cols.has("ip")).toBe(true);
    expect(cols.has("rotated_at")).toBe(true);
    expect(cols.has("cards_on_ip")).toBe(true);
  });
});

describe("raw_snapshots storage API", () => {
  let storage: Storage;
  let dbPath: string;
  let db: Database.Database;
  let parseJobId: string;
  let taskId: number;

  beforeEach(() => {
    ({ storage, dbPath, db } = makeStorage());
    parseJobId = storage.createParseJob({ source: "2gis", city: "moscow", category: "auto" });
    taskId = storage.enqueueCompanyTask({
      parseJobId,
      source: "2gis",
      externalId: "ext-1"
    });
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("saveRawSnapshot persists payload + metadata; listRawSnapshots filters", () => {
    const id = storage.saveRawSnapshot({
      companyTaskId: taskId,
      source: "2gis",
      externalId: "ext-1",
      kind: "json",
      purpose: "recent",
      payload: { hello: "world" }
    });
    const snap = storage.getRawSnapshot(id);
    expect(snap?.company_task_id).toBe(taskId);
    expect(snap?.kind).toBe("json");
    expect(snap?.purpose).toBe("recent");
    expect(JSON.parse(snap?.payload ?? "{}")).toEqual({ hello: "world" });
    expect(snap?.payload_path).toBeNull();
    expect(snap?.created_at).toEqual(snap?.updated_at);

    storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-2",
      kind: "html",
      purpose: "error",
      payloadPath: "/tmp/error-1.html"
    });

    const recents = storage.listRawSnapshots({ purpose: "recent" });
    expect(recents).toHaveLength(1);
    expect(recents[0].snapshot_id).toBe(id);

    const errors = storage.listRawSnapshots({ purpose: "error" });
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toBeNull();
    expect(errors[0].payload_path).toBe("/tmp/error-1.html");

    expect(storage.listRawSnapshots({ externalId: "ext-2" })).toHaveLength(1);
    expect(storage.listRawSnapshots({ companyTaskId: taskId })).toHaveLength(1);
    expect(storage.listRawSnapshots({ companyTaskId: null })).toHaveLength(1);
  });

  it("cleanupRecentSnapshots keeps newest N 'recent' rows, leaves others alone", () => {
    // Insert 5 'recent' snapshots with strictly increasing created_at to avoid ties.
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = storage.saveRawSnapshot({
        companyTaskId: taskId,
        source: "2gis",
        externalId: `ext-${i}`,
        kind: "json",
        purpose: "recent",
        payload: { i }
      });
      ids.push(id);
      db.prepare("UPDATE raw_snapshots SET created_at = ? WHERE snapshot_id = ?")
        .run(new Date(2026, 5, 1, 12, 0, i).toISOString(), id);
    }
    // And one error snapshot which must NOT be touched.
    const errorId = storage.saveRawSnapshot({
      source: "2gis",
      kind: "html",
      purpose: "error",
      payload: "<html/>"
    });
    db.prepare("UPDATE raw_snapshots SET created_at = ? WHERE snapshot_id = ?")
      .run(new Date(2020, 0, 1).toISOString(), errorId);

    const deleted = storage.cleanupRecentSnapshots({ maxEntries: 3 });
    expect(deleted).toBe(2);

    const remainingRecent = storage.listRawSnapshots({ purpose: "recent" });
    expect(remainingRecent.map((r) => r.snapshot_id).sort((a, b) => a - b)).toEqual(
      ids.slice(2).sort((a, b) => a - b)
    );

    // Error snapshot survives.
    expect(storage.getRawSnapshot(errorId)).not.toBeNull();

    // Running it again is a no-op.
    expect(storage.cleanupRecentSnapshots({ maxEntries: 3 })).toBe(0);

    // maxEntries=0 wipes all 'recent' rows but keeps other purposes.
    expect(storage.cleanupRecentSnapshots({ maxEntries: 0 })).toBe(3);
    expect(storage.listRawSnapshots({ purpose: "recent" })).toHaveLength(0);
    expect(storage.getRawSnapshot(errorId)).not.toBeNull();
  });

  it("cleanupSnapshotsOlderThan deletes by TTL with optional purpose filter", () => {
    const oldRecent = storage.saveRawSnapshot({
      source: "2gis",
      kind: "json",
      purpose: "recent",
      payload: { o: 1 }
    });
    const freshRecent = storage.saveRawSnapshot({
      source: "2gis",
      kind: "json",
      purpose: "recent",
      payload: { o: 2 }
    });
    const oldError = storage.saveRawSnapshot({
      source: "2gis",
      kind: "html",
      purpose: "error",
      payload: "<old/>"
    });

    const now = new Date("2026-06-01T12:00:00.000Z");
    db.prepare("UPDATE raw_snapshots SET created_at = ? WHERE snapshot_id = ?")
      .run("2026-05-01T00:00:00.000Z", oldRecent);
    db.prepare("UPDATE raw_snapshots SET created_at = ? WHERE snapshot_id = ?")
      .run("2026-06-01T11:59:00.000Z", freshRecent);
    db.prepare("UPDATE raw_snapshots SET created_at = ? WHERE snapshot_id = ?")
      .run("2026-05-01T00:00:00.000Z", oldError);

    // Only purge old 'recent' rows.
    const deleted = storage.cleanupSnapshotsOlderThan({
      purpose: "recent",
      olderThanMs: 24 * 60 * 60 * 1000,
      now
    });
    expect(deleted).toBe(1);
    expect(storage.getRawSnapshot(oldRecent)).toBeNull();
    expect(storage.getRawSnapshot(freshRecent)).not.toBeNull();
    expect(storage.getRawSnapshot(oldError)).not.toBeNull();

    // Now sweep across all purposes.
    const deletedAll = storage.cleanupSnapshotsOlderThan({
      olderThanMs: 24 * 60 * 60 * 1000,
      now
    });
    expect(deletedAll).toBe(1);
    expect(storage.getRawSnapshot(oldError)).toBeNull();
  });

  it("FK ON DELETE SET NULL nulls company_task_id when its task is deleted", () => {
    const snapId = storage.saveRawSnapshot({
      companyTaskId: taskId,
      source: "2gis",
      externalId: "ext-1",
      kind: "json",
      purpose: "recent",
      payload: { id: taskId }
    });
    db.prepare("DELETE FROM company_tasks WHERE id = ?").run(taskId);
    const snap = storage.getRawSnapshot(snapId);
    expect(snap).not.toBeNull();
    expect(snap?.company_task_id).toBeNull();
  });
});

describe("attempts, captcha, proxy compatibility", () => {
  let storage: Storage;
  let dbPath: string;
  let db: Database.Database;
  let parseJobId: string;
  let taskId: number;

  beforeEach(() => {
    ({ storage, dbPath, db } = makeStorage());
    parseJobId = storage.createParseJob({ source: "2gis", city: "moscow", category: "auto" });
    taskId = storage.enqueueCompanyTask({
      parseJobId,
      source: "2gis",
      externalId: "ext-1"
    });
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("saveAttempt writes without job_id and maps status onto result", () => {
    storage.saveAttempt({
      source: "2gis",
      externalId: "ext-1",
      status: "blocked",
      message: "HTTP 429",
      companyTaskId: taskId,
      attemptNo: 2,
      errorType: "blocked",
      proxyId: "ch-1",
      durationMs: 123
    });
    const row = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .get(taskId) as Record<string, unknown>;
    expect(row.result).toBe("blocked");
    expect(row.job_id).toBeNull();
    expect(row.message).toBe("HTTP 429");
    expect(row.attempt_no).toBe(2);
    expect(row.error_type).toBe("blocked");
    expect(row.proxy_id).toBe("ch-1");
    expect(row.duration_ms).toBe(123);
  });

  it("saveAttempt still accepts legacy callers passing jobId", () => {
    storage.saveAttempt({
      jobId: parseJobId,
      source: "2gis",
      externalId: "ext-1",
      status: "success",
      companyTaskId: taskId
    });
    const row = db
      .prepare("SELECT * FROM parse_attempts WHERE company_task_id = ?")
      .get(taskId) as { result: string; job_id: string };
    expect(row.result).toBe("success");
    expect(row.job_id).toBe(parseJobId);
  });

  it("saveRaw legacy wrapper still writes into raw_records (backwards compat)", () => {
    storage.saveRaw("2gis", "ext-1", "detail", { ok: 1 });
    const row = db
      .prepare("SELECT * FROM raw_records WHERE external_id = ?")
      .get("ext-1") as { kind: string; payload: string };
    expect(row.kind).toBe("detail");
    expect(JSON.parse(row.payload)).toEqual({ ok: 1 });

    // And the new snapshot table is NOT touched by the legacy method.
    expect(storage.listRawSnapshots()).toHaveLength(0);
  });

  it("saveCaptchaEvent persists task / proxy / snapshot references", () => {
    const snapshotId = storage.saveRawSnapshot({
      companyTaskId: taskId,
      source: "2gis",
      kind: "html",
      purpose: "captcha",
      payload: "<captcha/>"
    });
    const id = storage.saveCaptchaEvent({
      source: "2gis",
      action: "rotated",
      url: "https://2gis.ru/foo",
      screenshotPath: "/tmp/cap-1.png",
      companyTaskId: taskId,
      proxyId: "ch-1",
      snapshotId
    });
    const row = db
      .prepare("SELECT * FROM captcha_events WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.action).toBe("rotated");
    expect(row.company_task_id).toBe(taskId);
    expect(row.proxy_id).toBe("ch-1");
    expect(row.snapshot_id).toBe(snapshotId);
    expect(row.screenshot_path).toBe("/tmp/cap-1.png");
  });

  it("captcha_events: ON DELETE SET NULL nulls company_task_id and snapshot_id when referenced rows are deleted", () => {
    const snapshotId = storage.saveRawSnapshot({
      companyTaskId: taskId,
      source: "2gis",
      kind: "html",
      purpose: "captcha",
      payload: "<captcha/>"
    });
    const captchaId = storage.saveCaptchaEvent({
      source: "2gis",
      action: "detected",
      companyTaskId: taskId,
      snapshotId
    });

    // Verify both FKs are populated before deletion.
    const before = db.prepare("SELECT * FROM captcha_events WHERE id = ?").get(captchaId) as Record<string, unknown>;
    expect(before.company_task_id).toBe(taskId);
    expect(before.snapshot_id).toBe(snapshotId);

    // Delete the snapshot first; snapshot_id must become null.
    db.prepare("DELETE FROM raw_snapshots WHERE snapshot_id = ?").run(snapshotId);
    const afterSnap = db.prepare("SELECT * FROM captcha_events WHERE id = ?").get(captchaId) as Record<string, unknown>;
    expect(afterSnap.snapshot_id).toBeNull();
    expect(afterSnap.company_task_id).toBe(taskId);

    // Delete the task; company_task_id must become null.
    db.prepare("DELETE FROM company_tasks WHERE id = ?").run(taskId);
    const afterTask = db.prepare("SELECT * FROM captcha_events WHERE id = ?").get(captchaId) as Record<string, unknown>;
    expect(afterTask.company_task_id).toBeNull();

    // The captcha_event row itself must still exist.
    expect(afterTask.action).toBe("detected");
  });

  it("saveProxyRotation persists enriched columns; saveProxyEvent legacy still works", () => {
    storage.saveProxyRotation({
      proxy: "http://proxy:8000",
      proxyChannel: "ch-1",
      ip: "203.0.113.1",
      reason: "N_cards",
      cardsOnIp: 47,
      rotatedAt: "2026-06-01T12:00:00.000Z"
    });
    storage.saveProxyEvent(null, "manual");

    const rows = db
      .prepare("SELECT * FROM proxy_history ORDER BY id ASC")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    expect(rows[0].proxy).toBe("http://proxy:8000");
    expect(rows[0].proxy_channel).toBe("ch-1");
    expect(rows[0].ip).toBe("203.0.113.1");
    expect(rows[0].reason).toBe("N_cards");
    expect(rows[0].cards_on_ip).toBe(47);
    expect(rows[0].rotated_at).toBe("2026-06-01T12:00:00.000Z");

    // Legacy event: enriched columns default to null, rotated_at mirrors created_at.
    expect(rows[1].proxy).toBeNull();
    expect(rows[1].reason).toBe("manual");
    expect(rows[1].proxy_channel).toBeNull();
    expect(rows[1].ip).toBeNull();
    expect(rows[1].cards_on_ip).toBeNull();
    expect(rows[1].rotated_at).toEqual(rows[1].created_at);
  });
});
