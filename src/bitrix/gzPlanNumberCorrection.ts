import {
  extractGzPlanNumberFromHeading,
  hashGzPlanPage,
  verifyCanonicalPlanPageUrl
} from "../kz/gzCanonicalPlanPage.js";
import type { GzBackfillDeal } from "./gzPlanNumberBackfill.js";

/**
 * Fields the correction must leave alone. `UF_CRM_PLAN_ID` is deliberately absent:
 * it is the field being corrected and is compared on its own.
 */
export const GZ_PLAN_CONTROL_FIELDS = [
  "TITLE",
  "CATEGORY_ID",
  "STAGE_ID",
  "ORIGINATOR_ID",
  "ORIGIN_ID",
  "UF_CRM_PLAN_LINK"
] as const;

export type GzPlanControlSnapshot = Record<string, string>;

export interface GzPlanNumberCorrectionLoad {
  dealId: string;
  canonicalPlanPointId: string;
  requestedUrl: string;
  finalUrl: string;
  html: string | null;
  loadError?: string;
}

export interface GzPlanNumberCorrectionEntry {
  dealId: string;
  canonicalPlanPointId: string;
  requestedUrl: string;
  finalUrl: string;
  pageHash: string;
  /** What the CRM carries now, i.e. what the 20260715 backfill wrote. */
  storedPlanNumber: string;
  /** What the deal's own canonical page says. */
  livePlanNumber: string;
  verdict: "wrong" | "unchanged";
  control: GzPlanControlSnapshot;
}

export interface GzPlanNumberCorrectionUnresolved {
  dealId: string;
  canonicalPlanPointId: string;
  requestedUrl: string;
  finalUrl: string;
  reason: string;
}

export interface GzPlanNumberCorrectionReport {
  schemaVersion: 2;
  createdAt: string;
  sourceReport: string;
  verified: GzPlanNumberCorrectionEntry[];
  unresolved: GzPlanNumberCorrectionUnresolved[];
}

export interface GzPlanNumberCorrectionDecision {
  action: "write" | "skip" | "blocked";
  fields?: { UF_CRM_PLAN_ID: string };
  reason?: string;
}

export interface GzPlanNumberCorrectionReload {
  finalUrl: string;
  html: string | null;
}

export function readGzPlanControlFields(deal: GzBackfillDeal): GzPlanControlSnapshot {
  const control: GzPlanControlSnapshot = {};
  for (const field of GZ_PLAN_CONTROL_FIELDS) {
    control[field] = text((deal as Record<string, unknown>)[field] as string | number | null | undefined);
  }
  return control;
}

export function classifyGzPlanNumberCorrection(
  load: GzPlanNumberCorrectionLoad,
  deal: GzBackfillDeal
): { entry: GzPlanNumberCorrectionEntry } | { unresolved: GzPlanNumberCorrectionUnresolved } {
  const reject = (reason: string): { unresolved: GzPlanNumberCorrectionUnresolved } => ({
    unresolved: {
      dealId: load.dealId,
      canonicalPlanPointId: load.canonicalPlanPointId,
      requestedUrl: load.requestedUrl,
      finalUrl: load.finalUrl,
      reason
    }
  });

  if (load.html == null) return reject(`page did not load: ${load.loadError ?? "unknown error"}`);

  const urlVerdict = verifyCanonicalPlanPageUrl(load.finalUrl, load.canonicalPlanPointId);
  if (!urlVerdict.ok) return reject(urlVerdict.reason ?? "final url did not match the requested point");

  const livePlanNumber = extractGzPlanNumberFromHeading(load.html);
  if (!livePlanNumber) return reject("canonical page carries no single numbered heading");

  const storedPlanNumber = text(deal.UF_CRM_PLAN_ID);

  return {
    entry: {
      dealId: load.dealId,
      canonicalPlanPointId: load.canonicalPlanPointId,
      requestedUrl: load.requestedUrl,
      finalUrl: load.finalUrl,
      pageHash: hashGzPlanPage(load.html),
      storedPlanNumber,
      livePlanNumber,
      verdict: storedPlanNumber === livePlanNumber ? "unchanged" : "wrong",
      control: readGzPlanControlFields(deal)
    }
  };
}

export function summarizeGzPlanNumberCorrection(report: GzPlanNumberCorrectionReport): {
  verified: number;
  wrong: number;
  unchanged: number;
  unresolved: number;
} {
  return {
    verified: report.verified.length,
    wrong: report.verified.filter((entry) => entry.verdict === "wrong").length,
    unchanged: report.verified.filter((entry) => entry.verdict === "unchanged").length,
    unresolved: report.unresolved.length
  };
}

export function planGzPlanNumberReplacements(
  report: GzPlanNumberCorrectionReport
): GzPlanNumberCorrectionEntry[] {
  return report.verified.filter((entry) => entry.verdict === "wrong");
}

export function detectGzPlanControlDrift(
  entry: GzPlanNumberCorrectionEntry,
  deal: GzBackfillDeal
): string | null {
  const current = readGzPlanControlFields(deal);
  for (const field of GZ_PLAN_CONTROL_FIELDS) {
    const before = entry.control[field] ?? "";
    if (current[field] !== before) {
      return `${field} moved from "${before}" to "${current[field]}" since the report`;
    }
  }
  return null;
}

