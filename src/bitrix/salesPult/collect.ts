import { ReadOnlyBitrixClient, flattenBitrixParams } from "../reporting/readOnlyClient.js";
import type { WonLostMismatchDeal } from "./types.js";
import {
  toAlmatyEndOfDay,
  toAlmatyStartOfDay,
  type CallRecord,
  type StageTransition,
  type DealInfo,
  type RawTask,
  type TopTask
} from "./metrics.js";
import {
  EMPTY_DEBTS,
  buildManagerDebts,
  formatResponsibleNote,
  isExcludedProvider,
  type ManagerDebts
} from "./debts.js";

export interface CollectPultDataParams {
  client: ReadOnlyBitrixClient;
  fromDate: string;
  toDate: string;
  managerIds: string[];
  proposalStages: string[];
  contractStages: string[];
  nowIso?: string;
  maxOverdueDays?: number;
  topTaskCategories?: number[];
  /** Non-working days (YYYY-MM-DD) used to age "new" activities in working days. */
  holidays?: string[];
  webhookUserId?: string | null;
}

export interface UserProfileInfo {
  id: string;
  name: string;
  active: boolean;
}

export interface PultCollectedData {
  asOfDate: string;
  calls: CallRecord[];
  callsAvailable: boolean;
  callsError?: string;
  kpTransitions: StageTransition[];
  contractTransitions: StageTransition[];
  deals: Map<string, DealInfo>;
  tasksByManager: Map<string, TopTask[]>;
  /** Today's debts per manager (independent of the selected period). */
  debtsByManager: Map<string, ManagerDebts>;
  userProfiles: Map<string, UserProfileInfo>;
  taskErrorsByManager: Map<string, string>;
  outcomeMismatches: WonLostMismatchDeal[];
}

interface RawHistoryItem extends Record<string, unknown> {
  ID: string | number;
  OWNER_ID: string | number;
  STAGE_ID: string;
  CREATED_TIME: string;
}

interface RawDealItem extends Record<string, unknown> {
  ID: string | number;
  TITLE?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
  OPPORTUNITY?: string | number | null;
  CATEGORY_ID?: string | number | null;
  STAGE_ID?: string | null;
  STAGE_SEMANTIC_ID?: string | null;
  CLOSED?: string | boolean | null;
  UF_CRM_PLAN_ID?: string | number | null;
  UF_CRM_1782386293000_IU_XLS?: string | number | null;
  UF_CRM_PLAN_STATUS?: string | null;
  UF_CRM_S2L_GZ_OUTCOME?: string | null;
  CLOSEDATE?: string | null;
  DATE_CREATE?: string | null;
}

interface RawActivityItem extends Record<string, unknown> {
  ID: string | number;
  OWNER_ID?: string | number | null;
  OWNER_TYPE_ID?: string | number | null;
  RESPONSIBLE_ID?: string | number | null;
  SUBJECT?: string | null;
  CREATED?: string | null;
  PROVIDER_ID?: string | null;
  DEADLINE?: string | null;
  COMPLETED?: string | null;
}

const SERVICE_PREFIXES = [
  "досье заказчика",
  "[b]досье заказчика",
  "итог закупки",
  "[b]итог закупки",
  "[scrape2lead",
  "[p]",
  "служебное",
  "автоматический",
  "информация по закупке",
  "[b]информация по закупке"
];

/**
 * Extracts portal sign date (YYYY-MM-DD) from Goszakup outcome timeline comments.
 * Requires the comment to start with "Итог закупки:".
 */
export function parsePortalSignDate(comment: string | null | undefined): string | null {
  if (!comment) return null;
  const text = comment.trim();
  if (!text.toLowerCase().startsWith("итог закупки")) return null;
  const match = /договор\s+№[^\s]+\s+от\s+(\d{2})\.(\d{2})\.(\d{4})/i.exec(text)
    || /от\s+(\d{2})\.(\d{2})\.(\d{4})/i.exec(text);
  if (!match) return null;
  const [, d, m, y] = match;
  return `${y}-${m}-${d}`;
}

