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

  for (const u of olderUnits) {
    byKey.set(`${u.id}|${u.code}|${u.price}|${u.qty}`, u);
  }
  for (const u of freshUnits) {
    byKey.set(`${u.id}|${u.code}|${u.price}|${u.qty}`, u);
  }

  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
}
