import fs from "node:fs";
import path from "node:path";
import { goszakupGraphqlPage } from "../goszakupGraphql.js";
import type { MarketConfig, MarketUnit } from "./types.js";
import { loadMarketConfig } from "./config.js";
import { filterContractUnits, type RawContractItem } from "./filterUnits.js";
import { fetchZakupMarketUnits, type FetchZakupMarketOptions } from "./fetchZakupMarket.js";

const CONTRACT_QUERY = `query($d: [String], $after: Int) {
  Contract(filter: { signDate: $d }, limit: 200, after: $after) {
    id signDate contractSum faktTradeMethodsId refContractStatusId supplierBiin customerBin
    Supplier { nameRu } Customer { nameRu }
    ContractUnits { refEnstruCode quantity itemPrice totalSum }
  }
}`;

export const DEFAULT_MARKET_UNITS_PATH = "data/market/units-2026.json";

export interface StoredMarketData {
  updatedAt: string;
  completeMonths?: string[];
  units: MarketUnit[];
}

export function loadStoredMarketData(filePath = DEFAULT_MARKET_UNITS_PATH): {
  units: MarketUnit[];
  completeMonths: string[];
  updatedAt?: string;
} {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return { units: [], completeMonths: [] };
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return { units: data, completeMonths: [] };
    }
    return {
      units: Array.isArray(data.units) ? data.units : [],
      completeMonths: Array.isArray(data.completeMonths) ? data.completeMonths : [],
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined
    };
  } catch {
    return { units: [], completeMonths: [] };
  }
}

export function saveStoredMarketData(
  data: { units: MarketUnit[]; completeMonths?: string[]; updatedAt?: string },
  filePath = DEFAULT_MARKET_UNITS_PATH
): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const payload: StoredMarketData = {
    updatedAt: data.updatedAt || new Date().toISOString().slice(0, 10),
    completeMonths: data.completeMonths || [],
    units: data.units
  };
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), "utf8");
}

export function loadStoredMarketUnits(filePath = DEFAULT_MARKET_UNITS_PATH): MarketUnit[] {
  return loadStoredMarketData(filePath).units;
}

