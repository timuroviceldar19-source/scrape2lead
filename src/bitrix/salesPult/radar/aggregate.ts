import type {
  RadarCard,
  RadarColumnKey,
  RadarGroupView,
  RadarKpis,
  RadarView
} from "./types.js";
export type { RadarCard, RadarColumnKey, RadarGroupView, RadarKpis, RadarView };
import type { NormalizedPlanDeal } from "../plans/types.js";
import { loadMarketConfig } from "../../../kz/market/config.js";
import { toCurrentPortalUrl } from "../../../kz/goszakupOrigin.js";

export interface RadarRawDeal {
  ID: string | number;
  TITLE?: string | null;
  STAGE_ID?: string | null;
  STAGE_SEMANTIC_ID?: string | null;
  CLOSED?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
  COMPANY_ID?: string | number | null;
  DATE_CREATE?: string | null;
  BEGINDATE?: string | null;
  CLOSEDATE?: string | null;
  OPPORTUNITY?: string | number | null;
  ORIGIN_ID?: string | null;
  COMMENTS?: string | null;
  UF_CRM_6627AEBD4503E?: string | null; // method
  UF_CRM_6627AEBD54B8D?: string | null; // itemName
  UF_CRM_6627AEBD67FFF?: string | number | null; // quantity
  UF_CRM_6627AEBD72587?: string | null; // customer
  UF_CRM_6627AEBD85B4D?: string | null; // status
}

export interface ParseRadarDealOptions {
  asOfDate: string;
  asOfTime?: string;
  portal?: string;
  managerNames?: ReadonlyMap<string, string>;
}

const EDUCATION_KIT_NAME = /учебн.*комплект|комплект.*учебн/;

export function classifyProductGroup(code: string, name: string): "ИП" | "КТ" | null {
  if (code) {
    if (code.startsWith("262030.100.") && !/^262030\.100\.0000(11|13|21|43)$/.test(code)) return null;
    const groups = loadMarketConfig().groups;
    for (const group of ["ИП", "КТ"] as const) {
      if (groups[group].prefixes.some(prefix => code.startsWith(prefix))) return group;
    }
    return null;
  }
  const n = (name || "").toLowerCase();
  if (/услуг|ремонт|обслуживан|аренд/.test(n)) return null;
  if (/панел|доск|мультимедийн.*систем|систем.*мультимедийн/.test(n) || EDUCATION_KIT_NAME.test(n)) return "ИП";
  if (/компьютер|системн.*блок|ноутбук|лэптоп|моноблок|монитор|мфу|многофункциональн|принтер/.test(n)) return "КТ";
  return null;
}

export function classifyKind(group: "ИП" | "КТ", code: string, name: string): string {
  const n = (name || "").toLowerCase();
  if (group === "ИП") {
    if (code === "329959.900.000019" || (!code && EDUCATION_KIT_NAME.test(n))) return "Учебные комплекты";
    if (/^262030\.100\.000021$/.test(code) || code.startsWith("279020") || /панел/.test(n)) return "Интерактивные панели";
    if (/^262030\.100\.000043$/.test(code) || /доск/.test(n)) return "Интерактивные и спец. доски";
    if (/^262030\.100\.0000(11|13)$/.test(code)) return "Мультимедийные системы";
    return "Прочее ИП";
  }
  if (/ноутбук|лэптоп/.test(n) || code.startsWith("262011")) return "Ноутбуки";
  if (/моноблок/.test(n)) return "Моноблоки";
  if (/монитор/.test(n)) return "Мониторы";
  if (/мфу|многофункциональн|принтер/.test(n)) return "МФУ и принтеры";
  if (/компьютер|системн.*блок/.test(n) || code.startsWith("262013")) return "Компьютеры и системные блоки";
  return "Прочее КТ";
}

function cleanText(v: unknown): string {
  if (Array.isArray(v)) return cleanText(v[0]);
  return v == null || v === false ? "" : String(v).trim();
}

function parseNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const s = String(value ?? "").replace(/[\s\u00a0₸]/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function httpsUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    // Старые комментарии ссылаются на goszakup.gov.kz: домен не открывается, показываем новый.
    const u = new URL(toCurrentPortalUrl(url));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

function parseAlmatyTimestamp(str: string | null | undefined): number | null {
  if (!str) return null;
  const s = str.trim();
  // Format: "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss"
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2})(?::\d{2})?)?/.exec(s);
  if (!m) return null;
  const date = m[1];
  const time = m[2] ? `${m[2]}:00` : "23:59:59";
  const ms = Date.parse(`${date}T${time}+05:00`);
  return Number.isFinite(ms) ? ms : null;
}

