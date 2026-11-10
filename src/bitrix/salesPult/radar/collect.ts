import { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import { enrichManagerNames } from "../managerNames.js";
import { buildRadarView, type RadarRawDeal } from "./aggregate.js";
import type { RadarView } from "./types.js";
import type { NormalizedPlanDeal } from "../plans/types.js";

export const RADAR_LOT_SELECT_FIELDS = [
  "ID",
  "TITLE",
  "STAGE_ID",
  "STAGE_SEMANTIC_ID",
  "CLOSED",
  "ASSIGNED_BY_ID",
  "COMPANY_ID",
  "DATE_CREATE",
  "BEGINDATE",
  "CLOSEDATE",
  "OPPORTUNITY",
  "ORIGIN_ID",
  "COMMENTS",
  "UF_CRM_6627AEBD4503E",
  "UF_CRM_6627AEBD54B8D",
  "UF_CRM_6627AEBD67FFF",
  "UF_CRM_6627AEBD72587",
  "UF_CRM_6627AEBD85B4D"
] as const;

export interface CollectRadarOptions {
  reader: ReadOnlyBitrixClient;
  asOfDate: string;
  asOfTime?: string;
  portal?: string;
  userProfiles?: ReadonlyMap<string, { name: string }>;
  groups?: Array<{ managers: Array<{ id: string; name: string }> }>;
  planDeals?: NormalizedPlanDeal[];
}

export async function collectRadarView(options: CollectRadarOptions): Promise<RadarView> {
  const started = performance.now();
  try {
    const lotRows = await options.reader.listAllBatched<Record<string, unknown>>("crm.deal.list", {
      filter: { CATEGORY_ID: 43, ORIGINATOR_ID: "scrape2lead-gz-lots" },
      select: [...RADAR_LOT_SELECT_FIELDS],
      order: { ID: "DESC" }
    });

    const names = new Map<string, string>();
    for (const g of options.groups || []) {
      for (const m of g.managers) names.set(String(m.id), m.name);
    }
    for (const [id, p] of options.userProfiles || []) {
      names.set(String(id), p.name);
    }

    const managerIdsToEnrich = lotRows
      .map(r => String(r.ASSIGNED_BY_ID || ""))
      .filter(id => Boolean(id) && !names.has(id));

    if (managerIdsToEnrich.length > 0) {
      const loadedNames = new Map([...(options.userProfiles || [])].map(([id, profile]) => [id, profile.name]));
      await enrichManagerNames(options.reader, managerIdsToEnrich, loadedNames);
      for (const [id, name] of loadedNames) {
        if (!names.has(id) || name !== `сотрудник ID ${id}`) names.set(id, name);
      }
    }

    const view = buildRadarView({
      lotDeals: lotRows as unknown as RadarRawDeal[],
      planDeals: options.planDeals,
      asOfDate: options.asOfDate,
      asOfTime: options.asOfTime,
      portal: options.portal,
      managerNames: names
    });

    console.log(
      `[Радар] лотов воронки 43: ${lotRows.length}, ИП (подать: ${view.ip.submitToday.length}, обсуждение: ${view.ip.discussion.length}, 2й шанс: ${view.ip.secondChance.length}), КТ (подать: ${view.kt.submitToday.length}) (${Math.round(performance.now() - started)} мс)`
    );

    return view;
  } catch (err) {
    console.warn(`[Радар] ошибка сбора: ${err instanceof Error ? err.message : String(err)}`);
    return {
      asOf: options.asOfDate,
      error: "Не удалось загрузить данные Радара из Битрикс24.",
      ip: {
        group: "ИП",
        kpis: { totalCount: 0, totalSum: 0, submitCount: 0, submitSum: 0, discussionCount: 0, discussionSum: 0, secondChanceCount: 0, secondChanceSum: 0 },
        submitToday: [],
        discussion: [],
        secondChance: []
      },
      kt: {
        group: "КТ",
        kpis: { totalCount: 0, totalSum: 0, submitCount: 0, submitSum: 0, discussionCount: 0, discussionSum: 0, secondChanceCount: 0, secondChanceSum: 0 },
        submitToday: [],
        discussion: [],
        secondChance: []
      }
    };
  }
}
