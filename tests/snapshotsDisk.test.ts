import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Storage } from "../src/storage/storage.js";

interface Workspace {
  storage: Storage;
  db: Database.Database;
  dbPath: string;
  snapDir: string;
  root: string;
}

function makeWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-snapdisk-"));
  const dbPath = path.join(root, "test.db");
  const snapDir = path.join(root, "raw");
  const storage = new Storage(dbPath, snapDir);
  const db = (storage as unknown as { db: Database.Database }).db;
  return { storage, db, dbPath, snapDir, root };
}

function rmRecursive(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

describe("raw_snapshots disk payload", () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });
  afterEach(() => {
    ws.storage.close();
    rmRecursive(ws.root);
  });

  it("writes the payload to disk under rawSnapshotDir and stores payload_path", async () => {
    const id = await ws.storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-1",
      kind: "json",
      purpose: "recent",
      payload: { hello: "world" }
    });

    const row = ws.storage.getRawSnapshot(id);
    expect(row).not.toBeNull();
    expect(row?.payload_path).not.toBeNull();
    expect(row?.payload_path).toMatch(/^.*[\\/]snapshot-1-recent-ext-1-.*\.json$/);
    expect(fs.existsSync(row!.payload_path!)).toBe(true);

    const fileContent = fs.readFileSync(row!.payload_path!, "utf8");
    expect(JSON.parse(fileContent)).toEqual({ hello: "world" });

    // Backwards compatibility: inline payload is still populated.
    expect(JSON.parse(row?.payload ?? "{}")).toEqual({ hello: "world" });
  });

  it("creates the raw snapshot directory automatically when it does not exist", async () => {
    const fresh = path.join(ws.root, "nested", "deep", "raw");
    expect(fs.existsSync(fresh)).toBe(false);

    const storage = new Storage(path.join(ws.root, "test2.db"), fresh);
    try {
      const id = await storage.saveRawSnapshot({
        source: "2gis",
        externalId: "ext-1",
        kind: "json",
        purpose: "recent",
        payload: { ok: true }
      });
      expect(fs.existsSync(fresh)).toBe(true);
      const row = storage.getRawSnapshot(id);
      expect(row?.payload_path).not.toBeNull();
      expect(fs.existsSync(row!.payload_path!)).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("readRawSnapshotContent returns inline payload when present", async () => {
    const id = await ws.storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-inline",
      kind: "json",
      purpose: "recent",
      payload: { inline: true }
    });
    expect(ws.storage.readRawSnapshotContent(id)).toBe(JSON.stringify({ inline: true }));
  });

  it("getRawSnapshot and listRawSnapshots expose disk payload when inline payload is cleared", async () => {
    const id = await ws.storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-disk",
      kind: "json",
      purpose: "recent",
      payload: { on: "disk" }
    });
    const row = ws.storage.getRawSnapshot(id);
    expect(row?.payload_path).not.toBeNull();
    const diskPath = row!.payload_path!;
    const expected = JSON.stringify({ on: "disk" });
    expect(fs.readFileSync(diskPath, "utf8")).toBe(expected);

    // Simulate a large-payload scenario where the inline column is empty
    // (e.g. future migration to disk-only mode) but the file remains.
    ws.db.prepare("UPDATE raw_snapshots SET payload = NULL WHERE snapshot_id = ?").run(id);

    const hydrated = ws.storage.getRawSnapshot(id);
    expect(hydrated?.payload).toBe(expected);

    const listed = ws.storage.listRawSnapshots({ externalId: "ext-disk" });
    expect(listed).toHaveLength(1);
    expect(listed[0].payload).toBe(expected);

    const content = ws.storage.readRawSnapshotContent(id);
    expect(content).toBe(expected);
  });

  it("skips the disk write when no rawSnapshotDir is configured (inline-only mode)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-inline-"));
    const storage = new Storage(path.join(root, "test.db"));
    try {
      const id = await storage.saveRawSnapshot({
        source: "2gis",
        externalId: "ext-1",
        kind: "json",
        purpose: "recent",
        payload: { inline: "only" }
      });
      const row = storage.getRawSnapshot(id);
      expect(row?.payload_path).toBeNull();
      expect(JSON.parse(row?.payload ?? "{}")).toEqual({ inline: "only" });
    } finally {
      storage.close();
      rmRecursive(root);
    }
  });

  it("preserves a caller-supplied payloadPath instead of writing a fresh file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-fixture-"));
    const fixturePath = path.join(root, "fixture.json");
    fs.writeFileSync(fixturePath, JSON.stringify({ fixture: true }), "utf8");
    try {
      const id = await ws.storage.saveRawSnapshot({
        source: "2gis",
        externalId: "ext-1",
        kind: "json",
        purpose: "fixture",
        payload: { ignored: true },
        payloadPath: fixturePath
      });
      const row = ws.storage.getRawSnapshot(id);
      expect(row?.payload_path).toBe(fixturePath);
      // No new file should have been written into snapDir.
      if (fs.existsSync(ws.snapDir)) {
        const dirEntries = fs.readdirSync(ws.snapDir);
        expect(dirEntries).toHaveLength(0);
      }
    } finally {
      rmRecursive(root);
    }
  });

  it("missing payload file is handled predictably — getRawSnapshot still returns the row", async () => {
    const id = await ws.storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-1",
      kind: "json",
      purpose: "recent",
      payload: { ghost: true }
    });
    const row = ws.storage.getRawSnapshot(id);
    expect(row?.payload_path).not.toBeNull();
    fs.unlinkSync(row!.payload_path!);

    // Row remains queryable.
    const after = ws.storage.getRawSnapshot(id);
    expect(after).not.toBeNull();
    expect(after?.payload_path).toBe(row?.payload_path);

    // Inline payload still serves the content.
    expect(JSON.parse(after?.payload ?? "{}")).toEqual({ ghost: true });

    // readRawSnapshotContent returns the inline value (preferred).
    expect(ws.storage.readRawSnapshotContent(id)).toBe(JSON.stringify({ ghost: true }));

    // And when both inline and disk are gone, returns null without throwing.
    ws.db.prepare("UPDATE raw_snapshots SET payload = NULL WHERE snapshot_id = ?").run(id);
    expect(ws.storage.readRawSnapshotContent(id)).toBeNull();

    // Unrelated queries still work.
    expect(ws.storage.listRawSnapshots({ purpose: "recent" })).toHaveLength(1);
    expect(ws.storage.listRawSnapshots({ purpose: "captcha" })).toHaveLength(0);
  });

  it("cleanupRecentSnapshots deletes the on-disk files for the removed rows", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await ws.storage.saveRawSnapshot({
        source: "2gis",
        externalId: `ext-${i}`,
        kind: "json",
        purpose: "recent",
        payload: { i }
      });
      ids.push(id);
      ws.db
        .prepare("UPDATE raw_snapshots SET created_at = ? WHERE snapshot_id = ?")
        .run(new Date(2026, 5, 1, 12, 0, i).toISOString(), id);
    }

    // Sanity check: all four files exist on disk before cleanup.
    for (const id of ids) {
      const row = ws.storage.getRawSnapshot(id);
      expect(row?.payload_path).not.toBeNull();
      expect(fs.existsSync(row!.payload_path!)).toBe(true);
    }

    const deleted = ws.storage.cleanupRecentSnapshots({ maxEntries: 1 });
    expect(deleted).toBe(3);

    // The newest row survives with its file intact; the others are gone.
    const survivingId = ids[ids.length - 1];
    const surviving = ws.storage.getRawSnapshot(survivingId);
    expect(surviving).not.toBeNull();
    expect(fs.existsSync(surviving!.payload_path!)).toBe(true);

    for (const id of ids.slice(0, 3)) {
      const row = ws.storage.getRawSnapshot(id);
      expect(row).toBeNull();
      // We did not capture the file path before deletion in this test —
      // the cleanup must have already unlinked it. Look it up via listRawSnapshots.
    }
    // Directory entries should be only the surviving snapshot's file.
    const remaining = fs.readdirSync(ws.snapDir);
    expect(remaining).toHaveLength(1);
  });

  it("cleanupSnapshotsOlderThan deletes the on-disk files for the removed rows", async () => {
    const oldId = await ws.storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-old",
      kind: "json",
      purpose: "recent",
      payload: { old: true }
    });
    const freshId = await ws.storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-fresh",
      kind: "json",
      purpose: "recent",
      payload: { fresh: true }
    });

    const now = new Date("2026-06-01T12:00:00.000Z");
    ws.db
      .prepare("UPDATE raw_snapshots SET created_at = ? WHERE snapshot_id = ?")
      .run("2026-05-01T00:00:00.000Z", oldId);
    ws.db
      .prepare("UPDATE raw_snapshots SET created_at = ? WHERE snapshot_id = ?")
      .run("2026-06-01T11:59:00.000Z", freshId);

    const oldRow = ws.storage.getRawSnapshot(oldId);
    const oldFile = oldRow?.payload_path;
    expect(oldFile).not.toBeNull();
    expect(fs.existsSync(oldFile!)).toBe(true);

    const deleted = ws.storage.cleanupSnapshotsOlderThan({
      olderThanMs: 24 * 60 * 60 * 1000,
      now
    });
    expect(deleted).toBe(1);
    expect(ws.storage.getRawSnapshot(oldId)).toBeNull();
    expect(fs.existsSync(oldFile!)).toBe(false);

    // Fresh row keeps its file.
    const freshRow = ws.storage.getRawSnapshot(freshId);
    expect(freshRow).not.toBeNull();
    expect(fs.existsSync(freshRow!.payload_path!)).toBe(true);
  });

  it("deleting a company_task does NOT touch the snapshot row or its file", async () => {
    const jobId = await ws.storage.createParseJob({ source: "2gis", city: "moscow", category: "auto" });
    const taskId = await ws.storage.enqueueCompanyTask({ parseJobId: jobId, source: "2gis", externalId: "ext-1" });
    const snapId = await ws.storage.saveRawSnapshot({
      companyTaskId: taskId,
      source: "2gis",
      externalId: "ext-1",
      kind: "json",
      purpose: "recent",
      payload: { keep: true }
    });
    const row = ws.storage.getRawSnapshot(snapId);
    const file = row?.payload_path;
    expect(file).not.toBeNull();
    expect(fs.existsSync(file!)).toBe(true);

    ws.db.prepare("DELETE FROM company_tasks WHERE id = ?").run(taskId);

    // Snapshot row still exists (FK SET NULL on company_task_id).
    const after = ws.storage.getRawSnapshot(snapId);
    expect(after).not.toBeNull();
    expect(after?.company_task_id).toBeNull();
    // And its file is intact.
    expect(fs.existsSync(file!)).toBe(true);
  });

  it("file names are deterministic — saving twice produces two distinct paths", async () => {
    const id1 = await ws.storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-1",
      kind: "json",
      purpose: "recent",
      payload: { n: 1 }
    });
    const id2 = await ws.storage.saveRawSnapshot({
      source: "2gis",
      externalId: "ext-1",
      kind: "json",
      purpose: "recent",
      payload: { n: 2 }
    });
    const p1 = ws.storage.getRawSnapshot(id1)?.payload_path;
    const p2 = ws.storage.getRawSnapshot(id2)?.payload_path;
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1).not.toBe(p2);
    expect(p1).toMatch(/snapshot-1-/);
    expect(p2).toMatch(/snapshot-2-/);
  });
});