export function parseRadarLotDeal(raw: RadarRawDeal, options: ParseRadarDealOptions): RadarCard | null {
  const id = cleanText(raw.ID);
  if (!id) return null;

  const title = cleanText(raw.TITLE);
  const origin = cleanText(raw.ORIGIN_ID);
  const lotNumber = origin.startsWith("gz-lot:") ? origin.slice(7) : /GZ лот:\s*([^\s()]+)/i.exec(cleanText(raw.COMMENTS))?.[1] || "";
  const planNumber = (/^(\d+)/.exec(lotNumber)?.[1]) || "";

  const itemName = cleanText(raw.UF_CRM_6627AEBD54B8D) || title.split("—")[1]?.trim() || title;
  const group = classifyProductGroup("", itemName);
  if (!group) return null;
  const kind = classifyKind(group, "", itemName);

  const comments = cleanText(raw.COMMENTS);
  const method = cleanText(raw.UF_CRM_6627AEBD4503E) || /Способ закупки:\s*([^\n\r]+)/i.exec(comments)?.[1]?.trim() || "Не указан";
  const customerName = cleanText(raw.UF_CRM_6627AEBD72587) || /Заказчик:\s*([^\n\r]+)/i.exec(comments)?.[1]?.trim() || "Заказчик не указан";
  const customerBin = (/БИН\s*:?\s*(\d{12})/i.exec(customerName)?.[1]) || (/БИН\s*:?\s*(\d{12})/i.exec(comments)?.[1]) || "";
  const status = cleanText(raw.UF_CRM_6627AEBD85B4D) || /Статус:\s*([^\n\r]+)/i.exec(comments)?.[1]?.trim() || "Опубликован";

  const lotUrl = httpsUrl(/Лот:\s*(https?:\/\/[^\s\n\r]+)/i.exec(comments)?.[1]);
  const announceUrl = httpsUrl(/Объявление:\s*(https?:\/\/[^\s\n\r]+)/i.exec(comments)?.[1]);
  const announceNumber = /Объявление:\s*(\d+)/i.exec(comments)?.[1] || "";
  const announceName = /Объявление:\s*\d+\s*—\s*([^\n\r]+)/i.exec(comments)?.[1]?.trim() || "";

  // Bid window parsing from comments
  const windowMatch = /Приём заявок:\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?|-)\s*—\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?|-)/i.exec(comments);
  let startAt: string | null = null;
  let endAt: string | null = null;

  if (windowMatch) {
    if (windowMatch[1] && windowMatch[1] !== "-") startAt = windowMatch[1].trim();
    if (windowMatch[2] && windowMatch[2] !== "-") endAt = windowMatch[2].trim();
  }
  if (!startAt && raw.BEGINDATE) startAt = cleanText(raw.BEGINDATE).slice(0, 10);
  if (!endAt && raw.CLOSEDATE) endAt = cleanText(raw.CLOSEDATE).slice(0, 10);

  const managerId = cleanText(raw.ASSIGNED_BY_ID);
  const managerName = options.managerNames?.get(managerId) || (managerId ? `ID ${managerId}` : "Не назначен");
  const portal = (options.portal || "").replace(/\/+$/, "");
  const dealUrl = portal ? `${portal}/crm/deal/details/${encodeURIComponent(id)}/` : "";

  const qty = parseNumber(raw.UF_CRM_6627AEBD67FFF);
  const sum = parseNumber(raw.OPPORTUNITY);

  const asOfTimeMs = options.asOfTime
    ? Date.parse(options.asOfTime)
    : Date.parse(`${options.asOfDate}T12:00:00+05:00`);

  let hoursLeft: number | null = null;
  let isToday = false;
  let isWithin48h = false;

  if (endAt) {
    const endAtMs = parseAlmatyTimestamp(endAt);
    if (endAtMs !== null) {
      const msLeft = endAtMs - asOfTimeMs;
      hoursLeft = msLeft / 3_600_000;
      isToday = endAt.startsWith(options.asOfDate);
      isWithin48h = hoursLeft > 0 && hoursLeft <= 48;
    }
  }

  const semantic = cleanText(raw.STAGE_SEMANTIC_ID);
  const closed = cleanText(raw.CLOSED);
  const isOpen = semantic !== "S" && semantic !== "F" && closed !== "Y";
  const stage = cleanText(raw.STAGE_ID);
  const isNewStage = isOpen && (stage === "NEW" || stage.endsWith(":NEW"));

  let column: RadarColumnKey;
  const statusLower = status.toLowerCase();

  if (/не состоялась/.test(statusLower)) {
    column = "secondChance";
  } else if (!isOpen) {
    return null; // Closed won/lost deals don't stay on active radar
  } else if (hoursLeft !== null && hoursLeft <= 0) {
    return null; // Expired bid window is no longer active for submission/discussion
  } else if (/прием заявок|прием ценовых|дополнение заявок|ожидание проведения аукциона/i.test(statusLower)) {
    column = "submitToday";
  } else if (/опубликован|изменена документация|предварительное обсуждение/i.test(statusLower)) {
    column = "discussion";
  } else if (startAt && parseAlmatyTimestamp(startAt)! > asOfTimeMs) {
    column = "discussion";
  } else {
    column = "submitToday";
  }

  return {
    id,
    dealUrl,
    sourceType: "lot",
    lotNumber,
    planNumber,
    announceNumber,
    announceName,
    lotUrl,
    announceUrl,
    title,
    itemName,
    qty,
    sum,
    method,
    status,
    group,
    kind,
    customerName,
    customerBin,
    managerId,
    managerName,
    startAt,
    endAt,
    hoursLeft,
    isToday,
    isWithin48h,
    column,
    isNewStage
  };
}

