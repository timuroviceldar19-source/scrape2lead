// «Утренний пульс»: до шести пунктов над главной, где горят деньги, маржа или крупный тендер.
// Директор открывает пульт с телефона в 9:00 и одним тапом уходит к нужному списку.
//
// Модуль чистый: на входе то, что сборка уже загрузила (финансы, радар, реестр, ошибки CRM),
// на выходе пункты со ссылками. Финансовые суммы берутся как в отчёте (`buildFinanceInsights`),
// ничего не досуммируется. Пункты из финансов, себестоимости и маржи помечены `finance: true`:
// менеджеру и на ТВ они не показываются.

import { buildFinanceInsights } from "./finance/insights.js";
import type { FinanceView } from "./finance/types.js";
import { MONTHS, formatPultMoney, plural } from "./format.js";
import type { RadarCard, RadarGroupView, RadarView } from "./radar/types.js";
import { buildRegisterRisks } from "./register/risks.js";
import type { RegisterView } from "./register/types.js";
import type { SalesPultPayload, SignalItem } from "./types.js";
import type { RecentCheaperRejectionsSummary } from "../../kz/competitors/losses.js";
import type { StagnantDemandSummary } from "./stock/availability.js";

export type PulseSeverity = "red" | "yellow" | "green";
export type PulseArea = "cash" | "debt" | "tender" | "margin" | "stock" | "crm" | "losses";

export interface PulseItem {
  key: string;
  severity: PulseSeverity;
  area: PulseArea;
  title: string;
  value: string;
  detail?: string;
  /** Конкретный блок: `./fin.html#…`, `./reg.html#…`, `#radar-ip`, `#signals`. */
  href: string;
  /** Закрытый пункт (финансы, себестоимость, маржа, данные «Конкурентов»): не для менеджера и не для ТВ. */
  finance: boolean;
  /** Деньги пункта в ₸ — порядок внутри одного цвета; нет — пункт в конце своего цвета. */
  amount?: number;
}

export interface PulseView {
  /** Дата пульса (YYYY-MM-DD, Алматы). */
  asOf: string;
  items: PulseItem[];
  /** Источники, которых нет или которые устарели: «Финансы: отчёт на 17.11». */
  missing: string[];
  /** Сколько пунктов не вошло в лимит. */
  more?: number;
}

export interface MorningPulseInput {
  asOfDate: string;
  /** Момент сборки: ISO или «YYYY-MM-DD HH:MM (UTC+5)»; по нему пересчитываются часы до конца приёма заявок. */
  nowIso: string;
  /** Нет — финансовых пунктов нет, в `missing` пояснение. */
  finance?: FinanceView;
  /** null — радар не загружен (пояснение в `missing`); не передан — не проверялся. */
  radar?: RadarView | null;
  /** Не передан — маржа не проверялась. */
  register?: RegisterView;
  /** `payload.contractSource.signals`: ошибки данных в сделках (сумма 0, «успешна», а договор у другого). */
  contractSignals?: readonly SignalItem[];
  /** `payload.outcomeMismatches.length`: выиграно на портале, закрыто как проигрыш. */
  outcomeMismatchesCount?: number;
  /** Пункты других разделов (потери, склад) — подключает интегратор. */
  extraItems?: readonly PulseItem[];
}

export const PULSE_MAX_ITEMS = 6;
/** Крупный лот: от этой суммы лот с концом приёма в ближайшие 48 ч попадает в пульс. */
export const PULSE_BIG_LOT_SUM = 50_000_000;
export const PULSE_BIG_LOT_HOURS = 48;
/** Лот «сегодня» красный, если до конца приёма меньше стольких часов. */
export const PULSE_URGENT_HOURS = 4;
/** Горящие лоты в утреннем отчёте менеджера. */
export const PULSE_HOT_LOT_HOURS = 24;
/** Отчёт финансиста старше стольких дней помечается датой данных. */
export const PULSE_STALE_DAYS = 3;
/** Неподвижный склад меньше этой суммы — шум, в пульс не идёт. */
export const PULSE_STOCK_MIN_SUM = 1_000_000;

