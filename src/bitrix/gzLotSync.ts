import { bidWindowComment, bidWindowFields, isPlaceholderWindow, type LotDateDeal } from "./gzLotDates.js";
import { fetchLotBidWindow, zakupDateToAlmaty, type LotBidWindow, type LotWindowOptions } from "../kz/goszakupLotWindow.js";
import { zakupListAll } from "../kz/zakupPublicApi.js";
import { goszakupGraphqlAll } from "../kz/goszakupGraphql.js";
import { withGzSourceFallback } from "../kz/zakupGzRegistry.js";
import type { BitrixClient } from "./client.js";
import type { ReadOnlyBitrixClient } from "./reporting/readOnlyClient.js";

export const LOT_ORIGINATOR_ID = "scrape2lead-gz-lots";
export const LOT_CATEGORY_ID = 43;

export const LOT_EXISTING_DEAL_FIELDS = [
  "ID",
  "COMPANY_ID",
  "STAGE_SEMANTIC_ID",
  "CLOSED",
  "DATE_CREATE",
  "BEGINDATE",
  "CLOSEDATE",
  "COMMENTS",
  "UF_CRM_6627AEBD85B4D"
] as const;

export interface ExistingLotDeal extends LotDateDeal {
  ID: string;
  COMPANY_ID: string | null;
  STAGE_SEMANTIC_ID?: string | null;
  CLOSED?: string | null;
  DATE_CREATE?: string | null;
  BEGINDATE?: string | null;
  CLOSEDATE?: string | null;
  COMMENTS?: string | null;
  UF_CRM_6627AEBD85B4D?: string | null;
}

export interface GzLotUpdateRow {
  lotNumber: string;
  lotName?: string;
  announceNumber?: string;
  announceName?: string;
  customer?: string;
  quantity?: string;
  amount?: string;
  method?: string;
  status: string;
  month?: string;
  query?: string;
  lotUrl?: string;
  announceUrl?: string;
  customerUrl?: string;
}

export interface LotDealUpdateEvaluation {
  action: "update" | "link_company" | "existing";
  updateFields: Record<string, unknown> | null;
  reasons: string[];
}

export interface LotStatusAndWindow {
  lotNumber: string;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
}

const REGISTRY_DATE = /^(\d{4}-\d{2}-\d{2})/;

function dayOf(value: string | null | undefined): string {
  return REGISTRY_DATE.exec(String(value ?? "").trim())?.[1] ?? "";
}

export function hasBidWindowInComment(comments: string | null | undefined): boolean {
  return Boolean(comments && /Приём заявок:\s*\d{4}-\d{2}-\d{2}/.test(comments));
}

export function updateLotComments(
  existingComments: string | null | undefined,
  row: { lotNumber: string; status: string },
  bidWindow: LotBidWindow | null
): string {
  const windowComment = bidWindowComment(bidWindow);
  const statusLine = `Статус: ${row.status}`;

  if (!existingComments || !existingComments.trim()) {
    return [
      `GZ лот: ${row.lotNumber}`,
      windowComment,
      statusLine
    ].filter(Boolean).join("\n");
  }

  const lines = existingComments.split(/\r?\n/);
  let replacedWindow = false;
  let replacedStatus = false;

  const newLines = lines.map((line) => {
    if (/^Приём заявок:/i.test(line.trim())) {
      replacedWindow = true;
      return windowComment ?? "";
    }
    if (/^Статус:/i.test(line.trim())) {
      replacedStatus = true;
      return statusLine;
    }
    return line;
  }).filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""));

  if (!replacedWindow && windowComment) {
    // Insert after the first line ("GZ лот: ...")
    if (newLines.length > 0) {
      newLines.splice(1, 0, windowComment);
    } else {
      newLines.push(windowComment);
    }
  }

  if (!replacedStatus && statusLine) {
    newLines.push(statusLine);
  }

  return newLines.filter(Boolean).join("\n");
}

