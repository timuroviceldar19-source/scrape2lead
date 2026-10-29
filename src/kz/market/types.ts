export interface MarketKindConfig {
  name: string;
  patterns: string[];
}

export interface MarketGroupConfig {
  name: string;
  prefixes: string[];
  kinds: MarketKindConfig[];
}

export interface MarketConfig {
  bin: string;
  minUnitPrice: number;
  excludedStatuses: number[];
  allowedStatuses: number[];
  methods: Record<string, string>;
  groups: {
    "ИП": MarketGroupConfig;
    "КТ": MarketGroupConfig;
  };
}

export interface MarketUnit {
  id: number;
  month: string;
  date: string;
  group: "ИП" | "КТ";
  code: string;
  kind: string;
  sum: number;
  qty: number;
  price: number;
  supplier: string;
  customer: string;
  supplierName: string;
  customerName: string;
  method: string;
  us: boolean;
}

export interface MarketSupplierItem {
  bin: string;
  name: string;
  sum: number;
  contracts: number;
  qty: number;
  us: boolean;
}

export interface MarketMonthItem {
  m: string;
  sum: number;
  us: number;
  contracts: number;
}

export interface MarketMethodItem {
  name: string;
  sum: number;
  us: number;
  contracts: number;
}

export interface MarketKindItem {
  kind: string;
  sum: number;
  qty: number;
  us: number;
  p25: number;
  med: number;
  p75: number;
  usMed: number | null;
  n: number;
}

export interface MarketLostItem {
  id: number;
  date: string;
  supplierBin: string;
  supplier: string;
  customerBin: string;
  customer: string;
  method: string;
  sum: number;
  qty: number;
  kind: string;
  price: number;
}

export interface MarketCustomerItem {
  bin: string;
  name: string;
  sum: number;
  us: number;
  contracts: number;
}

export interface MarketGroupView {
  group: "ИП" | "КТ";
  month: string;
  total: {
    sum: number;
    contracts: number;
    qty: number;
    suppliers: number;
    customers: number;
  };
  prev: {
    sum: number;
    contracts: number;
    toDay: string;
  };
  us: {
    sum: number;
    contracts: number;
    qty: number;
    rank: number;
    share: number;
  };
  suppliers: MarketSupplierItem[];
  othersSum: number;
  months: MarketMonthItem[];
  methods: MarketMethodItem[];
  kinds: MarketKindItem[];
  lost: MarketLostItem[];
  customers: MarketCustomerItem[];
}

export interface MarketView {
  asOf: string;
  months: string[];
  "ИП": MarketGroupView | null;
  "КТ": MarketGroupView | null;
  error?: string;
}