export const PULSE_LINKS = {
  cash: "./fin.html#f-payments",
  debt: "./fin.html#f-debtors",
  stock: "./fin.html#f-stock",
  margin: "./reg.html#r-risks",
  crm: "#signals",
  radar: { "ИП": "#radar-ip", "КТ": "#radar-kt" }
} as const;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const ALMATY_OFFSET = 5 * HOUR;
const SEVERITY_RANK: Record<PulseSeverity, number> = { red: 0, yellow: 1, green: 2 };

const money = (n: number) => formatPultMoney(Math.abs(n));
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const days = (from: string, to: string) => Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / DAY);
const lots = (n: number) => plural(n, ["лот", "лота", "лотов"]);
const join = (...parts: Array<string | undefined | false>) => parts.filter(Boolean).join(" · ") || undefined;

/** Момент из ISO или из местного времени Алматы («YYYY-MM-DD HH:MM», «… (UTC+5)»); дата без времени — конец дня. */
function parseMoment(raw: string | null | undefined): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const local = /^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2})(?::(\d{2}))?)?(?:\s*\(UTC\+5\))?$/.exec(s);
  if (local) {
    const time = local[2] ? `${local[2]}:${local[3] ?? "00"}` : "23:59:59";
    const ms = Date.parse(`${local[1]}T${time}+05:00`);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

const almatyDate = (ms: number) => new Date(ms + ALMATY_OFFSET).toISOString().slice(0, 10);

/** «15:00», «18.11 08:00», «конца дня» или «18.11» — срок приёма заявок по времени Алматы. */
export function formatLotDeadline(endAt: string | null | undefined, asOfDate: string): string {
  const s = String(endAt ?? "").trim();
  const end = parseMoment(s);
  if (end === null) return "";
  const hasTime = /\d{2}:\d{2}/.test(s);
  const local = new Date(end + ALMATY_OFFSET).toISOString();
  const date = local.slice(0, 10);
  const time = local.slice(11, 16);
  if (date === asOfDate) return hasTime ? time : "конца дня";
  return hasTime ? `${ddmm(date)} ${time}` : ddmm(date);
}

/** Карточка с часами и «сегодня», пересчитанными на момент `nowIso`; без срока — как в радаре. */
function timed(card: RadarCard, asOfDate: string, nowMs: number | null): RadarCard {
  const end = parseMoment(card.endAt);
  if (end === null || nowMs === null) return card;
  const hoursLeft = (end - nowMs) / HOUR;
  return { ...card, hoursLeft, isToday: almatyDate(end) === asOfDate, isWithin48h: hoursLeft > 0 && hoursLeft <= PULSE_BIG_LOT_HOURS };
}

const active = (card: RadarCard) => card.hoursLeft === null || card.hoursLeft > 0;
const byDeadline = (a: RadarCard, b: RadarCard) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity) || b.sum - a.sum;
const sumOf = (cards: readonly RadarCard[]) => cards.reduce((s, c) => s + (c.sum || 0), 0);
const countAndSum = (cards: readonly RadarCard[]) => join(lots(cards.length), money(sumOf(cards)))!;

function groupTenderItems(group: RadarGroupView | undefined, asOfDate: string, nowMs: number | null): PulseItem[] {
  if (!group) return [];
  const slug = group.group === "КТ" ? "kt" : "ip";
  const href = PULSE_LINKS.radar[group.group === "КТ" ? "КТ" : "ИП"];
  const cards = (group.submitToday ?? []).map((c) => timed(c, asOfDate, nowMs)).filter(active).sort(byDeadline);
  const items: PulseItem[] = [];

  const today = cards.filter((c) => c.isToday);
  if (today.length) {
    const urgent = today.some((c) => c.hoursLeft !== null && c.hoursLeft < PULSE_URGENT_HOURS);
    const nearest = formatLotDeadline(today[0].endAt, asOfDate);
    items.push({
      key: `tender-today-${slug}`, severity: urgent ? "red" : "yellow", area: "tender", finance: false, href,
      title: `Подать сегодня · ${group.group}`, value: countAndSum(today),
      detail: join(nearest && `${today.length > 1 ? "ближайший " : ""}до ${nearest}`, urgent && `меньше ${PULSE_URGENT_HOURS} ч`), amount: sumOf(today)
    });
  }

  const big = cards.filter((c) => !c.isToday && c.isWithin48h && c.sum >= PULSE_BIG_LOT_SUM);
  if (big.length) {
    const nearest = formatLotDeadline(big[0].endAt, asOfDate);
    items.push({
      key: `tender-big-${slug}`, severity: "yellow", area: "tender", finance: false, href,
      title: `Крупные лоты за ${PULSE_BIG_LOT_HOURS} ч · ${group.group}`, value: countAndSum(big),
      detail: join(nearest && `${big.length > 1 ? "ближайший " : ""}до ${nearest}`, `от ${money(PULSE_BIG_LOT_SUM)}`), amount: sumOf(big)
    });
  }
  return items;
}

