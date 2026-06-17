import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/storage/migrations.js";
import {
  computeOutreachDiff,
  diffToOutreachItems,
  registerOutreachItems,
  startOutreachRun
} from "../../src/kz/outreachDigest.js";
import { pruneOutreachRuns } from "../../src/kz/outreachRetention.js";
import { KzStorage } from "../../src/kz/kzStorage.js";

const STAT_INSERT = `
  INSERT INTO stat_gov_data (bin, name, registration_date, oked, oked_name, address, director, legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code, sector_name, updated_at, raw_snapshot_path)
  VALUES (?, ?, '2015-01-01', '41200', 'Строительство', 'Астана', ?, 'active', NULL, NULL, NULL, 'ТОО', NULL, NULL, '2026-06-01', NULL)
`;

const TENDER_INSERT = `
  INSERT INTO tender_data (source, bin, tender_number, tender_name, customer_name, budget_amount, currency, start_date, end_date, status, method, url, parsed_at)
  VALUES (?, ?, ?, ?, ?, ?, 'KZT', ?, NULL, ?, 'auction', ?, ?)
`;

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function insertWinnerFixture(db: Database.Database): void {
  db.prepare(STAT_INSERT).run("061040006408", 'ТОО "ALAU"', "Иванов И.И.");
  db.prepare(TENDER_INSERT).run(
    "goszakup.gov.kz", "061040006408", "CT-100",
    "Договор CT-100 (закупка A-1)", "ГУ Заказчик", "60000000",
    "2026-06-05", "Действует",
    "https://goszakup.gov.kz/ru/registry/contract/1", "2026-06-08T10:00:00.000Z"
  );
}

function insertRun(
  db: Database.Database,
  startedAt: string,
  finishedAt: string | null
): number {
  const result = db.prepare(
    "INSERT INTO outreach_runs (started_at, finished_at) VALUES (?, ?)"
  ).run(startedAt, finishedAt);
  return Number(result.lastInsertRowid);
}

describe("registerOutreachItems ledger", () => {
  it("writes both outreach_seen and outreach_items", () => {
    const db = setupDb();
    try {
      insertWinnerFixture(db);
      const diff = computeOutreachDiff(db, { bins: ["061040006408"] });
      const runId = startOutreachRun(db);
      registerOutreachItems(db, runId, diffToOutreachItems(diff));

      expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_seen").get() as { count: number }).count).toBeGreaterThan(0);
      expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_items").get() as { count: number }).count).toBeGreaterThan(0);
      expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_seen WHERE kind = 'winner'").get() as { count: number }).count).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("pruneOutreachRuns", () => {
  const now = new Date("2026-06-17T12:00:00.000Z");

  it("dry-run reports eligible runs but deletes nothing", () => {
    const db = setupDb();
    try {
      const oldRunId = insertRun(db, "2020-01-01T00:00:00.000Z", "2020-01-01T01:00:00.000Z");
      db.prepare(`
        INSERT INTO outreach_items (run_id, bin, tender_number, kind, created_at)
        VALUES (?, '061040006408', 'CT-OLD', 'winner', '2020-01-02T00:00:00.000Z')
      `).run(oldRunId);
      db.prepare(`
        INSERT INTO outreach_seen (bin, tender_number, kind, first_seen_at)
        VALUES ('061040006408', 'CT-OLD', 'winner', '2020-01-02T00:00:00.000Z')
      `).run();

      const result = pruneOutreachRuns(db, { retentionDays: 30, apply: false, now });
      expect(result.eligibleRunIds).toEqual([oldRunId]);
      expect(result.prunedRuns).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_runs").get() as { count: number }).count).toBe(1);
      expect((db.prepare("SELECT run_id FROM outreach_items WHERE bin = '061040006408'").get() as { run_id: number }).run_id).toBe(oldRunId);
    } finally {
      db.close();
    }
  });

  it("--apply deletes only old finished runs and preserves ledger rows", () => {
    const db = setupDb();
    try {
      const oldRunId = insertRun(db, "2020-01-01T00:00:00.000Z", "2020-01-01T01:00:00.000Z");
      const recentRunId = insertRun(db, "2026-06-10T00:00:00.000Z", "2026-06-10T01:00:00.000Z");
      const unfinishedRunId = insertRun(db, "2020-02-01T00:00:00.000Z", null);

      db.prepare(`
        INSERT INTO outreach_items (run_id, bin, tender_number, kind, created_at)
        VALUES (?, '061040006408', 'CT-OLD', 'winner', '2020-01-02T00:00:00.000Z')
      `).run(oldRunId);
      db.prepare(`
        INSERT INTO outreach_items (run_id, bin, tender_number, kind, created_at)
        VALUES (?, '990940012345', 'CT-NEW', 'winner', '2026-06-11T00:00:00.000Z')
      `).run(recentRunId);
      db.prepare(`
        INSERT INTO outreach_seen (bin, tender_number, kind, first_seen_at)
        VALUES ('061040006408', 'CT-OLD', 'winner', '2020-01-02T00:00:00.000Z'),
               ('990940012345', 'CT-NEW', 'winner', '2026-06-11T00:00:00.000Z')
      `).run();

      const seenBefore = (db.prepare("SELECT COUNT(*) AS count FROM outreach_seen").get() as { count: number }).count;
      const itemsBefore = (db.prepare("SELECT COUNT(*) AS count FROM outreach_items").get() as { count: number }).count;

      const result = pruneOutreachRuns(db, { retentionDays: 30, apply: true, now });
      expect(result.prunedRuns).toBe(1);
      expect(result.eligibleRunIds).toEqual([oldRunId]);
      expect(result.skippedUnfinished).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_runs").get() as { count: number }).count).toBe(2);
      expect(db.prepare("SELECT id FROM outreach_runs WHERE id = ?").get(oldRunId)).toBeUndefined();
      expect(db.prepare("SELECT id FROM outreach_runs WHERE id = ?").get(recentRunId)).toBeDefined();
      expect(db.prepare("SELECT id FROM outreach_runs WHERE id = ?").get(unfinishedRunId)).toBeDefined();
      expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_seen").get() as { count: number }).count).toBe(seenBefore);
      expect((db.prepare("SELECT COUNT(*) AS count FROM outreach_items").get() as { count: number }).count).toBe(itemsBefore);
      expect((db.prepare("SELECT run_id FROM outreach_items WHERE bin = '061040006408'").get() as { run_id: number | null }).run_id).toBeNull();
      expect((db.prepare("SELECT run_id FROM outreach_items WHERE bin = '990940012345'").get() as { run_id: number }).run_id).toBe(recentRunId);
    } finally {
      db.close();
    }
  });
});

describe("dedup after retention", () => {
  it("old pairs remain seen after parent run is pruned", () => {
    const db = setupDb();
    const storage = new KzStorage({ db });
    try {
      insertWinnerFixture(db);
      const diff = computeOutreachDiff(db, { bins: ["061040006408"] });
      const runId = startOutreachRun(db);
      registerOutreachItems(db, runId, diffToOutreachItems(diff));
      db.prepare("UPDATE outreach_runs SET started_at = ?, finished_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", "2020-01-01T01:00:00.000Z", runId);

      pruneOutreachRuns(db, { retentionDays: 30, apply: true, now: new Date("2026-06-17T12:00:00.000Z") });

      const second = computeOutreachDiff(db, { bins: ["061040006408"] });
      expect(second.winners).toHaveLength(0);
      expect(second.prospects).toHaveLength(0);
    } finally {
      storage.close();
      db.close();
    }
  });
});