export function saveStoredMarketUnits(
  units: MarketUnit[],
  filePath = DEFAULT_MARKET_UNITS_PATH
): void {
  const existing = loadStoredMarketData(filePath);
  saveStoredMarketData(
    {
      units,
      completeMonths: existing.completeMonths,
      updatedAt: new Date().toISOString().slice(0, 10)
    },
    filePath
  );
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

export type MarketSource = "zakup" | "ows";

export interface FetchMarketUnitsOptions {
  fromDate: string;
  toDate: string;
  /** GOSZAKUP_TOKEN: without it there is no backup source. */
  token?: string | null;
  cfg?: MarketConfig;
  /** For tests: replace the real sources. */
  sources?: {
    zakup?: (options: FetchZakupMarketOptions) => Promise<MarketUnit[]>;
    ows?: (options: FetchMarketOptions) => Promise<MarketUnit[]>;
  };
}

/**
 * Main source is the public API of zakup.gov.kz (no token). The ows API with GOSZAKUP_TOKEN is the backup:
 * it is tried only when zakup fails, so one dead source does not leave the market tabs stale.
 */
export async function fetchMarketUnits(options: FetchMarketUnitsOptions): Promise<{ units: MarketUnit[]; source: MarketSource }> {
  const { fromDate, toDate, cfg, token } = options;
  const zakup = options.sources?.zakup ?? fetchZakupMarketUnits;
  const ows = options.sources?.ows ?? fetchMarketContracts;
  try {
    return { units: await zakup({ fromDate, toDate, ...(cfg ? { cfg } : {}) }), source: "zakup" };
  } catch (zakupErr) {
    const zakupMessage = zakupErr instanceof Error ? zakupErr.message : String(zakupErr);
    if (!token) {
      console.warn(`[Рынок] zakup.gov.kz не ответил (${zakupMessage}), а GOSZAKUP_TOKEN для запасного API не задан`);
      throw zakupErr;
    }
    console.warn(`[Рынок] zakup.gov.kz не ответил (${zakupMessage}), берём запасной API ows.goszakup.gov.kz`);
    try {
      return { units: await ows({ token, fromDate, toDate, ...(cfg ? { cfg } : {}) }), source: "ows" };
    } catch (owsErr) {
      const owsMessage = owsErr instanceof Error ? owsErr.message : String(owsErr);
      throw new Error(`Рынок: не ответили оба источника. zakup: ${zakupMessage}; ows: ${owsMessage}`);
    }
  }
}

export function mergeMarketUnits(
  existingUnits: MarketUnit[],
  freshUnits: MarketUnit[],
  fromDate: string,
  toDate?: string
): MarketUnit[] {
  // Retain units strictly outside the [fromDate, toDate] window
  const outsideWindowUnits = existingUnits.filter((u) => u.date < fromDate || (toDate ? u.date > toDate : false));
  const byKey = new Map<string, MarketUnit>();

  const unitKey = (u: MarketUnit) => `${u.id}|${u.unitIndex ?? 0}|${u.code}|${u.price}|${u.qty}`;

  for (const u of outsideWindowUnits) {
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
): Array<{ from: string; to: string; month: string; isFullMonth: boolean }> {
  const intervals: Array<{ from: string; to: string; month: string; isFullMonth: boolean }> = [];
  const start = new Date(Date.parse(`${fromDate}T00:00:00Z`));
  const end = new Date(Date.parse(`${toDate}T23:59:59Z`));

  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth();
    const monthStr = `${y}-${String(m + 1).padStart(2, "0")}`;
    const firstDay = new Date(Date.UTC(y, m, 1));
    const lastDay = new Date(Date.UTC(y, m + 1, 0));
    const firstDayStr = firstDay.toISOString().slice(0, 10);
    const lastDayStr = lastDay.toISOString().slice(0, 10);

    const from = (firstDay < start ? start : firstDay).toISOString().slice(0, 10);
    const to = (lastDay > end ? end : lastDay).toISOString().slice(0, 10);
    const isFullMonth = from === firstDayStr && to === lastDayStr;

    intervals.push({ from, to, month: monthStr, isFullMonth });
    cur = new Date(Date.UTC(y, m + 1, 1));
  }
  return intervals;
}

export interface BackfillMarketOptions {
  /** Only for the ows backup; zakup.gov.kz needs no token. */
  token?: string | null;
  fromDate: string;
  toDate?: string;
  filePath?: string;
  cfg?: MarketConfig;
  onProgress?: (info: { month: string; matched: number; totalSaved: number; source?: MarketSource }) => void;
  fetchUnits?: (options: FetchMarketUnitsOptions) => Promise<{ units: MarketUnit[]; source: MarketSource }>;
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
    onProgress,
    fetchUnits = fetchMarketUnits
  } = options;

  const storedData = loadStoredMarketData(filePath);
  let currentUnits = storedData.units;
  const completeMonths = new Set(storedData.completeMonths);
  const intervals = getMonthIntervals(fromDate, toDate);

  for (const interval of intervals) {
    const isCurrentMonth = interval.month === toDate.slice(0, 7);
    const isComplete = completeMonths.has(interval.month);

    if (isComplete && !isCurrentMonth) {
      if (onProgress) {
        onProgress({
          month: interval.month,
          matched: currentUnits.filter((u) => u.month === interval.month).length,
          totalSaved: currentUnits.length
        });
      }
      continue;
    }

    const { units: monthUnits, source } = await fetchUnits({ token, fromDate: interval.from, toDate: interval.to, cfg });
    if (onProgress) {
      onProgress({ month: interval.month, matched: monthUnits.length, totalSaved: currentUnits.length + monthUnits.length, source });
    }

    currentUnits = mergeMarketUnits(currentUnits, monthUnits, interval.from, interval.to);
    if (!isCurrentMonth && interval.isFullMonth) {
      completeMonths.add(interval.month);
    }
    saveStoredMarketData(
      {
        units: currentUnits,
        completeMonths: [...completeMonths].sort(),
        updatedAt: toDate
      },
      filePath
    );
  }

  return currentUnits;
}