export function parseRadarPlanDeal(plan: NormalizedPlanDeal, options: ParseRadarDealOptions): RadarCard | null {
  const isFailed = plan.outcomeKey.startsWith("failed:") || /не состоялась/i.test(plan.portalStatus);
  if (!isFailed || plan.isWonCrm) return null;

  return {
    id: plan.id,
    dealUrl: plan.dealUrl,
    sourceType: "plan",
    planNumber: plan.planNumber,
    lotUrl: "",
    announceUrl: httpsUrl(plan.planUrl),
    title: plan.itemName,
    itemName: plan.itemName,
    qty: plan.qty,
    sum: plan.sum,
    method: plan.method,
    status: plan.portalStatus,
    group: plan.group,
    kind: plan.kind,
    customerName: plan.customerName,
    customerBin: plan.customerBin,
    managerId: plan.managerId,
    managerName: plan.managerName,
    startAt: null,
    endAt: null,
    hoursLeft: null,
    isToday: false,
    isWithin48h: false,
    column: "secondChance",
    isNewStage: plan.isNewStage
  };
}

export interface BuildRadarViewOptions extends ParseRadarDealOptions {
  lotDeals: RadarRawDeal[];
  planDeals?: NormalizedPlanDeal[];
}

export function buildRadarView(options: BuildRadarViewOptions): RadarView {
  const parsedLots = options.lotDeals
    .map(d => parseRadarLotDeal(d, options))
    .filter((c): c is RadarCard => c !== null);

  const parsedPlans = (options.planDeals || [])
    .map(p => parseRadarPlanDeal(p, options))
    .filter((c): c is RadarCard => c !== null);

  const buildGroup = (group: "ИП" | "КТ"): RadarGroupView => {
    const groupLots = parsedLots.filter(c => c.group === group);
    const groupPlans = parsedPlans.filter(c => c.group === group);

    const submitToday = groupLots.filter(c => c.column === "submitToday");
    const discussion = groupLots.filter(c => c.column === "discussion");
    const secondChanceLots = groupLots.filter(c => c.column === "secondChance");

    // Deduplicate secondChance lots and plans by planNumber
    const seenPlanNumbers = new Set<string>();
    const secondChance: RadarCard[] = [];

    // Add lots first
    for (const card of secondChanceLots) {
      if (card.planNumber) seenPlanNumbers.add(card.planNumber);
      secondChance.push(card);
    }
    // Add plans if planNumber not already covered
    for (const card of groupPlans) {
      if (card.planNumber && seenPlanNumbers.has(card.planNumber)) continue;
      if (card.planNumber) seenPlanNumbers.add(card.planNumber);
      secondChance.push(card);
    }

    // Sort submitToday:
    // First items ending today, sorted by sum DESC
    // Then other items, sorted by hoursLeft ASC (or endAt ASC), then sum DESC
    submitToday.sort((a, b) => {
      if (a.isToday && !b.isToday) return -1;
      if (!a.isToday && b.isToday) return 1;
      if (a.isToday && b.isToday) return b.sum - a.sum;
      const hA = a.hoursLeft ?? 999999;
      const hB = b.hoursLeft ?? 999999;
      return hA - hB || b.sum - a.sum;
    });

    // Sort discussion: sum DESC
    discussion.sort((a, b) => b.sum - a.sum);

    // Sort secondChance: sum DESC
    secondChance.sort((a, b) => b.sum - a.sum);

    // Calculate KPIs
    const expiringSoon = submitToday.filter(c => c.isToday || c.isWithin48h);
    const submitCount = expiringSoon.length > 0 ? expiringSoon.length : submitToday.length;
    const submitSum = expiringSoon.length > 0
      ? expiringSoon.reduce((acc, c) => acc + c.sum, 0)
      : submitToday.reduce((acc, c) => acc + c.sum, 0);

    const discussionCount = discussion.length;
    const discussionSum = discussion.reduce((acc, c) => acc + c.sum, 0);

    const secondChanceCount = secondChance.length;
    const secondChanceSum = secondChance.reduce((acc, c) => acc + c.sum, 0);

    const totalCount = submitToday.length + discussionCount + secondChanceCount;
    const totalSum = submitToday.reduce((acc, c) => acc + c.sum, 0) + discussionSum + secondChanceSum;

    const kpis: RadarKpis = {
      totalCount,
      totalSum,
      submitCount,
      submitSum,
      discussionCount,
      discussionSum,
      secondChanceCount,
      secondChanceSum
    };

    return {
      group,
      kpis,
      submitToday,
      discussion,
      secondChance
    };
  };

  return {
    asOf: options.asOfDate,
    ip: buildGroup("ИП"),
    kt: buildGroup("КТ")
  };
}
