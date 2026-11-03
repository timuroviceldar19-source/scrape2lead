import { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import { loadGzRoutingConfig, resolveGzRoute, type GzRoutingConfig } from "../../gzDealRouting.js";
import { buildPlansMonitorView } from "./aggregate.js";
import type { NormalizedPlanDeal, PlanOutcome, PlansMonitorView } from "./types.js";

export const PLAN_DEAL_SELECT_FIELDS = [
  "ID", "TITLE", "CATEGORY_ID", "STAGE_ID", "STAGE_SEMANTIC_ID", "CLOSED",
  "ASSIGNED_BY_ID", "DATE_CREATE", "OPPORTUNITY", "ORIGINATOR_ID", "ORIGIN_ID",
  "UF_CRM_PLAN_ID", "UF_CRM_1782386293000_IU_XLS",
  "UF_CRM_PLAN_LINK", "UF_CRM_1782386571874_IU_XLS",
  "UF_CRM_PLAN_STATUS", "UF_CRM_6627AEBD85B4D", "UF_CRM_1713874909541",
  "UF_CRM_S2L_GZ_OUTCOME",
  "UF_CRM_1715597726664", "UF_CRM_MONTH", "UF_CRM_1782386433277_IU_XLS", "UF_CRM_S2L_GZ_MONTH",
  "UF_CRM_6627AEBD54B8D", "UF_CRM_ENSTRU_NAME", "UF_CRM_1713874845756",
  "UF_CRM_6A436D5A19612", "UF_CRM_REF_ENSTRU_CODE", "UF_CRM_S2L_GZ_TRU",
  "UF_CRM_1782386244985_IU_XLS", "UF_CRM_KEYWORD",
  "UF_CRM_6627AEBD7C2D2", "UF_CRM_1713874902207",
  "UF_CRM_6627AEBD72587", "UF_CRM_1713874888434",
  "UF_CRM_1715597423325",
  "UF_CRM_6627AEBD67FFF", "UF_CRM_COUNT", "UF_CRM_1713874871715",
  "UF_CRM_6627AEBD5E68B", "UF_CRM_PRICE_PER_UNIT", "UF_CRM_1713874858791",
  "UF_CRM_6627AEBD4503E", "UF_CRM_1713874828510"
] as const;

const MONTHS = ["январ", "феврал", "март", "апрел", "май", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const text = (v: unknown): string => Array.isArray(v) ? text(v[0]) : v == null || v === false ? "" : String(v).trim();
function field(d: Record<string, unknown>, ...keys: string[]): string {
  return keys.map(k => text(d[k])).find(Boolean) || "";
}
function number(value: string): number | null {
  const cleaned = value.replace(/[\s\u00a0₸]/g, "").replace(",", ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function numeric(d: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) { const n = number(text(d[key])); if (n !== null) return n; }
  return 0;
}
export function parsePlanMonth(value: string, dateCreate: string, asOfDate: string): string {
  const fallback = /^\d{4}-(0[1-9]|1[0-2])/.test(dateCreate) ? dateCreate.slice(0, 7) : asOfDate.slice(0, 7);
  const s = value.toLowerCase().trim();
  let year = Number(fallback.slice(0, 4)), month = 0;
  const iso = /^(\d{4})-(\d{1,2})(?:$|-\d{2})/.exec(s);
  const local = /^(\d{1,2})[./-](\d{4})$/.exec(s);
  if (iso) { year = Number(iso[1]); month = Number(iso[2]); }
  else if (local) { month = Number(local[1]); year = Number(local[2]); }
  else if (/^\d{1,2}$/.test(s)) month = Number(s);
  else {
    month = MONTHS.findIndex(m => s.startsWith(m)) + 1;
    const y = /\b(\d{4})\b/.exec(s);
    if (y) year = Number(y[1]);
  }
  return month >= 1 && month <= 12 && year >= 1900 && year <= 9999 ? `${year}-${String(month).padStart(2, "0")}` : fallback;
}
function https(value: string): string {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : ""; } catch { return ""; }
}
function kind(group: "ИП" | "КТ", code: string, name: string): string {
  const n = name.toLowerCase();
  if (group === "ИП") {
    if (code.endsWith(".000021") || code.startsWith("279020") || /панел/.test(n)) return "Интерактивные панели";
    if (code.endsWith(".000043") || /доск/.test(n)) return "Интерактивные и спец. доски";
    if (/\.0000(11|13)$/.test(code)) return "Мультимедийные системы";
    return "Прочее ИП";
  }
  if (/ноутбук|лэптоп/.test(n) || code.startsWith("262011")) return "Ноутбуки";
  if (/моноблок/.test(n)) return "Моноблоки";
  if (/монитор/.test(n)) return "Мониторы";
  if (/мфу|многофункциональн|принтер/.test(n)) return "МФУ и принтеры";
  if (/компьютер|системн.*блок/.test(n) || code.startsWith("262013")) return "Компьютеры и системные блоки";
  return "Прочее КТ";
}
export interface NormalizePlanOptions {
  asOfDate: string;
  portal?: string;
  managerNames?: ReadonlyMap<string, string>;
  routing?: GzRoutingConfig;
}
let defaultRouting: GzRoutingConfig | undefined;
export function normalizePlanDeal(d: Record<string, unknown>, options: NormalizePlanOptions): NormalizedPlanDeal | null {
  const category = Number(d.CATEGORY_ID), title = text(d.TITLE), origin = text(d.ORIGIN_ID), originator = text(d.ORIGINATOR_ID);
  if (![9, 41, 29].includes(category) || originator === "scrape2lead-gz-lots" || origin.startsWith("gz-lot:")) return null;
  const planNumber = field(d, "UF_CRM_PLAN_ID", "UF_CRM_1782386293000_IU_XLS") || /\[GZ (\d+)\]/.exec(title)?.[1] || "";
  if (originator !== "scrape2lead-gz-plans" && !planNumber && !origin.startsWith("gz-plan:")) return null;
  const itemName = field(d, "UF_CRM_6627AEBD54B8D", "UF_CRM_ENSTRU_NAME", "UF_CRM_1713874845756") || title.split("—")[0].replace(/\[GZ \d+\]/, "").trim();
  const truCode = field(d, "UF_CRM_6A436D5A19612", "UF_CRM_REF_ENSTRU_CODE", "UF_CRM_S2L_GZ_TRU");
  const routing = options.routing || (defaultRouting ??= loadGzRoutingConfig("config/bitrix-gz-routing.json"));
  const group = category === 9 ? "КТ" : category === 41 ? "ИП" : resolveGzRoute({ truCode, itemName, keyword: field(d, "UF_CRM_1782386244985_IU_XLS", "UF_CRM_KEYWORD") }, routing).categoryId === 9 ? "КТ" : "ИП";
  const semantic = text(d.STAGE_SEMANTIC_ID), stage = text(d.STAGE_ID);
  const isOpen = semantic !== "S" && semantic !== "F" && text(d.CLOSED) !== "Y";
  const portalStatus = field(d, "UF_CRM_PLAN_STATUS", "UF_CRM_6627AEBD85B4D", "UF_CRM_1713874909541") || "Утвержден";
  const outcomeKey = text(d.UF_CRM_S2L_GZ_OUTCOME);
  const status = portalStatus.toLowerCase().replace(/ё/g, "е");
  let outcomeCategory: PlanOutcome = "open";
  if (/^(won|partner):/.test(outcomeKey) || semantic === "S") outcomeCategory = "won";
  else if (outcomeKey.startsWith("lost:")) outcomeCategory = "lost";
  else if (/^(cancelled|repurposed|failed):/.test(outcomeKey) || /отменен|отказ|удален|не состоялась/.test(status)) outcomeCategory = "cancelled";
  else if (/^(published|contract-draft):/.test(outcomeKey) || /опубликован|проект договора|договор/.test(status)) outcomeCategory = "published";
  const id = text(d.ID), managerId = text(d.ASSIGNED_BY_ID);
  const customerBin = field(d, "UF_CRM_6627AEBD7C2D2", "UF_CRM_1713874902207");
  return {
    id, group, managerId, managerName: options.managerNames?.get(managerId) || `ID ${managerId || "—"}`,
    dealUrl: https(`${(options.portal || "").replace(/\/+$/, "")}/crm/deal/details/${encodeURIComponent(id)}/`),
    planNumber, planUrl: https(field(d, "UF_CRM_PLAN_LINK", "UF_CRM_1782386571874_IU_XLS")),
    dateCreate: text(d.DATE_CREATE), month: parsePlanMonth(field(d, "UF_CRM_1715597726664", "UF_CRM_MONTH", "UF_CRM_1782386433277_IU_XLS", "UF_CRM_S2L_GZ_MONTH"), text(d.DATE_CREATE), options.asOfDate),
    customerBin, customerName: field(d, "UF_CRM_6627AEBD72587", "UF_CRM_1713874888434") || title.split("—").slice(1).join("—").trim() || customerBin || "Не указан",
    itemName, truCode, kind: kind(group, truCode, itemName),
    sum: numeric(d, "OPPORTUNITY", "UF_CRM_1715597423325"), qty: numeric(d, "UF_CRM_6627AEBD67FFF", "UF_CRM_COUNT", "UF_CRM_1713874871715"),
    price: numeric(d, "UF_CRM_6627AEBD5E68B", "UF_CRM_PRICE_PER_UNIT", "UF_CRM_1713874858791"),
    method: field(d, "UF_CRM_6627AEBD4503E", "UF_CRM_1713874828510") || "Не указан",
    portalStatus, outcomeKey, outcomeCategory, isOpen, isNewStage: isOpen && (stage === "NEW" || stage.endsWith(":NEW")), isWonCrm: semantic === "S", isLostCrm: semantic === "F"
  };
}
export interface CollectPlansOptions extends NormalizePlanOptions {
  reader: ReadOnlyBitrixClient;
  userProfiles?: ReadonlyMap<string, { name: string }>;
  groups?: Array<{ managers: Array<{ id: string; name: string }> }>;
}
export async function collectPlansMonitor(options: CollectPlansOptions): Promise<PlansMonitorView> {
  const started = performance.now();
  try {
    const rows = await options.reader.listAllBatched<Record<string, unknown>>("crm.deal.list", {
      filter: { CATEGORY_ID: [9, 41, 29], ORIGINATOR_ID: "scrape2lead-gz-plans" },
      select: [...PLAN_DEAL_SELECT_FIELDS], order: { ID: "ASC" }
    });
    const names = new Map(options.managerNames);
    for (const g of options.groups || []) for (const m of g.managers) names.set(String(m.id), m.name);
    for (const [id, p] of options.userProfiles || []) names.set(String(id), p.name);
    const deals = rows.map(d => normalizePlanDeal(d, { ...options, managerNames: names })).filter((d): d is NormalizedPlanDeal => d !== null);
    const missingManagerIds = [...new Set(deals.map(d => d.managerId))].filter(id => id && !options.userProfiles?.has(id));
    if (missingManagerIds.length) {
      try {
        const raw = await options.reader.call("user.get", { ID: missingManagerIds });
        const users = Array.isArray(raw) ? raw : (raw as { result?: unknown[] })?.result;
        for (const row of users || []) {
          if (!row || typeof row !== "object") continue;
          const user = row as Record<string, unknown>;
          const id = text(user.ID);
          const name = [text(user.NAME), text(user.LAST_NAME)].filter(Boolean).join(" ");
          if (id && name) names.set(id, name);
        }
      } catch { /* Имя из конфига или ID сохраняется при недоступности user.get. */ }
    }
    for (const d of deals) d.managerName = names.get(d.managerId) || `ID ${d.managerId || "—"}`;
    const view = buildPlansMonitorView(deals, options);
    console.log(`[Планы] сделок: ${deals.length}, ИП: ${view.ip!.total.count}, КТ: ${view.kt!.total.count} (${Math.round(performance.now() - started)} мс)`);
    return view;
  } catch {
    // Ошибки транспорта могут содержать URL вебхука: не передаём их в публичный payload.
    return { asOf: options.asOfDate, error: "Не удалось загрузить планы из Битрикс24. Повторим при следующем обновлении." };
  }
}
