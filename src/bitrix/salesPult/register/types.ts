export type ProductGroup = "ИП" | "КТ" | "Прочее";

export interface RegisterRow {
  date: string;
  type: string;
  customer: string;
  qty: number;
  product: string;
  cost: number;
  extras: number;
  sale: number;
  portal: number;
  val: number | null;
  bonusMop: number;
  bonusRop: number;
  manager: string;
  note: string | null;
  group: ProductGroup;
  kind: string;
  channel: string;
}

export interface RegisterContract {
  date: string;
  customer: string;
  manager: string;
  sale: number;
  val: number | null;
  bonusMop: number;
  bonusRop: number;
  lines: number;
  products: string[];
  type: string;
  channel: string;
  group: ProductGroup;
  kind: string;
  qty: number;
}

export interface RegisterManagerSummary {
  name: string;
  sale: number;
  val: number | null;
  margin: number | null;
  bonus: number;
  plan: number;
  contracts: number;
  missCount: number;
  missSum: number;
  rows: RegisterRow[];
}

export interface RegisterMixItem {
  kind: string;
  group: ProductGroup;
  sale: number;
  val: number | null;
  qty: number;
  contracts: number;
}

export interface RegisterChannelItem {
  name: string;
  sale: number;
  val: number | null;
  contracts: number;
}

export interface RegisterGroupItem {
  g: "ИП" | "КТ";
  sale: number;
  val: number | null;
}

export interface RegisterDailyPoint {
  d: string;
  sale: number;
}

export interface RegisterTotal {
  sale: number;
  val: number | null;
  hasVal?: boolean;
  margin?: number | null;
  bonusMop: number;
  bonusRop: number;
  contracts: number;
  plan: number;
  b2bPlan: number;
  b2bSale: number;
}

export interface RegisterMissingContract {
  date: string;
  manager: string;
  customer: string;
  sale: number;
  products: string[];
  type: string;
}

export interface RegisterMonthSummary {
  month: string;
  label: string;
  fileName: string;
  sale: number;
  val: number | null;
  margin: number | null;
  contracts: number;
  plan: number;
  planPct: number | null;
  hasVal: boolean;
  byManager: Array<{
    name: string;
    sale: number;
    val: number | null;
    margin: number | null;
    contracts: number;
    plan: number;
    planPct: number | null;
  }>;
  missingCrm?: RegisterMissingContract[];
  reconciliationPerformed?: boolean;
}

export interface RegisterPortalMissingContract {
  id: number | string;
  contractNumber: string;
  signDate: string;
  customer: string;
  amountWithVat: number;
  method: string;
  supplier: string;
}

export interface RegisterPortalReconciliationView {
  currentMonth: string;
  previousMonth: string;
  missingContracts: RegisterPortalMissingContract[];
  monthlyCounts: Record<
    string,
    {
      f3: number;
      partner: number;
      total: number;
      matched?: number;
      matched1to1?: number;
      matchedByCustomerSum?: number;
      missing?: number;
    }
  >;
  matched1to1Count?: number;
  matchedByCustomerSumCount?: number;
  error?: string;
}

export interface RegisterDisciplineRetroChange {
  date: string;
  manager: string;
  customer: string;
  product: string;
  sale: number;
  type: "modified" | "deleted";
  note?: string;
  diff?: {
    sale?: { before: number; after: number };
    cost?: { before: number; after: number };
    manager?: { before: string; after: string };
    date?: { before: string; after: string };
  };
}

export interface RegisterDisciplineView {
  missingWorkingDays: string[];
  laggedRowsCount: number;
  laggedByManager: Array<{ manager: string; count: number }>;
  retroChanges: RegisterDisciplineRetroChange[];
  salesBelowCost: Array<{
    date: string;
    manager: string;
    customer: string;
    product: string;
    sale: number;
    cost: number;
  }>;
}

export interface RegisterHistoryPayload {
  asOf: string;
  cachedAt?: string;
  months: RegisterMonthSummary[];
  portalMissing?: RegisterPortalReconciliationView;
  discipline?: RegisterDisciplineView;
  failedFiles?: Array<{ fileName: string; reason: string }>;
  error?: string;
}

export interface RegisterSuccessView {
  file: string;
  asOf: string;
  month: string;
  total: RegisterTotal;
  daily: RegisterDailyPoint[];
  managers: RegisterManagerSummary[];
  mix: RegisterMixItem[];
  channels: RegisterChannelItem[];
  groups: RegisterGroupItem[];
  missing: RegisterMissingContract[];
  crmExtra: number;
  rows: RegisterRow[];
  history?: RegisterHistoryPayload;
  historyError?: string;
  error?: undefined;
}

export interface RegisterErrorView {
  error: string;
  file?: string;
  asOf?: string;
  month?: string;
  total?: RegisterTotal;
  daily?: RegisterDailyPoint[];
  managers?: RegisterManagerSummary[];
  mix?: RegisterMixItem[];
  channels?: RegisterChannelItem[];
  groups?: RegisterGroupItem[];
  missing?: RegisterMissingContract[];
  crmExtra?: number;
  rows?: RegisterRow[];
  history?: RegisterHistoryPayload;
  historyError?: string;
}

export type RegisterView = RegisterSuccessView | RegisterErrorView;

export interface CrmWonDeal {
  id: string;
  title: string;
  amount: number;
  company: string;
  manager: string;
  date?: string;
}
