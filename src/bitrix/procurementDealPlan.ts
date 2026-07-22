import type { ProcurementRecord } from "../kz/procurement/types.js";
import { procurementCustomerUrl } from "../kz/procurement/links.js";

export const PROCUREMENT_ORIGINATOR_ID = "scrape2lead-procurement";
export const PROCUREMENT_CATEGORY_ID = 1;
export const PROCUREMENT_NEW_STAGE_ID = "C1:NEW";
export const PROCUREMENT_MANAGER_IDS = ["147", "1751", "725"] as const;

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
  const detail = record.planDetail;
  const profile = record.customerProfile;
  const deliveryAddresses = joinDeliveries(record, "address");
  const customerUrl = procurementCustomerUrl(record);
  const plannedTerm = [detail?.financialYear, detail?.deliveryDeadline]
    .filter((value) => value !== null && value !== undefined && value !== "").join("; ") || undefined;
  return stripUndefined({
    TITLE: `[${record.source.toUpperCase()} ${record.externalId}] ${record.customerName ?? "Заказчик"} — ${detail?.nameRu ?? record.productName}`,
    CATEGORY_ID: PROCUREMENT_CATEGORY_ID, OPENED: "Y", TYPE_ID: "SALE", SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: record.source, ORIGINATOR_ID: PROCUREMENT_ORIGINATOR_ID,
    ORIGIN_ID: procurementOpportunityOriginId(record), OPPORTUNITY: record.amount, CURRENCY_ID: record.currency,
    BEGINDATE: normalizeBitrixDate(detail?.approvedAt),
    COMMENTS: buildComments(record),
    UF_CRM_1711518716644: detail?.unitName,
    UF_CRM_6627AEBD4503E: record.purchaseMethod,
    UF_CRM_6627AEBD54B8D: detail?.nameRu ?? record.productName,
    UF_CRM_6627AEBD5E68B: scalarText(detail?.unitPrice),
    UF_CRM_6627AEBD67FFF: scalarText(detail?.quantity),
    UF_CRM_6627AEBD72587: record.customerName,
    UF_CRM_6627AEBD7C2D2: record.customerBin,
    UF_CRM_6627AEBD85B4D: record.status,
    UF_CRM_1715597423325: scalarText(record.amount),
    UF_CRM_1715597726664: plannedTerm,
    UF_CRM_1782274598760: customerUrl,
    UF_CRM_1782386080157_IU_XLS: record.url,
    UF_CRM_1782386193634_IU_XLS: detail?.extraDescription ?? record.description,
    UF_CRM_1782386244985_IU_XLS: detail?.nameRu ?? record.productName,
    UF_CRM_1782386293000_IU_XLS: record.sourceRecordId ?? record.externalId,
    UF_CRM_1782386433277_IU_XLS: plannedTerm,
    UF_CRM_1782386571874_IU_XLS: record.url,
    UF_CRM_PLAN_ID: record.sourceRecordId ?? record.externalId,
    UF_CRM_TRADE_METHOD: scalarText(detail?.financialYear),
    UF_CRM_POINT_TYPE: record.recordKind,
    UF_CRM_REF_ENSTRU_CODE: record.truCode,
    UF_CRM_REF_SUBJECT_TYPE_NAME: detail?.itemType,
    UF_CRM_ENSTRU_NAME: detail?.nameRu ?? record.productName,
    UF_CRM_DESC_RU: detail?.shortDescriptionRu ?? record.description,
    UF_CRM_DESC_KZ: detail?.shortDescriptionKk,
    UF_CRM_EXTRA_DESC_RU: detail?.extraDescription,
    UF_CRM_UNIT_NAME: detail?.unitName,
    UF_CRM_COUNT: scalarText(detail?.quantity),
    UF_CRM_PRICE_PER_UNIT: detail?.unitPrice === null || detail?.unitPrice === undefined
      ? undefined : `${detail.unitPrice}|${record.currency}`,
    UF_CRM_PREPAYMENT: scalarText(detail?.prepaymentPercent),
    UF_CRM_MONTH: plannedTerm,
    UF_CRM_SUPPLY_DATE: detail?.deliveryDeadline,
    UF_CRM_DELIVERY_ADDRESSES: deliveryAddresses,
    UF_CRM_PLAN_STATUS: record.status,
    UF_CRM_PLAN_LINK: record.url,
    UF_CRM_6A436D598EC82: profile?.reportingAdministrator,
    UF_CRM_6A436D59AACBF: profile?.fullAddress,
    UF_CRM_6A436D59CD2B1: profile?.directorName,
    UF_CRM_6A436D5A19612: record.truCode,
    UF_CRM_6A436D5A3614C: record.externalId,
    UF_CRM_6A436D5A5700E: customerUrl,
    UF_CRM_6A436D5A76648: detail?.shortDescriptionRu ?? record.description,
    UF_CRM_6A436D5A92D16: detail?.extraDescription,
    UF_CRM_6A436D5AD0A2B: deliveryAddresses
  });
}

