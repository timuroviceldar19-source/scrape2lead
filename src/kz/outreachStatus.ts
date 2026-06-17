import type Database from "better-sqlite3";
import type { OutreachKind } from "./outreachDigest.js";

export type OutreachCrmStatus =
  | "new"
  | "contacted"
  | "interested"
  | "follow_up"
  | "closed"
  | "rejected";

export const OUTREACH_CRM_STATUSES: ReadonlyArray<OutreachCrmStatus> = [
  "new",
  "contacted",
  "interested",
  "follow_up",
  "closed",
  "rejected"
];

export interface OutreachStatusItem {
  bin: string;
  tenderNumber: string;
  kind: OutreachKind;
  status: OutreachCrmStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ListOutreachStatusesOptions {
  status?: OutreachCrmStatus;
  kind?: OutreachKind;
  limit?: number;
  offset?: number;
}

export interface ListOutreachStatusesResult {
  items: OutreachStatusItem[];
  total: number;
}

export interface SetOutreachStatusInput {
  bin: string;
  tenderNumber: string;
  kind: OutreachKind;
  status: OutreachCrmStatus;
  note?: string | null;
}

export class OutreachStatusNotFoundError extends Error {
  constructor(bin: string, tenderNumber: string, kind: OutreachKind) {
    super(`Outreach pair not found: ${bin}/${tenderNumber}/${kind}`);
    this.name = "OutreachStatusNotFoundError";
  }
}

export function isOutreachKind(value: string): value is OutreachKind {
  return value === "winner" || value === "prospect";
}

export function isOutreachCrmStatus(value: string): value is OutreachCrmStatus {
  return (OUTREACH_CRM_STATUSES as readonly string[]).includes(value);
}

export function listOutreachStatuses(
  db: Database.Database,
  options: ListOutreachStatusesOptions = {}
): ListOutreachStatusesResult {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const offset = Math.max(0, options.offset ?? 0);
  const params: unknown[] = [];
  const where: string[] = [];

  if (options.kind) {
    where.push("i.kind = ?");
    params.push(options.kind);
  }
  if (options.status) {
    if (options.status === "new") {
      where.push("(s.status IS NULL OR s.status = 'new')");
    } else {
      where.push("s.status = ?");
      params.push(options.status);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRow = db.prepare(`
    SELECT COUNT(*) AS n
    FROM outreach_items i
    LEFT JOIN outreach_status s
      ON s.bin = i.bin AND s.tender_number = i.tender_number AND s.kind = i.kind
    ${whereSql}
  `).get(...params) as { n: number };

  const rows = db.prepare(`
    SELECT
      i.bin,
      i.tender_number,
      i.kind,
      i.created_at,
      s.status AS status_value,
      s.note,
      s.updated_at
    FROM outreach_items i
    LEFT JOIN outreach_status s
      ON s.bin = i.bin AND s.tender_number = i.tender_number AND s.kind = i.kind
    ${whereSql}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    bin: string;
    tender_number: string;
    kind: OutreachKind;
    created_at: string;
    status_value: OutreachCrmStatus | null;
    note: string | null;
    updated_at: string | null;
  }>;

  return {
    items: rows.map((row) => ({
      bin: row.bin,
      tenderNumber: row.tender_number,
      kind: row.kind,
      status: row.status_value ?? "new",
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    total: countRow.n
  };
}

export function getOutreachStatus(
  db: Database.Database,
  bin: string,
  tenderNumber: string,
  kind: OutreachKind
): OutreachStatusItem | null {
  const row = db.prepare(`
    SELECT
      i.bin,
      i.tender_number,
      i.kind,
      i.created_at,
      s.status AS status_value,
      s.note,
      s.updated_at
    FROM outreach_items i
    LEFT JOIN outreach_status s
      ON s.bin = i.bin AND s.tender_number = i.tender_number AND s.kind = i.kind
    WHERE i.bin = ? AND i.tender_number = ? AND i.kind = ?
  `).get(bin, tenderNumber, kind) as {
    bin: string;
    tender_number: string;
    kind: OutreachKind;
    created_at: string;
    status_value: OutreachCrmStatus | null;
    note: string | null;
    updated_at: string | null;
  } | undefined;

  if (!row) return null;

  return {
    bin: row.bin,
    tenderNumber: row.tender_number,
    kind: row.kind,
    status: row.status_value ?? "new",
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function setOutreachStatus(
  db: Database.Database,
  input: SetOutreachStatusInput
): OutreachStatusItem {
  const seen = db.prepare(`
    SELECT 1 FROM outreach_seen
    WHERE bin = ? AND tender_number = ? AND kind = ?
  `).get(input.bin, input.tenderNumber, input.kind);
  if (!seen) {
    throw new OutreachStatusNotFoundError(input.bin, input.tenderNumber, input.kind);
  }

  const item = getOutreachStatus(db, input.bin, input.tenderNumber, input.kind);
  if (!item) {
    throw new OutreachStatusNotFoundError(input.bin, input.tenderNumber, input.kind);
  }

  const now = new Date().toISOString();
  const note = input.note === undefined ? null : input.note;

  db.prepare(`
    INSERT INTO outreach_status (bin, tender_number, kind, status, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bin, tender_number, kind) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(input.bin, input.tenderNumber, input.kind, input.status, note, now);

  return {
    ...item,
    status: input.status,
    note,
    updatedAt: now
  };
}
