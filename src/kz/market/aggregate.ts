import type {
  MarketUnit,
  MarketGroupView,
  MarketView,
  MarketSupplierItem,
  MarketMonthItem,
  MarketMethodItem,
  MarketKindItem,
  MarketLostItem,
  MarketCustomerItem,
  MarketConfig
} from "./types.js";
import { loadMarketConfig } from "./config.js";

function sumBy<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((s, x) => s + (fn(x) || 0), 0);
}

function countContracts(items: MarketUnit[]): number {
  return new Set(items.map((u) => u.id)).size;
}

function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  return items.reduce((m, x) => {
    const k = keyFn(x);
    (m[k] ??= []).push(x);
    return m;
  }, {} as Record<K, T[]>);
}

export function calculateQuantile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  return sorted[low] + (sorted[high] - sorted[low]) * (idx - low);
}

function getPreviousMonthKey(monthKey: string): string {
  const [yStr, mStr] = monthKey.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (m === 1) {
    return `${y - 1}-12`;
  }
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function buildMarketGroupView(
  group: "ИП" | "КТ",
  allUnits: MarketUnit[],
  asOfDate: string,
  cfg: MarketConfig = loadMarketConfig()
): MarketGroupView {
  const curMonth = asOfDate.slice(0, 7);
  const prevMonth = getPreviousMonthKey(curMonth);

  const groupUnits = allUnits.filter((u) => u.group === group);
  const curCandidate = groupUnits.filter((u) => u.month === curMonth);
  const prevUnits = groupUnits.filter((u) => u.month === prevMonth);

  // If early in the month and few contracts arrived, or no contracts in current month yet:
  // show previous month in full.
  const curCandidateContracts = countContracts(curCandidate);
  const isEarlyMonth = Number(asOfDate.slice(8, 10)) <= 5;
  const usePrevMonth = prevUnits.length > 0 && (curCandidateContracts === 0 || (isEarlyMonth && curCandidateContracts < 5));
  const displayMonth = usePrevMonth ? prevMonth : curMonth;
  const comparisonMonth = getPreviousMonthKey(displayMonth);

  const cur = groupUnits.filter((u) => u.month === displayMonth);
  const lastDate = cur.reduce((m, l) => (l.date > m ? l.date : m), "");
  const lastDay = lastDate ? lastDate.slice(8, 10) : (usePrevMonth ? "31" : asOfDate.slice(8, 10));
  const prev = groupUnits.filter((u) => u.month === comparisonMonth && u.date.slice(8, 10) <= lastDay);
  const us = cur.filter((u) => u.us);

  // Suppliers
  const bySupplier = groupBy(cur, (u) => u.supplier);
  const suppliers: MarketSupplierItem[] = Object.entries(bySupplier)
    .map(([bin, xs]) => ({
      bin,
      name: xs[0]?.supplierName || bin,
      sum: sumBy(xs, (u) => u.sum),
      contracts: countContracts(xs),
      qty: sumBy(xs, (u) => u.qty),
      us: bin === cfg.bin
    }))
    .sort((a, b) => b.sum - a.sum);

  const rank = suppliers.findIndex((s) => s.us) + 1;
  const top12Suppliers = suppliers.slice(0, 12);
  const top12Sum = sumBy(top12Suppliers, (s) => s.sum);
  const curTotalSum = sumBy(cur, (u) => u.sum);
  const othersSum = curTotalSum - top12Sum;

  // Months
  const byMonth = groupBy(groupUnits, (u) => u.month);
  const months: MarketMonthItem[] = Object.entries(byMonth)
    .map(([m, xs]) => ({
      m,
      sum: sumBy(xs, (u) => u.sum),
      us: sumBy(xs.filter((u) => u.us), (u) => u.sum),
      contracts: countContracts(xs)
    }))
    .sort((a, b) => a.m.localeCompare(b.m));

  // Methods
  const byMethod = groupBy(cur, (u) => u.method);
  const methods: MarketMethodItem[] = Object.entries(byMethod)
    .map(([name, xs]) => ({
      name,
      sum: sumBy(xs, (u) => u.sum),
      us: sumBy(xs.filter((u) => u.us), (u) => u.sum),
      contracts: countContracts(xs)
    }))
    .sort((a, b) => b.sum - a.sum);

  // Kinds
  const byKind = groupBy(cur, (u) => u.kind);
  const kinds: MarketKindItem[] = Object.entries(byKind)
    .map(([kind, xs]) => {
      const prices = xs.filter((u) => u.price > 0).map((u) => u.price);
      const usPrices = xs.filter((u) => u.us && u.price > 0).map((u) => u.price);
      return {
        kind,
        sum: sumBy(xs, (u) => u.sum),
        qty: sumBy(xs, (u) => u.qty),
        us: sumBy(xs.filter((u) => u.us), (u) => u.sum),
        p25: calculateQuantile(prices, 0.25),
        med: calculateQuantile(prices, 0.5),
        p75: calculateQuantile(prices, 0.75),
        usMed: usPrices.length ? calculateQuantile(usPrices, 0.5) : null,
        n: prices.length
      };
    })
    .sort((a, b) => b.sum - a.sum);

  // Lost contracts
  const byContractId = groupBy(cur.filter((u) => !u.us), (u) => String(u.id));
  const lost: MarketLostItem[] = Object.entries(byContractId)
    .map(([idStr, xs]) => ({
      id: Number(idStr),
      date: xs[0]?.date || "",
      supplierBin: xs[0]?.supplier || "",
      supplier: xs[0]?.supplierName || xs[0]?.supplier || "",
      customerBin: xs[0]?.customer || "",
      customer: xs[0]?.customerName || xs[0]?.customer || "",
      method: xs[0]?.method || "",
      sum: sumBy(xs, (u) => u.sum),
      qty: sumBy(xs, (u) => u.qty),
      kind: xs[0]?.kind || "",
      price: xs[0]?.price || 0
    }))
    .sort((a, b) => b.sum - a.sum)
    .slice(0, 10);

  // Customers
  const byCustomer = groupBy(cur, (u) => u.customer);
  const customers: MarketCustomerItem[] = Object.entries(byCustomer)
    .map(([bin, xs]) => ({
      bin,
      name: xs[0]?.customerName || bin,
      sum: sumBy(xs, (u) => u.sum),
      us: sumBy(xs.filter((u) => u.us), (u) => u.sum),
      contracts: countContracts(xs)
    }))
    .sort((a, b) => b.sum - a.sum)
    .slice(0, 10);

  return {
    group,
    month: displayMonth,
    total: {
      sum: curTotalSum,
      contracts: countContracts(cur),
      qty: sumBy(cur, (u) => u.qty),
      suppliers: suppliers.length,
      customers: new Set(cur.map((u) => u.customer)).size
    },
    prev: {
      sum: sumBy(prev, (u) => u.sum),
      contracts: countContracts(prev),
      toDay: lastDay
    },
    us: {
      sum: sumBy(us, (u) => u.sum),
      contracts: countContracts(us),
      qty: sumBy(us, (u) => u.qty),
      rank,
      share: curTotalSum > 0 ? sumBy(us, (u) => u.sum) / curTotalSum : 0
    },
    suppliers: top12Suppliers,
    othersSum,
    months,
    methods,
    kinds,
    lost,
    customers
  };
}

export function buildMarketView(
  units: MarketUnit[],
  asOfDate: string,
  cfg: MarketConfig = loadMarketConfig(),
  error?: string,
  updatedAt?: string
): MarketView {
  const months = [...new Set(units.map((u) => u.month))].sort();
  const ip = units.length > 0 ? buildMarketGroupView("ИП", units, asOfDate, cfg) : null;
  const kt = units.length > 0 ? buildMarketGroupView("КТ", units, asOfDate, cfg) : null;
  const isStale = Boolean(updatedAt && updatedAt < asOfDate);
  return {
    asOf: asOfDate,
    months,
    ip,
    kt,
    "ИП": ip,
    "КТ": kt,
    updatedAt: updatedAt || asOfDate,
    stale: isStale,
    error
  };
}
