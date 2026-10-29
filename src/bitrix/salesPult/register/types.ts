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
  val: number;
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
  val: number;
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
  val: number;
  margin: number;
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
  val: number;
  qty: number;
  contracts: number;
}

export interface RegisterChannelItem {
  name: string;
  sale: number;
  val: number;
  contracts: number;
}

export interface RegisterGroupItem {
  g: "ИП" | "КТ";
  sale: number;
  val: number;
}

export interface RegisterDailyPoint {
  d: string;
  sale: number;
}

export interface RegisterTotal {
  sale: number;
  val: number;
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
}

export type RegisterView = RegisterSuccessView | RegisterErrorView;

export interface CrmWonDeal {
  id: string;
  title: string;
  amount: number;
  company: string;
  manager: string;
}
