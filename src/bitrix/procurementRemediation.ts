import crypto from "node:crypto";
import type { ProcurementRecord } from "../kz/procurement/types.js";
import { buildProcurementDealDecision, type ExistingProcurementDeal } from "./procurementDealPlan.js";
import type { ProcurementCardAuditRow } from "./procurementCardAudit.js";
import { needsManualDecision, recordIdentity } from "./procurementCardAudit.js";

export interface RemediationItem {
  dealId: string;
  originId: string | null;
  action: "update" | "skip";
  reason: string | null;
  fields: Record<string, unknown>;
}

export interface RemediationPlan {
  /** SHA-256 файла аудита: execute разрешён только против него. */
  auditSha256: string;
  items: RemediationItem[];
  counts: { update: number; skip: number };
}

export interface ProcurementRemediationOptions {
  wrongPlanYear?: "skip" | "preserve-and-correct";
}

/** Поля, которые remediation не отправляет никогда: стадия и ответственный ведутся вручную. */
const FORBIDDEN_FIELDS = ["STAGE_ID", "ASSIGNED_BY_ID"] as const;

export function sha256(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

/**
 * Строит план исправления существующих карточек по результату read-only аудита.
 *
 * Правит только то, что можно исправить машинально: полную карту полей и ложный `BEGINDATE`,
 * оставшийся от вывода даты из штампа загрузки. Карточки, требующие решения человека
 * (чужой год, изменившийся статус, исчезнувшая позиция), остаются нетронутыми.
 */
export function planProcurementRemediation(
  auditBody: string,
  rows: ProcurementCardAuditRow[],
  upstream: ProcurementRecord[],
  options: ProcurementRemediationOptions = {}
): RemediationPlan {
  const byIdentity = new Map(upstream.map((record) => [recordIdentity(record), record]));
  const items: RemediationItem[] = rows.map((row) => {
    const preserveWrongPlanYear = options.wrongPlanYear === "preserve-and-correct"
      && row.findings.includes("wrong_plan_year")
      && !row.findings.some((finding) =>
        finding === "status_changed" || finding === "not_found_upstream" || finding === "unparsable_origin");
    if (needsManualDecision(row) && !preserveWrongPlanYear) {
      return { dealId: row.dealId, originId: row.originId, action: "skip",
        reason: `needs_manual_decision:${row.findings.join(",")}`, fields: {} };
    }
    const record = row.source && row.recordKind && row.upstreamKey
      ? byIdentity.get(`proc:${row.source}:${row.recordKind}:${row.upstreamKey}`)
      : undefined;
    if (!record) {
      return { dealId: row.dealId, originId: row.originId, action: "skip", reason: "upstream_record_missing", fields: {} };
    }

    const existing: ExistingProcurementDeal = {
      ID: row.dealId, CATEGORY_ID: 1, STAGE_ID: row.stageId, ASSIGNED_BY_ID: row.assignedById,
      BEGINDATE: row.currentBeginDate
    };
    const decision = buildProcurementDealDecision(record, existing);
    const fields = stripForbidden(decision.fields);
    return {
      dealId: row.dealId,
      originId: row.originId,
      action: "update",
      reason: preserveWrongPlanYear ? "preserve_wrong_plan_year" : null,
      fields
    };
  });

  return {
    auditSha256: sha256(auditBody),
    items,
    counts: {
      update: items.filter((item) => item.action === "update").length,
      skip: items.filter((item) => item.action === "skip").length
    }
  };
}

/** Execute допускается только против того же файла аудита, по которому план был построен. */
export function verifyRemediationPlan(plan: RemediationPlan, auditBody: string): void {
  const actual = sha256(auditBody);
  if (actual !== plan.auditSha256) {
    throw new Error(`remediation plan does not match the audit file: expected ${plan.auditSha256}, got ${actual}`);
  }
  for (const item of plan.items) {
    for (const field of FORBIDDEN_FIELDS) {
      if (field in item.fields) throw new Error(`remediation plan must never send ${field} (deal ${item.dealId})`);
    }
  }
}

function stripForbidden(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields)
    .filter(([key]) => !FORBIDDEN_FIELDS.includes(key as typeof FORBIDDEN_FIELDS[number])));
}
