import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/storage/migrations.js";
import {
  getOutreachStatus,
  listOutreachStatuses,
  OutreachStatusNotFoundError,
  setOutreachStatus
} from "../../src/kz/outreachStatus.js";

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function seedPair(
  db: Database.Database,
  bin: string,
  tenderNumber: string,
  kind: "winner" | "prospect",
  createdAt: string
): void {
  db.prepare(`
    INSERT INTO outreach_seen (bin, tender_number, kind, first_seen_at)
    VALUES (?, ?, ?, ?)
  `).run(bin, tenderNumber, kind, createdAt);
  db.prepare(`
    INSERT INTO outreach_items (run_id, bin, tender_number, kind, created_at)
    VALUES (NULL, ?, ?, ?, ?)
  `).run(bin, tenderNumber, kind, createdAt);
}

describe("outreachStatus module", () => {
  it("listing returns items with default status new", () => {
    const db = setupDb();
    try {
      seedPair(db, "061040006408", "CT-100", "winner", "2026-06-01T10:00:00.000Z");

      const result = listOutreachStatuses(db);
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        bin: "061040006408",
        tenderNumber: "CT-100",
        kind: "winner",
        status: "new",
        note: null,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: null
      });
    } finally {
      db.close();
    }
  });

  it("set creates and updates status and note", () => {
    const db = setupDb();
    try {
      seedPair(db, "061040006408", "CT-100", "winner", "2026-06-01T10:00:00.000Z");

      const created = setOutreachStatus(db, {
        bin: "061040006408",
        tenderNumber: "CT-100",
        kind: "winner",
        status: "contacted",
        note: "called buyer"
      });
      expect(created.status).toBe("contacted");
      expect(created.note).toBe("called buyer");
      expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const updated = setOutreachStatus(db, {
        bin: "061040006408",
        tenderNumber: "CT-100",
        kind: "winner",
        status: "interested",
        note: "wants follow-up"
      });
      expect(updated.status).toBe("interested");
      expect(updated.note).toBe("wants follow-up");

      const row = getOutreachStatus(db, "061040006408", "CT-100", "winner");
      expect(row?.status).toBe("interested");
      expect(row?.note).toBe("wants follow-up");
    } finally {
      db.close();
    }
  });

  it("rejects unknown pair on set", () => {
    const db = setupDb();
    try {
      expect(() => setOutreachStatus(db, {
        bin: "960440000716",
        tenderNumber: "MISSING",
        kind: "prospect",
        status: "contacted"
      })).toThrow(OutreachStatusNotFoundError);
    } finally {
      db.close();
    }
  });

  it("filters by status and kind", () => {
    const db = setupDb();
    try {
      seedPair(db, "061040006408", "CT-100", "winner", "2026-06-01T10:00:00.000Z");
      seedPair(db, "061040006408", "CT-200", "prospect", "2026-06-02T10:00:00.000Z");
      setOutreachStatus(db, {
        bin: "061040006408",
        tenderNumber: "CT-100",
        kind: "winner",
        status: "contacted"
      });

      expect(listOutreachStatuses(db, { kind: "prospect" }).total).toBe(1);
      expect(listOutreachStatuses(db, { status: "contacted" }).total).toBe(1);
      expect(listOutreachStatuses(db, { status: "new" }).total).toBe(1);
    } finally {
      db.close();
    }
  });

  it("paginates with limit and offset", () => {
    const db = setupDb();
    try {
      seedPair(db, "061040006408", "CT-1", "winner", "2026-06-01T10:00:00.000Z");
      seedPair(db, "061040006408", "CT-2", "winner", "2026-06-02T10:00:00.000Z");
      seedPair(db, "061040006408", "CT-3", "winner", "2026-06-03T10:00:00.000Z");

      const page = listOutreachStatuses(db, { limit: 1, offset: 1 });
      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.tenderNumber).toBe("CT-2");
    } finally {
      db.close();
    }
  });
});
