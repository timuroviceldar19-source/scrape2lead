import type { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import type { StageTransition } from "../metrics.js";
import type { UserProfileInfo } from "../collect.js";
import type { CrmWonDeal } from "./types.js";

export async function fetchCrmWonDealsForRegister(
  client: ReadOnlyBitrixClient,
  contractTransitions: StageTransition[],
  userProfiles: Map<string, UserProfileInfo>
): Promise<CrmWonDeal[]> {
  const wonDealIds = Array.from(new Set(contractTransitions.map((t) => t.dealId)));
  if (wonDealIds.length === 0) return [];

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
  for (let i = 0; i < wonDealIds.length; i += batchSize) {
    const chunk = wonDealIds.slice(i, i + batchSize);
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

  return rawDeals.map((d) => {
    const mId = String(d.ASSIGNED_BY_ID || "");
    const profile = userProfiles.get(mId);
    const managerName = profile?.name || mId;
    const companyName = companyMap.get(String(d.COMPANY_ID || "")) || "";
    return {
      id: String(d.ID),
      title: String(d.TITLE || ""),
      company: companyName,
      amount: Number(d.OPPORTUNITY || 0),
      manager: managerName,
      date: String(d.CLOSEDATE || d.DATE_CREATE || "").slice(0, 10)
    };
  });
}
