import { fetchAllTrdBuyByBin, GoszakupAuthError, type GoszakupClientOptions } from "./goszakupClient.js";
import { mapGoszakupTender, type GoszakupMapContext } from "./goszakupMapper.js";
import { loadBuyStatusRef, getActiveStatusIds, isActiveBuyStatus, resetStatusRefCache } from "./goszakupStatus.js";
import type { TenderRecord } from "./tenderTypes.js";

export interface GoszakupCollectOptions {
  token?: string;
  activeOnly?: boolean;
  maxPages?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

export interface GoszakupBatchResult {
  tenders: TenderRecord[];
  raw: number;
  filtered: number;
  pages: number;
}

export interface GoszakupSingleResult {
  tenders: TenderRecord[];
  raw: number;
  filtered: number;
  pages: number;
}

export function isGoszakupAvailable(options: { token?: string } = {}): boolean {
  return Boolean(options.token ?? process.env.GOSZAKUP_TOKEN);
}

export async function fetchGoszakupTenders(
  bin: string,
  options: GoszakupCollectOptions = {}
): Promise<GoszakupSingleResult> {
  const token = options.token ?? process.env.GOSZAKUP_TOKEN ?? "";
  if (!token) {
    return { tenders: [], raw: 0, filtered: 0, pages: 0 };
  }

  const clientOpts: GoszakupClientOptions = {
    token,
    maxPages: options.maxPages,
    maxRetries: options.maxRetries,
    fetchFn: options.fetchFn
  };

  const { items, pages } = await fetchAllTrdBuyByBin(bin, clientOpts);

  const statusMap = options.activeOnly
    ? await loadBuyStatusRef(clientOpts)
    : new Map<number, string>();

  const ctx: GoszakupMapContext = { bin, statusMap };
  const activeIds = options.activeOnly ? getActiveStatusIds() : undefined;

  let accepted = 0;
  let rejected = 0;
  const tenders: TenderRecord[] = [];

  for (const item of items) {
    const statusId = item.ref_buy_status_id != null ? Number(item.ref_buy_status_id) : null;
    if (options.activeOnly && !isActiveBuyStatus(statusId, activeIds)) {
      rejected++;
      continue;
    }

    const record = mapGoszakupTender(item, ctx);
    if (record) {
      tenders.push(record);
      accepted++;
    } else {
      rejected++;
    }
  }

  return {
    tenders,
    raw: items.length,
    filtered: rejected,
    pages
  };
}

export { GoszakupAuthError };
