export type ProcurementSource = "mitwork" | "samruk" | "tizilim";
export type ProcurementRecordKind = "plan" | "tender";
export type ProcurementProduct = "panel" | "pk";

export interface ProcurementEnrichment {
  source: "epz-organization" | "epz-announcement" | "epz-plan-detail" | "goszakup";
  confidence: "exact" | "candidate";
  candidateBin?: string | null;
  candidateTruCode?: string | null;
}

export interface ProcurementDelivery {
  address: string | null;
  kato: string | null;
  quantity: number | null;
}

export interface ProcurementPlanDetail {
  /** Дата акта об утверждении плана (`decree_date`). Никогда не выводится из `timestamp`. */
  approvedAt: string | null;
  /** Год плана из `year.year`. */
  financialYear: number | null;
  /** Идентификатор года в справочнике EPZ (`year.id`), он же `plan_year_id`. */
  planYearId: number | null;
  /** Месяц плана: `month.id`, либо `month_id`, либо null — EPZ отдаёт его далеко не всегда. */
  planMonth: number | null;
  nameRu: string | null;
  nameKk: string | null;
  shortDescriptionRu: string | null;
  shortDescriptionKk: string | null;
  extraDescription: string | null;
  unitName: string | null;
  quantity: number | null;
  unitPrice: number | null;
  prepaymentPercent: number | null;
  deliveryDeadline: string | null;
  itemType: string | null;
  deliveries: ProcurementDelivery[];
}

export interface ProcurementCustomerProfile {
  source: "goszakup";
  website: string | null;
  email: string | null;
  phone: string | null;
  reportingAdministrator: string | null;
  fullAddress: string | null;
  directorName: string | null;
}

export interface EpzPlanYear {
  year: number;
  planYearId: number;
}

export interface ProcurementCollectionCompleteness {
  complete: boolean;
  /** Годы плана, под которые реально выполнялся сбор. */
  planYears: EpzPlanYear[];
  pageLimit: number;
  pagesFetched: number;
  /** Причины, делающие сбор неполным: блокируют production. */
  incompleteReasons: string[];
  /** Наблюдения, не ставящие под сомнение полноту: не блокируют production. */
  warnings: string[];
  /** Запрошенные годы, которым не нашлось `plan_year_id`. */
  unresolvedFutureYears?: number[];
  /** Статусы плана из конфига, отсутствующие в источнике. */
  unavailablePlanStatuses?: string[];
  yearConflicts?: number;
  monthUnknown?: number;
  detailRequested?: number;
  detailSucceeded?: number;
  detailFailed?: number;
  detailEmpty?: number;
  detailIdentityMismatches?: number;
  detailPromotedToData?: number;
  detailRejectedAfterDetail?: number;
}

export interface ProcurementRecord {
  source: ProcurementSource;
  recordKind: ProcurementRecordKind;
  sourceRecordId?: string | null;
  announcementSourceId?: string | null;
  externalId: string;
  parentExternalId: string | null;
  status: string | null;
  productName: string;
  description: string;
  truCode: string | null;
  customerSourceId?: string | null;
  customerName: string | null;
  customerBin: string | null;
  amount: number;
  currency: string;
  /** Год плана по данным позиции. Для тендеров и Tizilim остаётся null. */
  planYear: number | null;
  planMonth: number | null;
  planYearId: number | null;
  approvedAt: string | null;
  /** Год, под который запись была запрошена коллектором — основа сверки с фактическим `planYear`. */
  collectionPlanYear: number | null;
  collectionPlanYearId: number | null;
  startDate: string | null;
  endDate: string | null;
  url: string;
  purchaseMethod: string | null;
  collectedAt: string;
  enrichment?: ProcurementEnrichment | null;
  planDetail?: ProcurementPlanDetail | null;
  customerProfile?: ProcurementCustomerProfile | null;
  detailIssue?: ProcurementDetailIssue | null;
}

export type ProcurementDetailIssue =
  | "detail_fetch_failed"
  | "detail_identity_mismatch"
  | "detail_empty"
  | "plan_year_conflict";

export type ProcurementDropReason =
  | "missing_external_id"
  | "missing_url"
  | "below_min_amount"
  | "stop_word"
  | "irrelevant_tru_code"
  | "irrelevant_product"
  | "missing_tru_code"
  | "ambiguous_panel"
  | "inactive_status"
  | "missing_status"
  | "unsupported_status"
  | "missing_bin"
  | "missing_source_record_id"
  | "detail_fetch_failed"
  | "detail_identity_mismatch"
  | "detail_empty"
  | "plan_year_conflict"
  | "plan_year_outside_window"
  | "plan_period_outside_window";

export interface ClassifiedProcurement {
  record: ProcurementRecord;
  product: ProcurementProduct | null;
  reason: ProcurementDropReason | null;
}

export interface ProcurementClassification {
  data: ClassifiedProcurement[];
  review: ClassifiedProcurement[];
  rejected: ClassifiedProcurement[];
}
