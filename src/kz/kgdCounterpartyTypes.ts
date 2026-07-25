export type RiskColor = "red" | "gray" | "yellow" | "green";
export type StageStatus = "pending" | "complete" | "captcha_required" | "unavailable";
export type BulkSource = "insolvent" | "forced_liquidation";

export interface VatStatus {
  status: "registered" | "removed" | "never_registered" | "contradictory" | "unknown";
  registeredAt?: string;
  removedAt?: string;
}

export interface BulkMatch {
  bin: string;
  name: string;
  listType: string;
  source: BulkSource;
  sourceUrl: string;
  listDate: string;
}

export interface BulkCheck {
  source: BulkSource;
  status: "complete" | "fallback" | "stale_negative" | "unavailable";
  matched: boolean;
  cacheAgeHours?: number;
  sourceUrl: string;
  listDate?: string;
  matches?: BulkMatch[];
}

export interface CounterpartyCheck {
  bin: string;
  name: string;
  validBin: boolean;
  vat: VatStatus;
  bankruptcy: boolean;
  liquidation: { active: boolean; startDate?: string };
  esfRestricted: boolean;
  unreliable: boolean;
  unreliableReasons: string[];
  bulkChecks: BulkCheck[];
  stages: { counterparty: StageStatus; liquidation: StageStatus; bulk: StageStatus };
  checkedAt: string;
  links: string[];
  color?: RiskColor;
  explanations?: string[];
}

export interface CounterpartyPayloadResult {
  bin: string;
  name: string;
  vat: VatStatus;
  bankruptcy: boolean;
  esfRestricted: boolean;
  unreliable: boolean;
  unreliableReasons: string[];
}
