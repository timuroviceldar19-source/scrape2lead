import type { ClassifiedProcurement, ProcurementClassification, ProcurementCollectionCompleteness, ProcurementRecord } from "./types.js";
import { procurementCustomerUrl } from "./links.js";

export type ProcurementSheetName = "Планы" | "Тендеры" | "Review" | "Rejected" | "Summary";
export interface ProcurementWorkbookSheet { name: ProcurementSheetName; rows: Array<Array<string | number | null>> }
export interface ProcurementWorkbookModel { sheets: ProcurementWorkbookSheet[]; summary: { total: number; data: number; review: number; rejected: number } }

const PLAN_HEADERS = [
  "БИН Заказчика", "Наименование заказчика", "Вебсайт", "e-mail", "Контактный телефон",
  "Наименование Администратора отчетности", "Полный адрес", "Руководитель ФИО",
  "Дата акта, которым утвержден план", "Код товара/работы/услуги (СТРУ)",
  "Наименование закупаемых товаров (СТРУ)", "Ссылка на наименование", "Единица измерения", "Кол-во",
  "Цена за ед.", "Дополнительная характеристика", "Ключевое слово", "№ пункта плана", "ID пункта (API)",
  "Планируемый срок", "Статус", "Плановая сумма", "Способ закупки", "Ссылка на заказчика",
  "Ссылка на пункт плана", "Краткая характеристика", "Дополнительное описание", "Место поставки",
  "Источник", "Финансовый год", "Наименование (каз.)", "КАТО", "Количество по адресам", "Тип предмета",
  "Источник обогащения", "Уверенность"
];

const TENDER_HEADERS = ["Источник", "Внешний ID тендера", "ID связанного плана", "Статус", "Наименование",
  "Описание", "Код ЕНС ТРУ", "Заказчик", "БИН", "Сумма", "Валюта", "Начало подачи", "Окончание подачи",
  "Способ закупки", "Ссылка", "Собрано", "Источник обогащения", "Уверенность"];

const CONTROL_HEADERS = ["Источник", "Тип записи", "ID карточки", "Внешний ID", "ID связанного плана", "Продукт",
  "Причина", "Статус", "Наименование", "Описание", "Код ЕНС ТРУ", "Заказчик", "БИН", "Сумма", "Валюта",
  "Начало", "Окончание", "Способ закупки", "Ссылка", "Дата утверждения", "Финансовый год", "Единица",
  "Количество", "Цена за единицу", "Места поставки", "КАТО", "Количество по адресам", "Собрано",
  "Источник обогащения", "Уверенность", "Кандидат БИН", "Кандидат ЕНС ТРУ"];

export function buildProcurementWorkbookModel(input: ProcurementClassification, completeness?: ProcurementCollectionCompleteness): ProcurementWorkbookModel {
  const summary = { total: input.data.length + input.review.length + input.rejected.length,
    data: input.data.length, review: input.review.length, rejected: input.rejected.length };
  const reasons = new Map<string, number>();
  const allItems = [...input.data, ...input.review, ...input.rejected];
  const sources = new Map<string, number>();
  const kinds = new Map<string, number>();
  for (const item of allItems) {
    sources.set(item.record.source, (sources.get(item.record.source) ?? 0) + 1);
    kinds.set(item.record.recordKind, (kinds.get(item.record.recordKind) ?? 0) + 1);
  }
  for (const item of [...input.review, ...input.rejected]) {
    const reason = item.reason ?? "unknown";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const approvedPlans = input.data.filter((item) => item.record.recordKind === "plan");
  const tenders = input.data.filter((item) => item.record.recordKind === "tender");
  return { sheets: [
    { name: "Планы", rows: [PLAN_HEADERS, ...approvedPlans.map(toPlanRow)] },
    { name: "Тендеры", rows: [TENDER_HEADERS, ...tenders.map(toTenderRow)] },
    { name: "Review", rows: [CONTROL_HEADERS, ...input.review.map(toControlRow)] },
    { name: "Rejected", rows: [CONTROL_HEADERS, ...input.rejected.map(toControlRow)] },
    { name: "Summary", rows: [["Metric", "Count"], ["total", summary.total], ["data", summary.data],
      ["review", summary.review], ["rejected", summary.rejected],
      ...(completeness ? completenessRows(completeness) : []),
      ...[...sources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, count]) => [`source:${source}`, count]),
      ...[...kinds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => [`kind:${kind}`, count]),
      ...[...reasons.entries()].sort(([a], [b]) => a.localeCompare(b))] }
  ], summary };
}

