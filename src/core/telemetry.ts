import type Database from "better-sqlite3";

export interface JobTelemetry {
  parseJobId: string;
  /** success / terminal_count — 0 when no terminal tasks. */
  success_rate: number;
  /** partial / terminal_count — 0 when no terminal tasks. */
  partial_rate: number;
  /** (failed + blocked) / terminal_count — 0 when no terminal tasks. */
  failed_rate: number;
  /** Total tasks in terminal states (success | partial | failed | blocked). */
  terminal_count: number;
  /** Rows in captcha_events linked to this job's tasks. */
  captcha_count: number;
  /** Attempts where result='blocked' OR error_type='blocked'. */
  ban_count: number;
  /** proxy_history rows whose created_at falls within the job's time window. */
  proxy_rotation_count: number;
  /** Mean duration_ms across attempts that have a non-null value; null if none. */
  average_parse_time: number | null;
  /** Total task count / elapsed job hours; null when elapsed time is zero. */
  cards_per_hour: number | null;
}

interface TaskCounts {
  success_n: number | null;
  partial_n: number | null;
  failed_n: number | null;
  terminal_n: number | null;
}

interface JobTime {
  created_at: string | null;
  finished_at: string | null;
}

export function computeJobTelemetry(db: Database.Database, parseJobId: string): JobTelemetry {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_n,
      SUM(CASE WHEN status = 'partial'  THEN 1 ELSE 0 END) AS partial_n,
      SUM(CASE WHEN status IN ('failed','blocked') THEN 1 ELSE 0 END) AS failed_n,
      COUNT(*) AS terminal_n
    FROM company_tasks
    WHERE parse_job_id = ?
      AND status IN ('success','partial','failed','blocked')
  `).get(parseJobId) as TaskCounts;

  const terminal = counts.terminal_n ?? 0;
  const successN = counts.success_n ?? 0;
  const partialN = counts.partial_n ?? 0;
  const failedN  = counts.failed_n  ?? 0;

  const captchaRow = db.prepare(`
    SELECT COUNT(*) AS n FROM captcha_events
    WHERE company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = ?)
  `).get(parseJobId) as { n: number };

  const banRow = db.prepare(`
    SELECT COUNT(*) AS n FROM parse_attempts
    WHERE (result = 'blocked' OR error_type = 'blocked')
      AND company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = ?)
  `).get(parseJobId) as { n: number };

  const jobTime = db.prepare(`
    SELECT created_at, finished_at FROM parse_jobs WHERE id = ?
  `).get(parseJobId) as JobTime | undefined;

  const jobStart = jobTime?.created_at ?? null;
  const jobEnd   = jobTime?.finished_at ?? new Date().toISOString();

  const proxyN = jobStart
    ? (db.prepare(`
        SELECT COUNT(*) AS n FROM proxy_history
        WHERE created_at >= ? AND created_at <= ?
      `).get(jobStart, jobEnd) as { n: number }).n
    : 0;

  const avgRow = db.prepare(`
    SELECT AVG(duration_ms) AS avg_ms FROM parse_attempts
    WHERE duration_ms IS NOT NULL
      AND company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = ?)
  `).get(parseJobId) as { avg_ms: number | null };

  let cardsPerHour: number | null = null;
  if (jobStart) {
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS n FROM company_tasks WHERE parse_job_id = ?
    `).get(parseJobId) as { n: number };
    const elapsedHours = (new Date(jobEnd).getTime() - new Date(jobStart).getTime()) / 3_600_000;
    cardsPerHour = elapsedHours > 0 ? totalRow.n / elapsedHours : null;
  }

  return {
    parseJobId,
    success_rate: terminal > 0 ? successN / terminal : 0,
    partial_rate: terminal > 0 ? partialN / terminal : 0,
    failed_rate:  terminal > 0 ? failedN  / terminal : 0,
    terminal_count: terminal,
    captcha_count: captchaRow.n,
    ban_count: banRow.n,
    proxy_rotation_count: proxyN,
    average_parse_time: avgRow.avg_ms,
    cards_per_hour: cardsPerHour
  };
}
