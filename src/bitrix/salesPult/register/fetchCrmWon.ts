import type { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import type { StageTransition } from "../metrics.js";
import type { UserProfileInfo } from "../collect.js";
import type { CrmWonDeal } from "./types.js";
import { toAlmatyStartOfDay } from "../metrics.js";

export const DEFAULT_CONTRACT_STAGES = ["C9:WON", "C41:WON", "C43:WON"];

function getLastDayOfMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yearMonth}-${String(d).padStart(2, "0")}`;
}

export function getNextMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const nextDate = new Date(Date.UTC(y, m, 1));
  const ny = nextDate.getUTCFullYear();
  const nm = String(nextDate.getUTCMonth() + 1).padStart(2, "0");
  return `${ny}-${nm}`;
}

export function toAlmatyMonth(createdTime: string): string {
  const ms = Date.parse(createdTime);
  if (Number.isNaN(ms)) return "";
  return new Date(ms + 5 * 3600000).toISOString().slice(0, 7);
}

interface RawHistoryItem extends Record<string, unknown> {
  ID: string | number;
  OWNER_ID: string | number;
  STAGE_ID: string;
  CREATED_TIME: string;
}

/**
 * Hydrates full deal information (title, company, opportunity, manager, date) for given deal IDs.
 */
async function hydrateDeals(
  client: ReadOnlyBitrixClient,
  dealIds: string[],
  userProfiles: Map<string, UserProfileInfo>
): Promise<Map<string, CrmWonDeal>> {
  const dealMap = new Map<string, CrmWonDeal>();
  if (dealIds.length === 0) return dealMap;

  const rawDeals: Array<{
    ID: string | number;
    TITLE?: string | null;
    OPPORTUNITY?: string | number | null;
    COMPANY_ID?: string | number | null;
    ASSIGNED_BY_ID?: string | number | null;
    CLOSEDATE?: string | null;
    DATE_CREATE?: string | null;
  }> = [];

  const batchSize = 50;
  for (let i = 0; i < dealIds.length; i += batchSize) {
    const chunk = dealIds.slice(i, i + batchSize);
    const rows = (await client.call("crm.deal.list", {
      filter: { ID: chunk },
      select: ["ID", "TITLE", "OPPORTUNITY", "COMPANY_ID", "ASSIGNED_BY_ID", "CLOSEDATE", "DATE_CREATE"]
    })) as Array<Record<string, unknown>>;
    if (Array.isArray(rows)) {
      rawDeals.push(...(rows as typeof rawDeals));
    }
  }

  const companyIds = Array.from(
    new Set(rawDeals.map((d) => String(d.COMPANY_ID || "")).filter((id) => id && id !== "0"))
  );
  const companyMap = new Map<string, string>();

  for (let i = 0; i < companyIds.length; i += batchSize) {
    const chunk = companyIds.slice(i, i + batchSize);
    const rows = (await client.call("crm.company.list", {
      filter: { ID: chunk },
      select: ["ID", "TITLE"]
    })) as Array<{ ID: string | number; TITLE?: string }>;
    if (Array.isArray(rows)) {
      for (const c of rows) {
        if (c.ID && c.TITLE) companyMap.set(String(c.ID), c.TITLE);
      }
    }
  }

  for (const d of rawDeals) {
    const mId = String(d.ASSIGNED_BY_ID || "");
    const profile = userProfiles.get(mId);
    const managerName = profile?.name || mId;
    const companyName = companyMap.get(String(d.COMPANY_ID || "")) || "";
    const id = String(d.ID);
    dealMap.set(id, {
      id,
      title: String(d.TITLE || ""),
      company: companyName,
      amount: Number(d.OPPORTUNITY || 0),
      manager: managerName,
      date: String(d.CLOSEDATE || d.DATE_CREATE || "").slice(0, 10)
    });
  }

  return dealMap;
}

export async function fetchCrmWonDealsForRegister(
  client: ReadOnlyBitrixClient,
  contractTransitions?: StageTransition[],
  userProfiles: Map<string, UserProfileInfo> = new Map()
): Promise<CrmWonDeal[]> {
  if (!contractTransitions || contractTransitions.length === 0) return [];
  const wonDealIds = Array.from(new Set(contractTransitions.map((t) => t.dealId)));
  if (wonDealIds.length === 0) return [];

  const dealMap = await hydrateDeals(client, wonDealIds, userProfiles);
  return Array.from(dealMap.values());
}

export interface FetchCrmWonDealsOptions {
  contractStages?: string[];
}

/**
 * Fetches all won deals from Bitrix CRM for each month in the list using crm.stagehistory.list
 * filtered by stages.contracts and batched with listAllBatched (identical to block 04).
 * For each month, includes transitions of that month and the next month (to capture late-won contracts).
 */
export async function fetchCrmWonDealsForMonths(
  client: ReadOnlyBitrixClient,
  userProfiles: Map<string, UserProfileInfo>,
  months: string[],
  options?: FetchCrmWonDealsOptions
): Promise<Map<string, CrmWonDeal[]>> {
  const result = new Map<string, CrmWonDeal[]>();
  if (!months || months.length === 0) return result;

  const contractStages = options?.contractStages || DEFAULT_CONTRACT_STAGES;
  const sortedMonths = [...months].sort();
  const earliestMonth = sortedMonths[0];
  const sinceCreatedTime = toAlmatyStartOfDay(`${earliestMonth}-01`);

  const dealTransitionMonths = new Map<string, Set<string>>();

  for (const stage of contractStages) {
    let items: RawHistoryItem[];
    try {
      items = await client.listAllBatched<RawHistoryItem>(
        "crm.stagehistory.list",
        {
          entityTypeId: 2,
          filter: {
            STAGE_ID: stage,
            ">=CREATED_TIME": sinceCreatedTime
          },
          order: { ID: "ASC" },
          select: ["ID", "OWNER_ID", "STAGE_ID", "CREATED_TIME"]
        },
        "items"
      );
    } catch (err) {
      throw new Error(
        `Ошибка загрузки выигрышей CRM по стадии ${stage}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    for (const item of items) {
      if (!item.OWNER_ID) continue;
      const dealId = String(item.OWNER_ID);
      const m = toAlmatyMonth(item.CREATED_TIME);
      if (!m) continue;

      let mSet = dealTransitionMonths.get(dealId);
      if (!mSet) {
        mSet = new Set<string>();
        dealTransitionMonths.set(dealId, mSet);
      }
      mSet.add(m);
    }
  }

  const allDealIds = Array.from(dealTransitionMonths.keys());
  const dealMap = await hydrateDeals(client, allDealIds, userProfiles);

  const allMonthsToQuery = new Set<string>(months);
  for (const m of months) {
    allMonthsToQuery.add(getNextMonth(m));
  }

  for (const month of allMonthsToQuery) {
    const dealsForMonth: CrmWonDeal[] = [];

    for (const [dealId, mSet] of dealTransitionMonths.entries()) {
      if (mSet.has(month)) {
        const d = dealMap.get(dealId);
        if (d) {
          dealsForMonth.push(d);
        }
      }
    }

    result.set(month, dealsForMonth);
  }

  return result;
}
