import type { ProcurementRecord, ProcurementSource } from "../kz/procurement/types.js";
import { procurementOpportunityOriginId, PROCUREMENT_ORIGINATOR_ID } from "./procurementDealPlan.js";

export type ProcurementCardFinding =
  | "still_relevant"
  | "superseded_by_tender"
  | "wrong_plan_year"
  | "status_changed"
  | "not_found_upstream"
  | "unparsable_origin"
  | "begindate_will_be_cleared";

export interface ProcurementCardDeal {
  ID: string | number;
  TITLE?: string | null;
  ORIGIN_ID?: string | null;
  ORIGINATOR_ID?: string | null;
  STAGE_ID?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
  BEGINDATE?: string | null;
}

export interface ParsedProcurementOriginId {
  source: ProcurementSource;
  recordKind: "plan" | "tender";
  upstreamKey: string;
}

export interface ProcurementCardAuditRow {
  dealId: string;
  originId: string | null;
  source: ProcurementSource | null;
  recordKind: "plan" | "tender" | null;
  upstreamKey: string | null;
  /** Вердиктов может быть несколько: год, статус и появление тендера независимы. */
  findings: ProcurementCardFinding[];
  currentBeginDate: string | null;
  upstreamPlanYear: number | null;
  upstreamStatus: string | null;
  stageId: string | null;
  assignedById: string | null;
  notes: string[];
}

export interface ProcurementCardAuditResult {
  rows: ProcurementCardAuditRow[];
  counts: Record<ProcurementCardFinding, number>;
}

const SOURCES: ProcurementSource[] = ["mitwork", "samruk", "tizilim"];

/** Разбирает `proc:<source>:<kind>:<id>` строго: чужой или битый ORIGIN_ID не угадывается. */
export function parseProcurementOriginId(value: string | null | undefined): ParsedProcurementOriginId | null {
  const parts = (value ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== "proc") return null;
  const source = parts[1] as ProcurementSource;
  const recordKind = parts[2] as "plan" | "tender";
  if (!SOURCES.includes(source)) return null;
  if (recordKind !== "plan" && recordKind !== "tender") return null;
  if (!parts[3]?.trim()) return null;
  return { source, recordKind, upstreamKey: parts[3] };
}

export interface ProcurementCardAuditOptions {
  /** Годы текущего окна сбора: запись вне их — кандидат на `wrong_plan_year`. */
  allowedPlanYears: number[];
  /** Статусы, которые сейчас считаются рабочими. */
  allowedStatuses: string[];
}

/**
 * Аудит существующих карточек воронки F3-B2B. Только чтение: ничего не меняет и не удаляет.
 *
 * `upstream` — записи, полученные ПРЯМЫМ запросом по ключам карточек, а не из текущего окна
 * сбора: карточки прошлых лет в новое окно не попадают и иначе выглядели бы как исчезнувшие.
 */
export function auditProcurementCards(
  deals: ProcurementCardDeal[],
  upstream: ProcurementRecord[],
  options: ProcurementCardAuditOptions
): ProcurementCardAuditResult {
  // Ключ — собственная идентичность записи, а НЕ origin сделки: последний намеренно
  // схлопывает тендер в карточку его плана, и по нему план и тендер затирали бы друг друга.
  const byOrigin = new Map<string, ProcurementRecord>();
  const tenderParents = new Set<string>();
  for (const record of upstream) {
    byOrigin.set(recordIdentity(record), record);
    if (record.recordKind === "tender" && record.parentExternalId) {
      tenderParents.add(`proc:${record.source}:plan:${record.parentExternalId}`);
    }
  }
  const allowedStatuses = options.allowedStatuses.map(normalize);

  const rows = deals.map((deal) => auditOne(deal, byOrigin, tenderParents, options, allowedStatuses));
  const counts = Object.fromEntries(
    (["still_relevant", "superseded_by_tender", "wrong_plan_year", "status_changed",
      "not_found_upstream", "unparsable_origin", "begindate_will_be_cleared"] as ProcurementCardFinding[])
      .map((finding) => [finding, rows.filter((row) => row.findings.includes(finding)).length])
  ) as Record<ProcurementCardFinding, number>;

  return { rows, counts };
}

function auditOne(
  deal: ProcurementCardDeal,
  byOrigin: Map<string, ProcurementRecord>,
  tenderParents: Set<string>,
  options: ProcurementCardAuditOptions,
  allowedStatuses: string[]
): ProcurementCardAuditRow {
  const originId = deal.ORIGIN_ID?.trim() || null;
  const parsed = parseProcurementOriginId(originId);
  const currentBeginDate = deal.BEGINDATE?.trim() || null;
  const base: ProcurementCardAuditRow = {
    dealId: String(deal.ID), originId,
    source: parsed?.source ?? null, recordKind: parsed?.recordKind ?? null,
    upstreamKey: parsed?.upstreamKey ?? null,
    findings: [], currentBeginDate, upstreamPlanYear: null, upstreamStatus: null,
    stageId: deal.STAGE_ID?.trim() || null,
    assignedById: deal.ASSIGNED_BY_ID === null || deal.ASSIGNED_BY_ID === undefined ? null : String(deal.ASSIGNED_BY_ID),
    notes: []
  };

  if (!parsed) {
    return { ...base, findings: ["unparsable_origin"], notes: ["ORIGIN_ID не разбирается как proc:<source>:<kind>:<id>"] };
  }

  const findings: ProcurementCardFinding[] = [];
  const notes: string[] = [];
  const record = byOrigin.get(originId as string);

  if (!record) {
    findings.push("not_found_upstream");
    notes.push("Позиция не найдена в источнике по прямому запросу");
  } else {
    if (record.planYear !== null && !options.allowedPlanYears.includes(record.planYear)) {
      findings.push("wrong_plan_year");
      notes.push(`Год плана ${record.planYear} вне окна ${options.allowedPlanYears.join(", ")}`);
    }
    if (record.status && !allowedStatuses.includes(normalize(record.status))) {
      findings.push("status_changed");
      notes.push(`Статус в источнике: ${record.status}`);
    }
  }

  if (parsed.recordKind === "plan" && tenderParents.has(originId as string)) {
    findings.push("superseded_by_tender");
    notes.push("По плану опубликован тендер — он обновляет эту же карточку");
  }

  // Ложная дата, выведенная из штампа загрузки: очистится при первом же обновлении.
  if (parsed.recordKind === "plan" && currentBeginDate) findings.push("begindate_will_be_cleared");

  if (!findings.some((finding) => finding !== "begindate_will_be_cleared")) {
    findings.unshift("still_relevant");
  }

  return { ...base, findings, notes,
    upstreamPlanYear: record?.planYear ?? null, upstreamStatus: record?.status ?? null };
}

/** Карточки, требующие ручного решения: всё, что не «актуально» и не «заменено тендером». */
export function needsManualDecision(row: ProcurementCardAuditRow): boolean {
  return row.findings.some((finding) =>
    finding === "wrong_plan_year" || finding === "status_changed"
    || finding === "not_found_upstream" || finding === "unparsable_origin");
}

/** Собственная идентичность записи, без схлопывания тендера в его план. */
export function recordIdentity(record: ProcurementRecord): string {
  return `proc:${record.source}:${record.recordKind}:${record.sourceRecordId ?? record.externalId}`;
}

export { PROCUREMENT_ORIGINATOR_ID, procurementOpportunityOriginId };

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/g, " ").trim();
}
