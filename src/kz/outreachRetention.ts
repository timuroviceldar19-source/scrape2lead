import type Database from "better-sqlite3";

export interface OutreachRetentionOptions {
  retentionDays: number;
  apply: boolean;
  now?: Date;
}

export interface OutreachRetentionResult {
  retentionDays: number;
  cutoffIso: string;
  dryRun: boolean;
  eligibleRunIds: number[];
  skippedUnfinished: number;
  prunedRuns: number;
  detachedItems: number;
}

/** Parse `KZ_OUTREACH_RUN_RETENTION_DAYS` — positive integer or null when disabled. */
export function parseOutreachRetentionDays(value: string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export function pruneOutreachRuns(
  db: Database.Database,
  options: OutreachRetentionOptions
): OutreachRetentionResult {
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const eligible = db.prepare(`
    SELECT id FROM outreach_runs
    WHERE finished_at IS NOT NULL AND started_at < ?
    ORDER BY id
  `).all(cutoffIso) as Array<{ id: number }>;
  const eligibleRunIds = eligible.map((row) => row.id);

  const skippedRow = db.prepare(`
    SELECT COUNT(*) AS count FROM outreach_runs
    WHERE finished_at IS NULL AND started_at < ?
  `).get(cutoffIso) as { count: number };
  const skippedUnfinished = skippedRow.count;

  if (!options.apply || eligibleRunIds.length === 0) {
    return {
      retentionDays: options.retentionDays,
      cutoffIso,
      dryRun: !options.apply,
      eligibleRunIds,
      skippedUnfinished,
      prunedRuns: 0,
      detachedItems: 0
    };
  }

  let detachedItems = 0;
  let prunedRuns = 0;
  db.transaction(() => {
    const placeholders = eligibleRunIds.map(() => "?").join(",");
    const detach = db.prepare(
      `UPDATE outreach_items SET run_id = NULL WHERE run_id IN (${placeholders})`
    ).run(...eligibleRunIds);
    detachedItems = detach.changes;

    const prune = db.prepare(
      `DELETE FROM outreach_runs WHERE id IN (${placeholders})`
    ).run(...eligibleRunIds);
    prunedRuns = prune.changes;
  })();

  return {
    retentionDays: options.retentionDays,
    cutoffIso,
    dryRun: false,
    eligibleRunIds,
    skippedUnfinished,
    prunedRuns,
    detachedItems
  };
}
