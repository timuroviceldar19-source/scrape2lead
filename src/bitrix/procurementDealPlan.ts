import type { ProcurementRecord } from "../kz/procurement/types.js";

export const PROCUREMENT_ORIGINATOR_ID = "scrape2lead-procurement";
export const PROCUREMENT_CATEGORY_ID = 1;
export const PROCUREMENT_NEW_STAGE_ID = "C1:NEW";
export const PROCUREMENT_MANAGER_IDS = ["2015", "2209", "2255"] as const;

export interface ExistingProcurementDeal {
  ID: string | number;
  CATEGORY_ID?: string | number | null;
  STAGE_ID?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
}

export function procurementOpportunityOriginId(record: ProcurementRecord): string {
  if (record.recordKind === "tender" && record.parentExternalId) return `proc:${record.source}:plan:${record.parentExternalId}`;
  const upstreamKey = record.sourceRecordId ?? record.externalId;
  return `proc:${record.source}:${record.recordKind}:${upstreamKey}`;
}

export function buildProcurementDealDecision(record: ProcurementRecord, existing: ExistingProcurementDeal | null): {
  action: "create" | "update"; dealId: string | null; fields: Record<string, unknown>;
} {
  const fields = buildFields(record);
  if (!existing) return { action: "create", dealId: null, fields: { ...fields, STAGE_ID: PROCUREMENT_NEW_STAGE_ID } };
  return { action: "update", dealId: String(existing.ID), fields };
}

export function verifyProcurementAssignmentGate(
  deals: Array<{ ID: string | number; ASSIGNED_BY_ID?: string | number | null }>,
  managerIds: readonly string[] = PROCUREMENT_MANAGER_IDS
): { ok: boolean; invalidDealIds: string[] } {
  const allowed = new Set(managerIds);
  const invalidDealIds = deals.filter((deal) => !allowed.has(String(deal.ASSIGNED_BY_ID ?? ""))).map((deal) => String(deal.ID));
  return { ok: invalidDealIds.length === 0, invalidDealIds };
}

function buildFields(record: ProcurementRecord): Record<string, unknown> {
  return stripUndefined({
    TITLE: `[${record.source.toUpperCase()} ${record.externalId}] ${record.customerName ?? "Заказчик"} — ${record.productName}`,
    CATEGORY_ID: PROCUREMENT_CATEGORY_ID, OPENED: "Y", TYPE_ID: "SALE", SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: record.source, ORIGINATOR_ID: PROCUREMENT_ORIGINATOR_ID,
    ORIGIN_ID: procurementOpportunityOriginId(record), OPPORTUNITY: record.amount, CURRENCY_ID: record.currency,
    COMMENTS: buildComments(record)
  });
}

function buildComments(record: ProcurementRecord): string {
  return [`Источник: ${record.source}`, `Тип: ${record.recordKind}`, `Статус: ${record.status ?? "-"}`,
    `Код: ${record.truCode ?? "-"}`, `Заказчик: ${record.customerName ?? "-"}`, `БИН: ${record.customerBin ?? "-"}`,
    `Срок: ${record.startDate ?? "-"} — ${record.endDate ?? "-"}`, `Ссылка: ${record.url}`,
    record.description ? `Описание: ${record.description}` : null].filter(Boolean).join("\n");
}
function stripUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