function tenderItems(radar: RadarView | null | undefined, asOfDate: string, nowIso: string, missing: string[]): PulseItem[] {
  if (radar === undefined) return [];
  if (radar === null) { missing.push("Радар: не загружен"); return []; }
  if (radar.error) { missing.push("Радар: не загрузился"); return []; }
  const nowMs = parseMoment(nowIso);
  return [...groupTenderItems(radar.ip, asOfDate, nowMs), ...groupTenderItems(radar.kt, asOfDate, nowMs)];
}

function financeItems(finance: FinanceView | undefined, asOfDate: string, missing: string[]): PulseItem[] {
  const report = finance?.report;
  if (!finance || !report) { missing.push("Финансы: нет отчёта"); return []; }
  const stale = days(report.dataDate, asOfDate) > PULSE_STALE_DAYS ? `отчёт на ${ddmm(report.dataDate)}` : undefined;
  if (stale) missing.push(`Финансы: ${stale}`);
  // Те же цифры, что на странице «Финансы» (site.ts считает их на дату сборки).
  const insights = buildFinanceInsights(finance, asOfDate);
  const items: PulseItem[] = [];

  if (insights.cashGap < 0) {
    items.push({
      key: "cash-gap", severity: "red", area: "cash", finance: true, href: PULSE_LINKS.cash,
      title: "Кассовый разрыв", value: `не хватает ${money(insights.cashGap)}`,
      detail: join("деньги минус платежи и КПН", stale), amount: -insights.cashGap
    });
  }

  // Долги старше 60 дней входят в «старше 30»: один пункт, без двойного счёта.
  const { over30, over60 } = insights.debt;
  if (over60.count > 0) {
    items.push({
      key: "debt-60", severity: "red", area: "debt", finance: true, href: PULSE_LINKS.debt,
      title: "Долги старше 60 дней", value: join(money(over60.total), plural(over60.count, ["долг", "долга", "долгов"]))!,
      detail: join(over30.total > over60.total && `старше 30 дней всего ${money(over30.total)}`, stale), amount: over60.total
    });
  } else if (over30.count > 0) {
    items.push({
      key: "debt-30", severity: "yellow", area: "debt", finance: true, href: PULSE_LINKS.debt,
      title: "Долги старше 30 дней", value: join(money(over30.total), plural(over30.count, ["долг", "долга", "долгов"]))!,
      detail: stale, amount: over30.total
    });
  }

  if (insights.stock.count > 0 && insights.stock.total >= PULSE_STOCK_MIN_SUM) {
    items.push({
      key: "stock-stagnant", severity: "yellow", area: "stock", finance: true, href: PULSE_LINKS.stock,
      title: "Склад без движения", value: money(insights.stock.total),
      detail: join(`${plural(insights.stock.count, ["позиция", "позиции", "позиций"])} без расхода`, stale), amount: insights.stock.total
    });
  }
  return items;
}

