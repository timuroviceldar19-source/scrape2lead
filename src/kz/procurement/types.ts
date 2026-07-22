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
  approvedAt: string | null;
  financialYear: number | null;
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

export interface ProcurementCollectionCompleteness {
  complete: boolean;
  planYearId: number;
  pageLimit: number;
  pagesFetched: number;
  incompleteReasons: string[];
  detailRequested?: number;
  detailSucceeded?: number;
  detailFailed?: number;
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
  startDate: string | null;
  endDate: string | null;
  url: string;
  purchaseMethod: string | null;
  collectedAt: string;
  enrichment?: ProcurementEnrichment | null;
  planDetail?: ProcurementPlanDetail | null;
  customerProfile?: ProcurementCustomerProfile | null;
  detailIssue?: "detail_fetch_failed" | "detail_identity_mismatch" | null;
}

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
  | "detail_identity_mismatch";

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