export function evaluateLotDealUpdate(
  deal: ExistingLotDeal,
  row: GzLotUpdateRow,
  bidWindow: LotBidWindow | null,
  companyId: string | null
): LotDealUpdateEvaluation {
  const isOpen = deal.STAGE_SEMANTIC_ID !== "S" && deal.STAGE_SEMANTIC_ID !== "F" && deal.CLOSED !== "Y";
  if (!isOpen) {
    return { action: "existing", updateFields: null, reasons: ["deal_closed"] };
  }

  const currentStatus = (deal.UF_CRM_6627AEBD85B4D || "").trim();
  const newStatus = (row.status || "").trim();
  const statusChanged = Boolean(newStatus && currentStatus !== newStatus);
  const datesPlaceholder = isPlaceholderWindow(deal);
  const commentMissingDates = !hasBidWindowInComment(deal.COMMENTS);
  const datesNeedUpdate = datesPlaceholder || commentMissingDates;

  if (statusChanged || datesNeedUpdate) {
    const updateFields: Record<string, unknown> = {};
    const reasons: string[] = [];

    if (statusChanged) {
      updateFields.UF_CRM_6627AEBD85B4D = newStatus;
      reasons.push(`status_changed: ${currentStatus || "-"} -> ${newStatus}`);
    }

    const wf = bidWindowFields(bidWindow);
    if (wf.BEGINDATE && wf.BEGINDATE !== dayOf(deal.BEGINDATE)) {
      updateFields.BEGINDATE = wf.BEGINDATE;
      reasons.push(`begindate_updated: ${wf.BEGINDATE}`);
    }
    if (wf.CLOSEDATE && wf.CLOSEDATE !== dayOf(deal.CLOSEDATE)) {
      updateFields.CLOSEDATE = wf.CLOSEDATE;
      reasons.push(`closedate_updated: ${wf.CLOSEDATE}`);
    }

    const updatedComments = updateLotComments(deal.COMMENTS, row, bidWindow);
    if (updatedComments && updatedComments !== (deal.COMMENTS || "").trim()) {
      updateFields.COMMENTS = updatedComments;
      reasons.push("comments_updated");
    }

    if (companyId && !deal.COMPANY_ID) {
      updateFields.COMPANY_ID = companyId;
      reasons.push(`company_linked: ${companyId}`);
    }

    if (Object.keys(updateFields).length > 0) {
      return { action: "update", updateFields, reasons };
    }
  }

  if (companyId && !deal.COMPANY_ID) {
    return {
      action: "link_company",
      updateFields: { COMPANY_ID: companyId },
      reasons: [`company_linked: ${companyId}`]
    };
  }

  return { action: "existing", updateFields: null, reasons: [] };
}

const LOT_STATUS_GRAPHQL = `query($lot: String) {
  Lots(filter: { lotNumber: $lot }, limit: 1) {
    lotNumber
    RefLotsStatus { nameRu }
    TrdBuy { startDate endDate }
  }
}`;

export async function fetchLotStatusAndWindow(
  lotNumber: string,
  options: LotWindowOptions = {}
): Promise<LotStatusAndWindow | null> {
  return withGzSourceFallback(
    async () => {
      const rows = await zakupListAll<{
        lot_number?: string;
        status?: { name?: string };
        status_name?: string;
        offer_start_date?: string | null;
        offer_end_date?: string | null;
      }>("/public/lots/", { lot_number: lotNumber, system_id: 1 }, options);

      const exact = rows.find((r) => r.lot_number === lotNumber) || rows[0];
      if (!exact) return null;

      const status = exact.status?.name || exact.status_name || null;
      const startDate = zakupDateToAlmaty(exact.offer_start_date);
      const endDate = zakupDateToAlmaty(exact.offer_end_date);

      return {
        lotNumber,
        status,
        startDate,
        endDate
      };
    },
    async () => {
      const lots = await goszakupGraphqlAll<{
        RefLotsStatus?: { nameRu?: string } | null;
        TrdBuy?: { startDate?: unknown; endDate?: unknown } | null;
      }>(
        LOT_STATUS_GRAPHQL,
        { lot: lotNumber },
        "Lots",
        { ...options, token: options.token! }
      );

      const first = lots[0];
      if (!first) return null;

      const cleanStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
      return {
        lotNumber,
        status: cleanStr(first.RefLotsStatus?.nameRu),
        startDate: cleanStr(first.TrdBuy?.startDate),
        endDate: cleanStr(first.TrdBuy?.endDate)
      };
    },
    options.token
  );
}

export interface SyncOpenLotsOptions {
  token?: string | null;
  execute?: boolean;
  todayAlmaty?: string;
  knownLotNumbers?: Set<string>;
}