function marginItems(register: RegisterView | undefined, asOfDate: string, missing: string[]): PulseItem[] {
  if (!register) return [];
  if (register.error !== undefined) { missing.push("Реестр: не загрузился"); return []; }
  const month = asOfDate.slice(0, 7);
  if (register.month !== month) {
    // В первые дни месяца файла ОП ещё нет; прошлый месяц уже разобран на «Выручке».
    missing.push(`Реестр: файла за ${MONTHS[Number(month.slice(5, 7)) - 1]?.toLocaleLowerCase("ru") ?? month} ещё нет`);
    return [];
  }
  const stale = register.asOf && days(register.asOf, asOfDate) > PULSE_STALE_DAYS ? `реестр на ${ddmm(register.asOf)}` : undefined;
  if (stale) missing.push(`Реестр: данные на ${ddmm(register.asOf)}`);
  const risks = register.risks ?? buildRegisterRisks(register.rows, register.total.hasVal ?? register.rows.some((r) => r.val !== null));
  const rows = (n: number) => plural(n, ["строка", "строки", "строк"]);
  const items: PulseItem[] = [];
  if (risks.belowCost.count > 0) {
    items.push({
      key: "margin-below-cost", severity: "red", area: "margin", finance: true, href: PULSE_LINKS.margin,
      title: "Продажи ниже себестоимости", value: `убыток ${money(risks.belowCost.loss)}`,
      detail: join(`${rows(risks.belowCost.count)} реестра`, stale), amount: risks.belowCost.loss
    });
  }
  if (risks.lowMargin.count > 0) {
    items.push({
      key: "margin-low", severity: "yellow", area: "margin", finance: true, href: PULSE_LINKS.margin,
      title: "Маржа ниже 10%", value: `выручка ${money(risks.lowMargin.sale)}`,
      detail: join(`${rows(risks.lowMargin.count)} реестра`, stale), amount: risks.lowMargin.sale
    });
  }
  return items;
}

function crmItems(contractSignals: readonly SignalItem[] | undefined, outcomeMismatchesCount = 0): PulseItem[] {
  const count = (contractSignals?.length ?? 0) + Math.max(0, outcomeMismatchesCount);
  if (!count) return [];
  return [{
    key: "crm-errors", severity: "yellow", area: "crm", finance: false, href: PULSE_LINKS.crm,
    title: "Ошибки в CRM", value: plural(count, ["сделка", "сделки", "сделок"]), detail: "стадии и суммы — в «Срочно»", amount: 0
  }];
}

/**
 * Свежие отклонения заявок группы при цене ниже победителя (`summarizeRecentCheaperRejections`): самая
 * болезненная потеря, поэтому красный пункт. Ссылка — на «Конкурентов» той группы, где денег больше.
 */
export function lossPulseItems(summary: RecentCheaperRejectionsSummary | null | undefined): PulseItem[] {
  if (!summary || summary.count <= 0) return [];
  const byGroup = { "ИП": 0, "КТ": 0 };
  for (const item of summary.items) byGroup[item.group] += Math.max(0, item.ourPrice ?? 0);
  return [{
    key: "losses-cheaper", severity: "red", area: "losses", finance: true,
    href: byGroup["КТ"] > byGroup["ИП"] ? "#competitors-kt" : "#competitors-ip",
    title: "Отклонены при цене ниже победителя",
    value: plural(summary.count, ["заявка", "заявки", "заявок"]),
    detail: `${money(summary.sumOur)} за неделю — проверьте документы`,
    amount: summary.sumOur
  }];
}

/** «панели 75″», «ноутбуки» — коротко для строки пульса. */
function stockKindLabel(kind: string, diagonal: number | null): string {
  const base = kind === "Интерактивные панели" ? "панели" : kind.toLowerCase();
  return diagonal ? `${base} ${diagonal}″` : base;
}

/**
 * Склад без расхода, который нужен в открытых лотах и планах (`summarizeStagnantDemand`): директор ведёт залежь
 * в конкретные лоты. Каждый лот или план считается один раз, даже если подходит нескольким строкам склада.
 * Штуки, без денег — пункт не зависит от порога суммы неподвижного склада; закрытый, как всё с «Финансов».
 */
export function stockDemandPulseItems(summary: StagnantDemandSummary | null | undefined): PulseItem[] {
  if (!summary || summary.lots <= 0) return [];
  const kinds = summary.rows.slice(0, 2).map((r) => stockKindLabel(r.kind, r.diagonal)).join(", ");
  const more = summary.rows.length > 2 ? ` и ещё ${summary.rows.length - 2}` : "";
  return [{
    key: "stock-demand", severity: "yellow", area: "stock", finance: true, href: PULSE_LINKS.stock,
    title: "Склад без расхода нужен в лотах", value: lots(summary.lots),
    detail: join(`без расхода ${summary.stagnantQty} шт`, kinds + more, summary.stale && `на ${ddmm(summary.asOf)}`)
  }];
}