export function canExecuteGzPlanNumberCorrection(
  report: GzPlanNumberCorrectionReport
): { ok: boolean; reason?: string } {
  if (report.unresolved.length > 0) {
    const ids = report.unresolved.map((entry) => entry.dealId).join(", ");
    return { ok: false, reason: `${report.unresolved.length} unresolved deal(s): ${ids}` };
  }
  if (report.verified.length === 0) {
    return { ok: false, reason: "report contains no verified deals" };
  }
  return { ok: true };
}

export interface GzPlanNumberCorrectionIo {
  readDeal(dealId: string): Promise<GzBackfillDeal | null>;
  loadCanonicalPage(url: string): Promise<GzPlanNumberCorrectionReload>;
  updateDeal(dealId: string, fields: Record<string, unknown>): Promise<void>;
}

export interface GzPlanNumberCorrectionPlannedWrite {
  dealId: string;
  fields: { UF_CRM_PLAN_ID: string };
}

export interface GzPlanNumberCorrectionOutcome {
  written: number;
  skipped: number;
  planned: GzPlanNumberCorrectionPlannedWrite[];
  blocked: string[];
  failed: string[];
}

/**
 * Reads, loads and decides for every replacement before touching anything, then
 * writes only if the whole set came back clean. A block found on the last deal
 * must not leave the first ones already rewritten.
 *
 * A network failure part way through the write series cannot be excluded
 * transactionally; a repeated run is idempotent and finishes the set.
 */
export async function executeGzPlanNumberCorrection(
  report: GzPlanNumberCorrectionReport,
  io: GzPlanNumberCorrectionIo
): Promise<GzPlanNumberCorrectionOutcome> {
  const gate = canExecuteGzPlanNumberCorrection(report);
  if (!gate.ok) {
    return { written: 0, skipped: 0, planned: [], blocked: [`report: ${gate.reason}`], failed: [] };
  }

  const replacements = planGzPlanNumberReplacements(report);
  // Entries the canonical page already confirmed carry no write, so they are
  // neither read nor loaded.
  let skipped = report.verified.length - replacements.length;

  const planned: GzPlanNumberCorrectionPlannedWrite[] = [];
  const blocked: string[] = [];

  for (const entry of replacements) {
    let deal: GzBackfillDeal | null;
    try {
      deal = await io.readDeal(entry.dealId);
    } catch (error) {
      blocked.push(`${entry.dealId} (read: ${message(error)})`);
      continue;
    }
    if (!deal) {
      blocked.push(`${entry.dealId} (deal no longer exists)`);
      continue;
    }

    let reload: GzPlanNumberCorrectionReload;
    try {
      reload = await io.loadCanonicalPage(entry.requestedUrl);
    } catch (error) {
      blocked.push(`${entry.dealId} (load: ${message(error)})`);
      continue;
    }

    const decision = decideGzPlanNumberCorrectionWrite(entry, deal, reload);
    if (decision.action === "blocked") {
      blocked.push(`${entry.dealId} (${decision.reason})`);
      continue;
    }
    if (decision.action === "skip") {
      skipped++;
      continue;
    }
    planned.push({ dealId: entry.dealId, fields: decision.fields as { UF_CRM_PLAN_ID: string } });
  }

  // Nothing is written unless every replacement came back clean: a block found
  // on the last deal must not leave the earlier ones already rewritten.
  if (blocked.length > 0) {
    return { written: 0, skipped, planned, blocked, failed: [] };
  }

  let written = 0;
  const failed: string[] = [];
  for (const write of planned) {
    try {
      await io.updateDeal(write.dealId, write.fields);
      written++;
    } catch (error) {
      failed.push(`${write.dealId} (update: ${message(error)})`);
    }
  }

  return { written, skipped, planned, blocked, failed };
}

export function decideGzPlanNumberCorrectionWrite(
  entry: GzPlanNumberCorrectionEntry,
  deal: GzBackfillDeal,
  reload?: GzPlanNumberCorrectionReload
): GzPlanNumberCorrectionDecision {
  const drift = detectGzPlanControlDrift(entry, deal);
  if (drift) return { action: "blocked", reason: drift };

  const current = text(deal.UF_CRM_PLAN_ID);
  if (current === entry.livePlanNumber) return { action: "skip" };
  if (current !== entry.storedPlanNumber) {
    return {
      action: "blocked",
      reason: `deal now carries ${current || "(empty)"}, report saw ${entry.storedPlanNumber}`
    };
  }

  if (!reload) return { action: "blocked", reason: "no fresh canonical load to confirm the report" };
  if (reload.html == null) return { action: "blocked", reason: "fresh canonical load failed" };

  const urlVerdict = verifyCanonicalPlanPageUrl(reload.finalUrl, entry.canonicalPlanPointId);
  if (!urlVerdict.ok) return { action: "blocked", reason: urlVerdict.reason };

  const liveNow = extractGzPlanNumberFromHeading(reload.html);
  if (liveNow !== entry.livePlanNumber) {
    return {
      action: "blocked",
      reason: `fresh load reads ${liveNow ?? "(none)"}, report recorded ${entry.livePlanNumber}`
    };
  }

  return { action: "write", fields: { UF_CRM_PLAN_ID: entry.livePlanNumber } };
}

function text(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