export interface SyncOpenLotsStats {
  total: number;
  checked: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export interface DealSyncClient {
  listAllBatched<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T[]>;
  updateDeal?(id: string, fields: Record<string, unknown>): Promise<void>;
  call?(method: string, body?: unknown): Promise<unknown>;
}

export async function syncOpenLotDeals(
  client: DealSyncClient,
  options: SyncOpenLotsOptions = {}
): Promise<SyncOpenLotsStats> {
  const stats: SyncOpenLotsStats = { total: 0, checked: 0, updated: 0, unchanged: 0, failed: 0 };
  const filter: Record<string, unknown> = {
    CATEGORY_ID: LOT_CATEGORY_ID,
    ORIGINATOR_ID: LOT_ORIGINATOR_ID,
    STAGE_SEMANTIC_ID: "P"
  };

  const deals = await client.listAllBatched<Record<string, unknown>>("crm.deal.list", {
    filter,
    select: [...LOT_EXISTING_DEAL_FIELDS]
  });

  stats.total = deals.length;
  console.log(`[sync-open] открытых сделок воронки ${LOT_CATEGORY_ID}: ${deals.length}`);

  for (const raw of deals) {
    const origin = String(raw.ORIGIN_ID || "");
    const lotNumber = origin.startsWith("gz-lot:") ? origin.slice(7) : "";
    if (!lotNumber) continue;

    // If deal was already processed in today's active rows and close date is in future, we can skip
    const closeDay = dayOf(raw.CLOSEDATE as string);
    if (options.knownLotNumbers?.has(lotNumber) && options.todayAlmaty && closeDay > options.todayAlmaty) {
      stats.unchanged += 1;
      continue;
    }

    stats.checked += 1;
    try {
      const portalLot = await fetchLotStatusAndWindow(lotNumber, { token: options.token });
      if (!portalLot || !portalLot.status) {
        stats.unchanged += 1;
        continue;
      }

      const existingDeal: ExistingLotDeal = {
        ID: String(raw.ID),
        COMPANY_ID: raw.COMPANY_ID ? String(raw.COMPANY_ID) : null,
        STAGE_SEMANTIC_ID: raw.STAGE_SEMANTIC_ID ? String(raw.STAGE_SEMANTIC_ID) : null,
        CLOSED: raw.CLOSED ? String(raw.CLOSED) : null,
        DATE_CREATE: raw.DATE_CREATE ? String(raw.DATE_CREATE) : null,
        BEGINDATE: raw.BEGINDATE ? String(raw.BEGINDATE) : null,
        CLOSEDATE: raw.CLOSEDATE ? String(raw.CLOSEDATE) : null,
        COMMENTS: raw.COMMENTS ? String(raw.COMMENTS) : null,
        UF_CRM_6627AEBD85B4D: raw.UF_CRM_6627AEBD85B4D ? String(raw.UF_CRM_6627AEBD85B4D) : null
      };

      const bidWindow: LotBidWindow | null = portalLot.startDate || portalLot.endDate
        ? { startDate: portalLot.startDate, endDate: portalLot.endDate }
        : null;

      const evalResult = evaluateLotDealUpdate(
        existingDeal,
        { lotNumber, status: portalLot.status },
        bidWindow,
        existingDeal.COMPANY_ID
      );

      if (evalResult.action === "update" && evalResult.updateFields) {
        if (options.execute) {
          if (client.updateDeal) {
            await client.updateDeal(existingDeal.ID, evalResult.updateFields);
          } else if (client.call) {
            await client.call("crm.deal.update", { id: existingDeal.ID, fields: evalResult.updateFields });
          }
          stats.updated += 1;
          console.log(`[sync-updated] deal ${existingDeal.ID} (lot ${lotNumber}): ${evalResult.reasons.join(", ")}`);
        } else {
          stats.updated += 1;
          console.log(`[dry-run] sync update deal ${existingDeal.ID} (lot ${lotNumber}): ${JSON.stringify(evalResult.updateFields)}`);
        }
      } else {
        stats.unchanged += 1;
      }
    } catch (err) {
      stats.failed += 1;
      console.warn(`[sync-failed] deal ${raw.ID} lot ${lotNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return stats;
}