/** Сначала цвет, потом деньги; одинаковые ключи не повторяются; не больше `PULSE_MAX_ITEMS`. */
export function rankPulseItems(items: readonly PulseItem[]): { items: PulseItem[]; more?: number } {
  const seen = new Set<string>();
  const unique = items.filter((item) => !seen.has(item.key) && seen.add(item.key));
  const ranked = unique
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity]
      || (b.item.amount ?? -1) - (a.item.amount ?? -1) || a.index - b.index)
    .map(({ item }) => item);
  const more = ranked.length - PULSE_MAX_ITEMS;
  return { items: ranked.slice(0, PULSE_MAX_ITEMS), ...(more > 0 ? { more } : {}) };
}

export function buildMorningPulse(input: MorningPulseInput): PulseView {
  const missing: string[] = [];
  const items = [
    ...financeItems(input.finance, input.asOfDate, missing),
    ...tenderItems(input.radar, input.asOfDate, input.nowIso, missing),
    ...marginItems(input.register, input.asOfDate, missing),
    ...crmItems(input.contractSignals, input.outcomeMismatchesCount),
    ...(input.extraItems ?? [])
  ];
  return { asOf: input.asOfDate, ...rankPulseItems(items), missing };
}

/** Пульс главной полного пульта из уже собранного payload; у закрытого месяца пульса нет. */
export function pulseForPayload(
  payload: SalesPultPayload,
  sources: { nowIso: string; finance?: FinanceView; register?: RegisterView; extraItems?: readonly PulseItem[] }
): PulseView | null {
  if (payload.closedMonth) return null;
  return buildMorningPulse({
    asOfDate: payload.asOfDate,
    nowIso: sources.nowIso,
    finance: sources.finance,
    radar: payload.radar,
    register: sources.register,
    contractSignals: payload.contractSource?.signals,
    outcomeMismatchesCount: payload.outcomeMismatches?.length ?? 0,
    extraItems: sources.extraItems
  });
}

const FINANCE_PULSE_AREAS = new Set<PulseArea>(["cash", "debt", "stock"]);

/** Пункт относится к странице «Финансы» (касса, дебиторка, склад) и не должен попадать к РОП. */
export function isFinancePagePulseItem(item: PulseItem): boolean {
  return FINANCE_PULSE_AREAS.has(item.area) || item.href.startsWith("./fin.html");
}

/** Пульс для РОП: без пунктов страницы «Финансы» и заметок о финотчёте, с маржей реестра, тендерами, CRM и конкурентами. */
export function buildRopPulse(pulse: PulseView | null | undefined): PulseView | null | undefined {
  if (!pulse) return pulse;
  const items = pulse.items.filter((item) => !isFinancePagePulseItem(item));
  const removed = pulse.items.length - items.length;
  const missing = pulse.missing.filter((note) => !/^Финансы(?::|\b)/i.test(note.trim()));
  const more = removed === 0 && pulse.more ? pulse.more : undefined;
  return { asOf: pulse.asOf, items, missing, ...(more ? { more } : {}) };
}

/** Пульс менеджера: только тендеры переданного (его) радара — без финансов, маржи и CRM команды. */
export function buildManagerPulse(radar: RadarView | null, asOfDate: string, nowIso: string): PulseView {
  const missing: string[] = [];
  const items = tenderItems(radar, asOfDate, nowIso, missing).filter((item) => !item.finance);
  return { asOf: asOfDate, ...rankPulseItems(items), missing };
}

/** Лоты менеджера из «Подать» со сроком до `PULSE_HOT_LOT_HOURS` ч, ближайшие первыми — для утреннего отчёта. */
export function selectHotLots(radar: RadarView | null | undefined, managerId: string, asOfDate: string, nowIso: string): RadarCard[] {
  if (!radar || radar.error) return [];
  const nowMs = parseMoment(nowIso);
  return [radar.ip, radar.kt]
    .flatMap((group) => group?.submitToday ?? [])
    .filter((card) => card.managerId === managerId)
    .map((card) => timed(card, asOfDate, nowMs))
    .filter((card) => card.hoursLeft !== null && card.hoursLeft > 0 && card.hoursLeft <= PULSE_HOT_LOT_HOURS)
    .sort(byDeadline);
}
