import fs from "node:fs";
import path from "node:path";
import { goszakupGraphqlPage } from "../goszakupGraphql.js";
import type { MarketConfig, MarketUnit } from "./types.js";
import { loadMarketConfig } from "./config.js";
import { filterContractUnits, type RawContractItem } from "./filterUnits.js";

const CONTRACT_QUERY = `query($d: [String], $after: Int) {
  Contract(filter: { signDate: $d }, limit: 200, after: $after) {
    id signDate contractSum faktTradeMethodsId refContractStatusId supplierBiin customerBin
    Supplier { nameRu } Customer { nameRu }
    ContractUnits { refEnstruCode quantity itemPrice totalSum }
  }
}`;

export const DEFAULT_MARKET_UNITS_PATH = "data/market/units-2026.json";

export function loadStoredMarketUnits(filePath = DEFAULT_MARKET_UNITS_PATH): MarketUnit[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return [];
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : Array.isArray(data.units) ? data.units : [];
  } catch {
    return [];
  }
}

export function saveStoredMarketUnits(
  units: MarketUnit[],
  filePath = DEFAULT_MARKET_UNITS_PATH
): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(units), "utf8");
}

export interface FetchMarketOptions {
  token: string;
  fromDate: string;
  toDate?: string;
  cfg?: MarketConfig;
  onProgress?: (pages: number, seenCount: number, matchedCount: number) => void;
  maxRetries?: number;
  timeoutMs?: number;
}

export async function fetchMarketContracts(options: FetchMarketOptions): Promise<MarketUnit[]> {
  const {
    token,
    fromDate,
    toDate,
    cfg = loadMarketConfig(),
    onProgress,
    maxRetries = 4,
    timeoutMs = 60_000
  } = options;

  const dateFilter = toDate ? [fromDate, toDate] : [fromDate];
  const allUnits: MarketUnit[] = [];
  let after: number | undefined;
  let pages = 0;
  let seenCount = 0;

  for (;;) {
    const pageRes = (await goszakupGraphqlPage(
      CONTRACT_QUERY,
      { d: dateFilter, after },
      "Contract",
      { token, maxRetries, timeoutMs }
    )) as {
      items: RawContractItem[];
      hasNextPage: boolean;
      lastId?: number;
      totalCount?: number;
    };

    pages++;
    seenCount += pageRes.items.length;

    const matched = filterContractUnits(pageRes.items, cfg);
    allUnits.push(...matched);

    if (onProgress && (pages % 10 === 0 || !pageRes.hasNextPage)) {
      onProgress(pages, seenCount, allUnits.length);
    }

    if (!pageRes.hasNextPage || pageRes.lastId == null) {
      break;
    }
    after = pageRes.lastId;
  }

  return allUnits;
}

export function mergeMarketUnits(
  existingUnits: MarketUnit[],
  freshUnits: MarketUnit[],
  cutoffDate: string
): MarketUnit[] {
  // Retain units strictly older than cutoffDate, plus all fresh units
  const olderUnits = existingUnits.filter((u) => u.date < cutoffDate);
  const byKey = new Map<string, MarketUnit>();

  const unitKey = (u: MarketUnit) => `${u.id}|${u.unitIndex ?? 0}|${u.code}|${u.price}|${u.qty}`;

  for (const u of olderUnits) {
    byKey.set(unitKey(u), u);
  }
  for (const u of freshUnits) {
    byKey.set(unitKey(u), u);
  }

  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function getMonthIntervals(
  fromDate: string,
  toDate: string
): Array<{ from: string; to: string; month: string }> {
  const intervals: Array<{ from: string; to: string; month: string }> = [];
  const start = new Date(Date.parse(`${fromDate}T00:00:00Z`));
  const end = new Date(Date.parse(`${toDate}T23:59:59Z`));

  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth();
    const monthStr = `${y}-${String(m + 1).padStart(2, "0")}`;
    const firstDay = new Date(Date.UTC(y, m, 1));
    const lastDay = new Date(Date.UTC(y, m + 1, 0));

    const from = (firstDay < start ? start : firstDay).toISOString().slice(0, 10);
    const to = (lastDay > end ? end : lastDay).toISOString().slice(0, 10);

    intervals.push({ from, to, month: monthStr });
    cur = new Date(Date.UTC(y, m + 1, 1));
  }
  return intervals;
}

export interface BackfillMarketOptions {
  token: string;
  fromDate: string;
  toDate?: string;
  filePath?: string;
  cfg?: MarketConfig;
  onProgress?: (info: { month: string; pages: number; seen: number; matched: number; totalSaved: number }) => void;
}

/**
 * Downloads market data by monthly intervals and saves progress after each month.
 * If interrupted, rerunning picks up from where it left off without losing already downloaded months.
 */
export async function backfillMarketByMonths(options: BackfillMarketOptions): Promise<MarketUnit[]> {
  const {
    token,
    fromDate,
    toDate = new Date().toISOString().slice(0, 10),
    filePath = DEFAULT_MARKET_UNITS_PATH,
    cfg = loadMarketConfig(),
    onProgress
  } = options;

  let currentUnits = loadStoredMarketUnits(filePath);
  const intervals = getMonthIntervals(fromDate, toDate);

  for (const interval of intervals) {
    // Check if month already exists in stored units (for past months)
    const isCurrentMonth = interval.month === toDate.slice(0, 7);
    const alreadyLoaded = currentUnits.some((u) => u.month === interval.month);

    if (alreadyLoaded && !isCurrentMonth) {
      if (onProgress) {
        onProgress({
          month: interval.month,
          pages: 0,
          seen: 0,
          matched: currentUnits.filter((u) => u.month === interval.month).length,
          totalSaved: currentUnits.length
        });
      }
      continue;
    }

    const monthUnits = await fetchMarketContracts({
      token,
      fromDate: interval.from,
      toDate: interval.to,
      cfg,
      onProgress: (pages, seen, matched) => {
        if (onProgress) {
          onProgress({
            month: interval.month,
            pages,
            seen,
            matched,
            totalSaved: currentUnits.length + matched
          });
        }
      }
    });

    currentUnits = mergeMarketUnits(currentUnits, monthUnits, interval.from);
    saveStoredMarketUnits(currentUnits, filePath);
  }

  return currentUnits;
}
