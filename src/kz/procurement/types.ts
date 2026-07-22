export type ProcurementSource = "mitwork" | "samruk" | "tizilim";
export type ProcurementRecordKind = "plan" | "tender";
export type ProcurementProduct = "panel" | "pk";

export interface ProcurementEnrichment {
  source: "epz-organization" | "epz-announcement" | "goszakup";
  confidence: "exact" | "candidate";
  candidateBin?: string | null;
  candidateTruCode?: string | null;
}

export interface ProcurementCollectionCompleteness {
  complete: boolean;
  planYearId: number;
  pageLimit: number;
  pagesFetched: number;
  incompleteReasons: string[];
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
  | "missing_bin";

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