function buildComments(record: ProcurementRecord): string {
  const detail = record.planDetail;
  const profile = record.customerProfile;
  const deliveries = (detail?.deliveries ?? []).map((delivery, index) =>
    `Поставка ${index + 1}: ${delivery.address ?? "-"}; КАТО: ${delivery.kato ?? "-"}; количество: ${delivery.quantity ?? "-"}`
  );
  return [
    `Источник: ${record.source}`,
    `Тип: ${record.recordKind}`,
    `Внешний ID: ${record.externalId}`,
    `ID карточки: ${record.sourceRecordId ?? "-"}`,
    `Статус: ${record.status ?? "-"}`,
    `Заказчик: ${record.customerName ?? "-"}`,
    `БИН: ${record.customerBin ?? "-"}`,
    profile?.website ? `Веб-сайт: ${profile.website}` : null,
    profile?.email ? `E-mail: ${profile.email}` : null,
    profile?.phone ? `Телефон: ${profile.phone}` : null,
    detail?.approvedAt ? `Дата утверждения: ${detail.approvedAt}` : null,
    detail?.financialYear ? `Финансовый год: ${detail.financialYear}` : null,
    `Код ЕНС ТРУ: ${record.truCode ?? "-"}`,
    `Наименование RU: ${detail?.nameRu ?? record.productName}`,
    detail?.nameKk ? `Наименование KZ: ${detail.nameKk}` : null,
    detail?.unitName ? `Единица: ${detail.unitName}` : null,
    detail?.quantity !== null && detail?.quantity !== undefined ? `Количество: ${detail.quantity}` : null,
    detail?.unitPrice !== null && detail?.unitPrice !== undefined ? `Цена за единицу: ${detail.unitPrice} ${record.currency}` : null,
    `Сумма: ${record.amount} ${record.currency}`,
    record.purchaseMethod ? `Способ закупки: ${record.purchaseMethod}` : null,
    detail?.deliveryDeadline ? `Срок поставки: ${detail.deliveryDeadline}` : null,
    ...deliveries,
    record.enrichment ? `Источник обогащения: ${record.enrichment.source} (${record.enrichment.confidence})` : null,
    `Ссылка: ${record.url}`,
    detail?.shortDescriptionRu ? `Краткая характеристика RU: ${detail.shortDescriptionRu}` : null,
    detail?.shortDescriptionKk ? `Краткая характеристика KZ: ${detail.shortDescriptionKk}` : null,
    detail?.extraDescription ? `Дополнительное описание: ${detail.extraDescription}` : null,
    !detail && record.description ? `Описание: ${record.description}` : null
  ].filter(Boolean).join("\n");
}

function joinDeliveries(record: ProcurementRecord, field: "address" | "kato" | "quantity"): string | undefined {
  const values = (record.planDetail?.deliveries ?? []).map((delivery) => delivery[field])
    .filter((value) => value !== null && value !== undefined && value !== "").map(String);
  return values.length ? values.join("\n") : undefined;
}

function scalarText(value: string | number | null | undefined): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

function normalizeBitrixDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}
function stripUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
