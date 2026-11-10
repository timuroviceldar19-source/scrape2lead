import { enrichManagerNames } from "../managerNames.js";
import { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import { loadMarketConfig } from "../../../kz/market/config.js";
import { buildPlansMonitorView } from "./aggregate.js";
import { attachLostWinners } from "./lostTo.js";
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
const EDUCATION_KIT_NAME = /учебн.*комплект|комплект.*учебн/;

function kind(group: "ИП" | "КТ", code: string, name: string): string {
  const n = name.toLowerCase();
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
export interface NormalizePlanOptions {
  asOfDate: string;
  portal?: string;
  managerNames?: ReadonlyMap<string, string>;
}
/** Код имеет приоритет; название используется только при отсутствии кода. */
function productGroup(code: string, name: string): "ИП" | "КТ" | null {
  if (code) {
    // Уточнение только для планов: конфиг и ключ истории Рынка не меняем.
    if (code.startsWith("262030.100.") && !/^262030\.100\.0000(11|13|21|43)$/.test(code)) return null;
    const groups = loadMarketConfig().groups;
    for (const group of ["ИП", "КТ"] as const) {
      if (groups[group].prefixes.some(prefix => code.startsWith(prefix))) return group;
    }
    return null;
  }
  const n = name.toLowerCase();
  if (/услуг|ремонт|обслуживан|аренд/.test(n)) return null;
  if (/панел|доск|мультимедийн.*систем|систем.*мультимедийн/.test(n) || EDUCATION_KIT_NAME.test(n)) return "ИП";
  if (/компьютер|системн.*блок|ноутбук|лэптоп|моноблок|монитор|мфу|многофункциональн|принтер/.test(n)) return "КТ";
  return null;
}
function isPlanDeal(d: Record<string, unknown>): boolean {
  const category = Number(d.CATEGORY_ID), title = text(d.TITLE), origin = text(d.ORIGIN_ID), originator = text(d.ORIGINATOR_ID);
  if (![9, 41, 29].includes(category) || originator === "scrape2lead-gz-lots" || origin.startsWith("gz-lot:")) return false;
  return originator === "scrape2lead-gz-plans" || Boolean(field(d, "UF_CRM_PLAN_ID", "UF_CRM_1782386293000_IU_XLS") || /\[GZ (\d+)\]/.exec(title) || origin.startsWith("gz-plan:"));
}
export function normalizePlanDeal(d: Record<string, unknown>, options: NormalizePlanOptions): NormalizedPlanDeal | null {
  if (!isPlanDeal(d)) return null;
  const title = text(d.TITLE);
  const planNumber = field(d, "UF_CRM_PLAN_ID", "UF_CRM_1782386293000_IU_XLS") || /\[GZ (\d+)\]/.exec(title)?.[1] || "";
  const itemName = field(d, "UF_CRM_6627AEBD54B8D", "UF_CRM_ENSTRU_NAME", "UF_CRM_1713874845756") || title.split("—")[0].replace(/\[GZ \d+\]/, "").trim();
  const truCode = field(d, "UF_CRM_6A436D5A19612", "UF_CRM_REF_ENSTRU_CODE", "UF_CRM_S2L_GZ_TRU");
  const group = productGroup(truCode, itemName);
  if (!group) return null;
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
/** Один rootrecordId — один пункт, независимо от товарной группы и ORIGIN_ID. */
export function dedupePlanDeals(deals: readonly NormalizedPlanDeal[]): NormalizedPlanDeal[] {
  const result: NormalizedPlanDeal[] = [];
  const positions = new Map<string, number>();
  const compare = (a: NormalizedPlanDeal, b: NormalizedPlanDeal): number =>
    Number(a.outcomeCategory === "won") - Number(b.outcomeCategory === "won") ||
    Number(a.isOpen) - Number(b.isOpen) ||
    Number(Boolean(a.truCode.trim())) - Number(Boolean(b.truCode.trim())) ||
    a.id.localeCompare(b.id, "en", { numeric: true });
  for (const deal of deals) {
    const key = deal.planNumber.trim();
    const position = key ? positions.get(key) : undefined;
    if (position === undefined) {
      if (key) positions.set(key, result.length);
      result.push(deal);
    } else if (compare(deal, result[position]) > 0) result[position] = deal;
  }
  return result;
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
    const planRows = rows.filter(isPlanDeal);
    // Отдельный шаг: принадлежность к планам не зависит от стадии CRM.
    const withoutDuplicateStages = planRows.filter(d => !/DUPLICATE|DOUBLE/i.test(text(d.STAGE_ID)));
    console.log(`[Планы] на стадии «Дубль»: ${planRows.length - withoutDuplicateStages.length}`);
    const normalized = withoutDuplicateStages.map(d => normalizePlanDeal(d, { ...options, managerNames: names })).filter((d): d is NormalizedPlanDeal => d !== null);
    console.log(`[Планы] вне групп: ${withoutDuplicateStages.length - normalized.length}`);
    const deals = dedupePlanDeals(normalized);
    console.log(`[Планы] повторов: ${normalized.length - deals.length}`);
    const loadedNames = new Map([...(options.userProfiles || [])].map(([id, profile]) => [id, profile.name]));
    await enrichManagerNames(options.reader, deals.map(d => d.managerId), loadedNames);
    for (const [id, name] of loadedNames) {
      if (!names.has(id) || name !== `сотрудник ID ${id}`) names.set(id, name);
    }
    for (const d of deals) d.managerName = names.get(d.managerId) || `ID ${d.managerId || "—"}`;
    await attachLostWinners(options.reader, deals);
    const view = buildPlansMonitorView(deals, options);
    console.log(`[Планы] сделок: ${deals.length}, ИП: ${view.ip!.total.count}, КТ: ${view.kt!.total.count} (${Math.round(performance.now() - started)} мс)`);
    return view;
  } catch {
    // Ошибки транспорта могут содержать URL вебхука: не передаём их в публичный payload.
    return { asOf: options.asOfDate, error: "Не удалось загрузить планы из Битрикс24. Повторим при следующем обновлении." };
  }
}