function toPlanRow(item: ClassifiedProcurement): Array<string | number | null> {
  const row = item.record;
  const detail = row.planDetail;
  const profile = row.customerProfile;
  return [
    row.customerBin, row.customerName, profile?.website ?? null, profile?.email ?? null, profile?.phone ?? null,
    profile?.reportingAdministrator ?? null, profile?.fullAddress ?? null, profile?.directorName ?? null,
    detail?.approvedAt ?? null, row.truCode, detail?.nameRu ?? row.productName, row.url, detail?.unitName ?? null,
    detail?.quantity ?? null, detail?.unitPrice ?? null, detail?.shortDescriptionRu ?? row.description,
    productLabel(item), row.sourceRecordId ?? null, row.externalId,
    [detail?.financialYear, detail?.deliveryDeadline].filter((value) => value !== null && value !== undefined && value !== "").join("; ") || null,
    row.status, row.amount, row.purchaseMethod, customerLink(row), row.url,
    detail?.shortDescriptionRu ?? null, detail?.extraDescription ?? row.description, joinDeliveries(row, "address"),
    row.source, detail?.financialYear ?? null, detail?.nameKk ?? null, joinDeliveries(row, "kato"),
    joinDeliveries(row, "quantity"), detail?.itemType ?? null, row.enrichment?.source ?? null,
    row.enrichment?.confidence ?? null
  ];
}

function toTenderRow(item: ClassifiedProcurement): Array<string | number | null> {
  const row = item.record;
  return [row.source, row.externalId, row.parentExternalId, row.status, row.productName, row.description, row.truCode,
    row.customerName, row.customerBin, row.amount, row.currency, row.startDate, row.endDate, row.purchaseMethod,
    row.url, row.collectedAt, row.enrichment?.source ?? null, row.enrichment?.confidence ?? null];
}

function toControlRow(item: ClassifiedProcurement): Array<string | number | null> {
  const row = item.record;
  const detail = row.planDetail;
  return [row.source, row.recordKind, row.sourceRecordId ?? null, row.externalId, row.parentExternalId, item.product,
    item.reason, row.status, row.productName, row.description, row.truCode, row.customerName, row.customerBin,
    row.amount, row.currency, row.startDate, row.endDate, row.purchaseMethod, row.url, detail?.approvedAt ?? null,
    detail?.financialYear ?? null, detail?.unitName ?? null, detail?.quantity ?? null, detail?.unitPrice ?? null,
    joinDeliveries(row, "address"), joinDeliveries(row, "kato"), joinDeliveries(row, "quantity"), row.collectedAt,
    row.enrichment?.source ?? null, row.enrichment?.confidence ?? null, row.enrichment?.candidateBin ?? null,
    row.enrichment?.candidateTruCode ?? null];
}

function completenessRows(value: ProcurementCollectionCompleteness): Array<Array<string | number>> {
  return [
    ["collection:complete", value.complete ? "yes" : "no"],
    ["collection:plan_year_id", value.planYearId],
    ["collection:pages_fetched", value.pagesFetched],
    ["collection:page_limit", value.pageLimit],
    ["detail:requested", value.detailRequested ?? 0],
    ["detail:succeeded", value.detailSucceeded ?? 0],
    ["detail:failed", value.detailFailed ?? 0],
    ["detail:identity_mismatches", value.detailIdentityMismatches ?? 0],
    ["detail:promoted_to_data", value.detailPromotedToData ?? 0],
    ["detail:rejected_after_detail", value.detailRejectedAfterDetail ?? 0],
    ...value.incompleteReasons.map((reason) => [`collection:incomplete:${reason}`, 1])
  ];
}

function joinDeliveries(record: ProcurementRecord, field: "address" | "kato" | "quantity"): string | null {
  const values = (record.planDetail?.deliveries ?? []).map((delivery) => delivery[field])
    .filter((value) => value !== null && value !== undefined && value !== "").map(String);
  return values.length ? values.join("\n") : null;
}
function productLabel(item: ClassifiedProcurement): string | null {
  return item.product === "panel" ? "Интерактивная панель" : item.product === "pk" ? "ПК" : null;
}
function customerLink(row: ProcurementRecord): string | null {
  return procurementCustomerUrl(row) ?? null;
}