/**
 * Checks if a timeline comment was generated automatically by system/bot or webhook user.
 */
export function isServiceComment(
  commentText: string,
  authorId?: string | number | null,
  webhookUserId?: string | null
): boolean {
  if (webhookUserId && authorId && String(authorId) === String(webhookUserId)) {
    return true;
  }
  const clean = commentText.trim().toLowerCase();
  for (const prefix of SERVICE_PREFIXES) {
    if (clean.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts webhook user ID from Bitrix REST webhook URL if present.
 * Format: https://example.bitrix24.kz/rest/<user_id>/<token>/
 */
export function extractWebhookUserId(webhookUrl?: string): string | null {
  if (!webhookUrl) return null;
  const match = webhookUrl.match(/\/rest\/(\d+)\//);
  return match ? match[1] : null;
}

/**
 * Loads deals in chunks of at most 50 IDs.
 */
const DEAL_SELECT_FIELDS = [
  "ID",
  "TITLE",
  "ASSIGNED_BY_ID",
  "OPPORTUNITY",
  "CATEGORY_ID",
  "STAGE_ID",
  "STAGE_SEMANTIC_ID",
  "CLOSED",
  "UF_CRM_PLAN_ID",
  "UF_CRM_1782386293000_IU_XLS",
  "UF_CRM_PLAN_STATUS",
  "UF_CRM_S2L_GZ_OUTCOME",
  "CLOSEDATE",
  "DATE_CREATE"
];

export async function fetchDealsBatched(
  client: ReadOnlyBitrixClient,
  dealIds: string[]
): Promise<Map<string, DealInfo>> {
  const result = new Map<string, DealInfo>();
  const uniqueIds = [...new Set(dealIds.map((id) => String(id).trim()).filter(Boolean))];
  const chunkSize = 50;

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const rows = (await client.call("crm.deal.list", {
      filter: { ID: chunk },
      select: DEAL_SELECT_FIELDS
    })) as RawDealItem[];

    if (Array.isArray(rows)) {
      for (const r of rows) {
        const id = String(r.ID);
        const amountNum = parseFloat(String(r.OPPORTUNITY ?? "0").replace(/\s+/g, ""));
        const planNumber =
          String(r.UF_CRM_PLAN_ID ?? "").trim() ||
          String(r.UF_CRM_1782386293000_IU_XLS ?? "").trim() ||
          String(r.TITLE ?? "").match(/\[GZ\s*(\d+)\]/i)?.[1] ||
          null;

        result.set(id, {
          id,
          title: String(r.TITLE ?? `Сделка #${id}`).trim(),
          amount: Number.isFinite(amountNum) ? amountNum : 0,
          assignedById: String(r.ASSIGNED_BY_ID ?? "0"),
          planNumber,
          categoryId: r.CATEGORY_ID,
          stageId: r.STAGE_ID,
          stageSemanticId: r.STAGE_SEMANTIC_ID,
          closed: r.CLOSED,
          planStatus: String(r.UF_CRM_PLAN_STATUS ?? "").trim() || null,
          outcome: r.UF_CRM_S2L_GZ_OUTCOME ? String(r.UF_CRM_S2L_GZ_OUTCOME).trim() : null,
          closeDate: r.CLOSEDATE ? String(r.CLOSEDATE) : null,
          dateCreate: r.DATE_CREATE ? String(r.DATE_CREATE) : null
        });
      }
    }
  }

  return result;
}

/**
 * Extracts latest human manager comment for a deal, skipping service comments and webhook bot comments.
 */
export async function fetchLatestComment(
  client: ReadOnlyBitrixClient,
  dealId: string,
  webhookUserId?: string | null
): Promise<string | null> {
  try {
    const res = (await client.call("crm.timeline.comment.list", {
      filter: { ENTITY_ID: Number(dealId), ENTITY_TYPE: "deal" },
      select: ["ID", "COMMENT", "AUTHOR_ID", "CREATED"],
      order: { ID: "DESC" },
      start: 0
    })) as Array<{ ID?: string | number; COMMENT?: string | null; AUTHOR_ID?: string | number | null }>;

    if (!Array.isArray(res)) return null;

    for (const item of res) {
      if (!item.COMMENT) continue;
      const commentText = String(item.COMMENT).trim();
      if (!commentText) continue;
      if (isServiceComment(commentText, item.AUTHOR_ID, webhookUserId)) {
        continue;
      }
      return commentText;
    }
    return null;
  } catch (err) {
    console.warn(`[salesPult] Failed to fetch latest comment for deal ${dealId}:`, err);
    return null;
  }
}

function isDealActivity(activity: RawActivityItem): boolean {
  const type = activity.OWNER_TYPE_ID;
  return !type || type === 2 || type === "2";
}

/**
 * Collects all data needed for Sales Pult for the given date range.
 */
export async function collectPultData(params: CollectPultDataParams): Promise<PultCollectedData> {
  const {
    client,
    fromDate,
    toDate,
    managerIds,
    proposalStages,
    contractStages,
    nowIso = new Date().toISOString(),
    maxOverdueDays = 30,
    topTaskCategories,
    holidays,
    webhookUserId
  } = params;

  const sinceCreatedTime = toAlmatyStartOfDay(fromDate);
  const endOfDayDeadline = toAlmatyEndOfDay(toDate);

  // 1. Stage transitions for proposals
  const kpTransitions: StageTransition[] = [];
  for (const stage of proposalStages) {
    const items = await client.listAllBatched<RawHistoryItem>(
      "crm.stagehistory.list",
      {
        entityTypeId: 2,
        filter: { STAGE_ID: stage, ">=CREATED_TIME": sinceCreatedTime },
        order: { ID: "ASC" },
        select: ["ID", "OWNER_ID", "STAGE_ID", "CREATED_TIME"]
      },
      "items"
    );
    for (const item of items) {
      kpTransitions.push({
        id: String(item.ID),
        dealId: String(item.OWNER_ID),
        stageId: item.STAGE_ID,
        createdTime: item.CREATED_TIME
      });
    }
  }

  // 2. Stage transitions for contracts
  const contractTransitions: StageTransition[] = [];
  for (const stage of contractStages) {
    const items = await client.listAllBatched<RawHistoryItem>(
      "crm.stagehistory.list",
      {
        entityTypeId: 2,
        filter: { STAGE_ID: stage, ">=CREATED_TIME": sinceCreatedTime },
        order: { ID: "ASC" },
        select: ["ID", "OWNER_ID", "STAGE_ID", "CREATED_TIME"]
      },
      "items"
    );
    for (const item of items) {
      contractTransitions.push({
        id: String(item.ID),
        dealId: String(item.OWNER_ID),
        stageId: item.STAGE_ID,
        createdTime: item.CREATED_TIME
      });
    }
  }

  // 3. Collect deals from all transitions
  const transitionDealIds = [
    ...kpTransitions.map((t) => t.dealId),
    ...contractTransitions.map((t) => t.dealId)
  ];
  const deals = await fetchDealsBatched(client, transitionDealIds);

  // 3b. Collect deals with Goszakup outcome won: or partner:
  const outcomeDealsRaw: RawDealItem[] = [];
  try {
    const wonList = await client.listAllBatched<RawDealItem>("crm.deal.list", {
      filter: { "%UF_CRM_S2L_GZ_OUTCOME": "won:" },
      select: DEAL_SELECT_FIELDS
    });
    outcomeDealsRaw.push(...wonList.filter((d) => String(d.UF_CRM_S2L_GZ_OUTCOME ?? "").startsWith("won:")));
  } catch (err) {
    console.warn("[collectPultData] Failed to load won: outcome deals:", err);
  }

  try {
    const partnerList = await client.listAllBatched<RawDealItem>("crm.deal.list", {
      filter: { "%UF_CRM_S2L_GZ_OUTCOME": "partner:" },
      select: DEAL_SELECT_FIELDS
    });
    outcomeDealsRaw.push(...partnerList.filter((d) => String(d.UF_CRM_S2L_GZ_OUTCOME ?? "").startsWith("partner:")));
  } catch (err) {
    console.warn("[collectPultData] Failed to load partner: outcome deals:", err);
  }

  for (const r of outcomeDealsRaw) {
    const id = String(r.ID);
    const amountNum = parseFloat(String(r.OPPORTUNITY ?? "0").replace(/\s+/g, ""));
    const planNumber =
      String(r.UF_CRM_PLAN_ID ?? "").trim() ||
      String(r.UF_CRM_1782386293000_IU_XLS ?? "").trim() ||
      String(r.TITLE ?? "").match(/\[GZ\s*(\d+)\]/i)?.[1] ||
      null;

    const existing = deals.get(id);
    if (!existing) {
      deals.set(id, {
        id,
        title: String(r.TITLE ?? `Сделка #${id}`).trim(),
        amount: Number.isFinite(amountNum) ? amountNum : 0,
        assignedById: String(r.ASSIGNED_BY_ID ?? "0"),
        planNumber,
        categoryId: r.CATEGORY_ID,
        stageId: r.STAGE_ID,
        stageSemanticId: r.STAGE_SEMANTIC_ID,
        closed: r.CLOSED,
        planStatus: String(r.UF_CRM_PLAN_STATUS ?? "").trim() || null,
        outcome: r.UF_CRM_S2L_GZ_OUTCOME ? String(r.UF_CRM_S2L_GZ_OUTCOME).trim() : null,
        closeDate: r.CLOSEDATE ? String(r.CLOSEDATE) : null,
        dateCreate: r.DATE_CREATE ? String(r.DATE_CREATE) : null
      });
    } else {
      existing.outcome = r.UF_CRM_S2L_GZ_OUTCOME ? String(r.UF_CRM_S2L_GZ_OUTCOME).trim() : existing.outcome;
      existing.closeDate = r.CLOSEDATE ? String(r.CLOSEDATE) : existing.closeDate;
      existing.dateCreate = r.DATE_CREATE ? String(r.DATE_CREATE) : existing.dateCreate;
    }
  }

  // 3c. Extract portalSignDate for all won/partner deals by reading their timeline comments in batch
  const portalWonDeals = Array.from(deals.values()).filter((d) => {
    const oc = String(d.outcome ?? "");
    return oc.startsWith("won:") || oc.startsWith("partner:");
  });

  if (portalWonDeals.length > 0) {
    const batchChunkSize = 50;
    for (let i = 0; i < portalWonDeals.length; i += batchChunkSize) {
      const chunk = portalWonDeals.slice(i, i + batchChunkSize);
      const cmd: Record<string, string> = {};
      for (const d of chunk) {
        cmd[`c${d.id}`] = `crm.timeline.comment.list?${flattenBitrixParams({
          filter: { ENTITY_ID: Number(d.id), ENTITY_TYPE: "deal" },
          select: ["ID", "COMMENT", "CREATED"]
        })}`;
      }
      try {
        const batchRes = (await client.call("batch", { halt: 0, cmd })) as {
          result?: Record<string, Array<{ COMMENT?: string }>>;
        };
        const results = batchRes?.result || {};
        for (const d of chunk) {
          const comments = results[`c${d.id}`];
          if (Array.isArray(comments)) {
            for (const c of comments) {
              const signDate = parsePortalSignDate(c.COMMENT);
              if (signDate) {
                d.portalSignDate = signDate;
                break;
              }
            }
          }
        }
      } catch (err) {
        console.warn("[collectPultData] Failed to batch load comments for won deals:", err);
      }
    }
  }

  // 4. Calls via voximplant.statistic.get
  let calls: CallRecord[] = [];
  let callsAvailable = true;
  let callsError: string | undefined;

  try {
    const rawCalls = await client.listAllBatched<Record<string, unknown>>(
      "voximplant.statistic.get",
      {
        FILTER: { ">=CALL_START_DATE": sinceCreatedTime },
        SORT: "ID",
        ORDER: "ASC"
      }
    );

    calls = rawCalls.map((c) => ({
      id: String(c.ID),
      userId: String(c.PORTAL_USER_ID ?? ""),
      statusCode: String(c.CALL_FAILED_CODE ?? ""),
      durationSeconds: parseInt(String(c.CALL_DURATION ?? "0"), 10) || 0,
      startDate: String(c.CALL_START_DATE ?? "")
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("insufficient_scope") || message.includes("telephony")) {
      callsAvailable = false;
      callsError = "insufficient_scope: требуется scope telephony в вебхуке";
    } else {
      // All other errors crash the run!
      throw err;
    }
  }

  // 5. User Profiles
  const userProfiles = new Map<string, UserProfileInfo>();
  for (const mId of managerIds) {
    try {
      const res = (await client.call("im.user.get", { ID: Number(mId) })) as {
        name?: string;
        first_name?: string;
        last_name?: string;
        active?: boolean;
      };
      const name = res?.name || [res?.first_name, res?.last_name].filter(Boolean).join(" ");
      userProfiles.set(mId, {
        id: mId,
        name: name || `Менеджер ${mId}`,
        active: res?.active !== false
      });
    } catch {
      userProfiles.set(mId, { id: mId, name: `Менеджер ${mId}`, active: true });
    }
  }

  // 6. Top tasks per manager: crm.activity.list per manager
  const tasksByManager = new Map<string, TopTask[]>();
  const debtsByManager = new Map<string, ManagerDebts>();
  const taskErrorsByManager = new Map<string, string>();
  const activityDealIds: string[] = [];

  interface ActivityHolder {
    managerId: string;
    item: RawActivityItem;
  }
  const collectedActivities: ActivityHolder[] = [];

  for (const mId of managerIds) {
    try {
      const acts = await client.listAllBatched<RawActivityItem>(
        "crm.activity.list",
        {
          filter: {
            RESPONSIBLE_ID: Number(mId),
            COMPLETED: "N",
            "<=DEADLINE": endOfDayDeadline
          },
          order: { DEADLINE: "ASC" },
          select: ["ID", "OWNER_ID", "OWNER_TYPE_ID", "RESPONSIBLE_ID", "SUBJECT", "CREATED", "PROVIDER_ID", "DEADLINE", "COMPLETED"]
        }
      );

      for (const a of acts) {
        collectedActivities.push({ managerId: mId, item: a });
        if (a.OWNER_ID && (a.OWNER_TYPE_ID === 2 || a.OWNER_TYPE_ID === "2" || !a.OWNER_TYPE_ID)) {
          activityDealIds.push(String(a.OWNER_ID));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      taskErrorsByManager.set(mId, message);
    }
  }

  // Fetch deals referenced in activities if missing from deals map
  const missingDealIds = activityDealIds.filter((id) => !deals.has(id));
  if (missingDealIds.length > 0) {
    const additionalDeals = await fetchDealsBatched(client, missingDealIds);
    for (const [id, deal] of additionalDeals.entries()) {
      deals.set(id, deal);
    }
  }

  // 7. For each manager, build candidate tasks, rank top 5, then fetch comments ONLY for top 5
  const managerIdSet = new Set(managerIds.map(String));
  const rawTasksByManager = new Map<string, RawTask[]>();
  for (const mId of managerIds) {
    rawTasksByManager.set(mId, []);
  }

  for (const { managerId: activityManagerId, item: a } of collectedActivities) {
    if (isExcludedProvider(a.PROVIDER_ID) || !a.DEADLINE || !isDealActivity(a)) continue;
    const dealId = String(a.OWNER_ID ?? "");
    const deal = deals.get(dealId);
    const title = deal ? deal.title : String(a.SUBJECT ?? "Задача");
    const amount = deal ? deal.amount : 0;
    const planNumber = deal?.planNumber ?? null;

    const dealAssignedId = deal?.assignedById ? String(deal.assignedById) : "";
    const targetManagerId = dealAssignedId && managerIdSet.has(dealAssignedId)
      ? dealAssignedId
      : activityManagerId;

    let responsibleNote: string | null = null;
    if (dealAssignedId && dealAssignedId !== activityManagerId && targetManagerId === dealAssignedId) {
      const rawName = userProfiles.get(activityManagerId)?.name || activityManagerId;
      responsibleNote = formatResponsibleNote(rawName);
    }

    const taskList = rawTasksByManager.get(targetManagerId);
    if (taskList) {
      taskList.push({
        id: String(a.ID),
        dealId,
        title,
        deadline: String(a.DEADLINE ?? ""),
        amount,
        planNumber,
        categoryId: deal?.categoryId,
        stageId: deal?.stageId,
        stageSemanticId: deal?.stageSemanticId,
        closed: deal?.closed,
        planStatus: deal?.planStatus ?? null,
        subject: String(a.SUBJECT ?? "").trim(),
        created: String(a.CREATED ?? ""),
        responsibleNote
      });
    }
  }

  for (const mId of managerIds) {
    if (taskErrorsByManager.has(mId)) {
      tasksByManager.set(mId, []);
      debtsByManager.set(mId, EMPTY_DEBTS);
      continue;
    }

    const managerRawTasks = rawTasksByManager.get(mId) || [];

    // Step A: classify activities into debts and rank the top 5 (one per deal, see debts.ts)
    const { debts, top: top5 } = buildManagerDebts(managerRawTasks, {
      nowIso,
      holidays,
      maxOverdueDays,
      categories: topTaskCategories
    });
    debtsByManager.set(mId, debts);

    // Step B: Load timeline comments ONLY for the final top-5 deals
    for (const task of top5) {
      if (task.dealId) {
        task.lastComment = await fetchLatestComment(client, task.dealId, webhookUserId);
      }
    }

    tasksByManager.set(mId, top5);
  }

  // 8. Identify outcome mismatches (won on portal, but stage is lost in CRM; duplicates are excluded)
  const outcomeMismatches: WonLostMismatchDeal[] = [];
  for (const d of deals.values()) {
    const oc = String(d.outcome ?? "");
    if ((oc.startsWith("won:") || oc.startsWith("partner:")) && d.stageSemanticId === "F") {
      const stageUpper = String(d.stageId ?? "").toUpperCase();
      if (stageUpper.includes("DUPLICATE") || stageUpper.includes("DOUBLE")) continue;
      const mgrName = userProfiles.get(String(d.assignedById))?.name || `Менеджер ${d.assignedById}`;
      outcomeMismatches.push({
        id: d.id,
        title: d.title,
        amount: d.amount,
        managerId: d.assignedById,
        managerName: mgrName,
        stageId: d.stageId,
        outcome: oc,
        portalSignDate: d.portalSignDate
      });
    }
  }

  // 9. Update debts.wonOnPortalNotClosed for each manager
  for (const mId of managerIds) {
    const debts = debtsByManager.get(mId) || { ...EMPTY_DEBTS };
    const wonNotClosed = Array.from(deals.values()).filter((d) => {
      if (String(d.assignedById) !== String(mId)) return false;
      const oc = String(d.outcome ?? "");
      const isWon = oc.startsWith("won:") || oc.startsWith("partner:");
      if (!isWon) return false;
      return d.stageSemanticId !== "S" && d.stageSemanticId !== "F";
    }).length;
    debts.wonOnPortalNotClosed = wonNotClosed;
    debtsByManager.set(mId, debts);
  }

  return {
    asOfDate: toDate,
    calls,
    callsAvailable,
    callsError,
    kpTransitions,
    contractTransitions,
    deals,
    tasksByManager,
    debtsByManager,
    userProfiles,
    taskErrorsByManager,
    outcomeMismatches
  };
}
