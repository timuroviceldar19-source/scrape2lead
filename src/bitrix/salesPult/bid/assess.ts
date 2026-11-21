// Вердикт «идём / осторожно / не идём» для карточек Радара и открытых планов (пункт 5 RFC).
//
// Раньше подсказки «как выиграть» считал браузер (`plans.client.js`, пороги 115% и 90%). Теперь всё здесь:
// индексы заказчиков, шаблонов ТС и цен побед перенесены без изменения правил, к ним добавлены прошлые
// отклонения наших заявок у заказчика, вердикт и ценность. Браузер только рисует (`page/bid.client.js`).
//
// Считается при сборке страницы (`renderPultHtmlWithView`) из того же payload, что уходит в неё. Поэтому вид
// менеджера (без «Конкурентов», «Планы» — только его сделки) получает вердикт только из своих данных.
//
// Правило вердикта:
// - нет данных «Конкурентов» по группе или нет ни одного сигнала — `unknown` (вердикт не выносится);
// - ТС этого лота сильно совпадает с шаблоном, где чаще побеждал конкурент, — `nogo`;
// - иначе баллы: покупал у нас +2, цена с запасом +1, шаблон с нашими победами +1; низкая цена −1,
//   конкурент забирал заказчика −1 (от 3 раз −2), шаблон конкурента в этом лоте −2, у заказчика раньше −1
//   (сильный −2), нас отклоняли у заказчика −1 (от 2 раз −2). Минусов нет — `go`; итог ≤ −3 — `nogo`;
//   остальное — `caution`.
//
// Цена побед — ориентир из выборки не меньше `BID_PRICE_MIN_SAMPLES` побед. Запас и низкая цена считаются только
// по точному ориентиру: у панели — с той же диагональю. Панель без диагонали и учебный комплект сравниваются с
// медианой всего вида — это справка без цвета, на вердикт она не влияет (на данных 17.11 у 298 позиций ИП ориентиром
// была цена одного лота «диагональ не указана», и «низкая цена» стояла у 85% лотов Радара).

import type { SalesPultPayload } from "../types.js";
import type { RadarCard, RadarGroupView, RadarView } from "../radar/types.js";
import type { PlansMonitorView } from "../plans/types.js";
import { classifyRejectionReason, LOSS_REASON_LABELS } from "../../../kz/competitors/losses.js";
import type { LossReasonKey } from "../../../kz/competitors/types.js";
import {
  parseBidSources, type BidSources, type CompetitorsSliceSource, type CompetitorsSource, type GroupKey, type MarketSource
} from "./sources.js";
import type { BidAssessment, BidPrice, BidReason, BidVerdict } from "./types.js";

export { parseBidSources } from "./sources.js";

/** Вес вердикта в ценности (сумма × вес): порядок «по ценности» в колонках Радара. */
export const BID_VALUE_WEIGHTS: Readonly<Record<BidVerdict, number>> = { go: 1, unknown: 0.5, caution: 0.5, nogo: 0.1 };

/** Пороги цены к медиане побед, в процентах (прежние браузерные). */
export const BID_PRICE_GOOD_PCT = 115;
export const BID_PRICE_BAD_PCT = 90;
/** Ориентир цены побед из меньшей выборки не используется. */
export const BID_PRICE_MIN_SAMPLES = 3;
/** Виды, где медиана вида — только справка: размер и состав внутри вида слишком разные. */
const COARSE_PRICE_KINDS = new Set(["панель", "учебный комплект"]);

/** Что вердикт читает у карточки Радара или открытого плана. */
export interface BidItem {
  customerBin: string;
  customerName: string;
  kind: string;
  itemName: string;
  truCode?: string;
  qty: number;
  sum: number;
  price?: number;
  lotNumber?: string;
  annoId?: string;
  announceUrl?: string;
  lotUrl?: string;
}

// ---------- имена и БИН (как в прежнем plans.client.js) ----------

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const fmt = (n: number): string => nf0.format(n || 0);

const validBin = (value: unknown): string => /^\d{12}$/.test(String(value ?? "").trim()) ? String(value).trim() : "";

export function normalizeCustomerName(value: unknown): string {
  let name = " " + String(value || "").toLowerCase().replace(/ё/g, "е").replace(/["«»„“]/g, " ").replace(/\s+/g, " ") + " ";
  name = name.replace(/ коммунальное государственное казенное предприятие /g, " кгкп ");
  name = name.replace(/ коммунальное государственное учреждение /g, " кгу ");
  name = name.replace(/ государственное коммунальное казенное предприятие /g, " гккп ");
  name = name.replace(/ государственное коммунальное предприятие /g, " гкп ");
  name = name.replace(/ товарищество с ограниченной ответственностью /g, " тоо ");
  name = name.replace(/ некоммерческое акционерное общество /g, " нао ");
  return name.replace(/\s+/g, " ").trim();
}

function append<T>(map: Map<string, T[]>, key: string | undefined, item: T): void {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/** Поиск по заказчику: по БИН, а для записей без БИН — по нормализованному названию. */
class CustomerIndex<T> {
  private byBin = new Map<string, T[]>();
  private byName = new Map<string, T[]>();
  private withoutBin = new Map<string, T[]>();

  add(bin: unknown, name: unknown, item: T): void {
    const key = validBin(bin);
    const norm = normalizeCustomerName(name);
    append(this.byBin, key, item);
    append(this.byName, norm, item);
    if (!key) append(this.withoutBin, norm, item);
  }

  find(bin: unknown, name: unknown): T[] {
    const key = validBin(bin);
    const norm = normalizeCustomerName(name);
    return key ? this.byBin.get(key) || this.withoutBin.get(norm) || [] : this.byName.get(norm) || [];
  }
}

const pct = (part: number, whole: number): number | null => whole > 0 ? Math.round((part / whole - 1) * 100) : null;
const signedPct = (p: number | null): string => p === null ? "" : p === 0 ? "как в плане" : `${p > 0 ? "+" : "−"}${fmt(Math.abs(p))}%`;

function views<T extends object>(group: (T & { monthViews: Record<string, T> }) | undefined): T[] {
  return group ? [group, ...Object.entries(group.monthViews).filter(([key]) => key !== "all").map(([, view]) => view)] : [];
}

// ---------- история заказчика: покупал у нас, кому проигрывали ----------

interface Loss { bin: string; name: string; customerBin: string; customerName: string; diff: number | null }

function buildCustomerIndices({ plans: allPlans, market: allMarket, competitors: allCompetitors }: BidSources) {
  const bought = new CustomerIndex<true>();
  const lost = new CustomerIndex<Loss>();
  const rememberPurchase = (bin: unknown, name: unknown) => bought.add(bin, name, true);
  const crmLosses = new Map<string, Loss>();
  const protocolLosses = new Map<string, Loss>();
  const rememberProtocolLoss = (lot: { annoId: string; lotNumber: string; customerBin: string; customerName: string }, bin: string, name: string, diff: number | null) => {
    if ((!bin && !name) || (!lot.annoId && !lot.lotNumber)) return;
    const key = JSON.stringify([lot.annoId, lot.lotNumber, bin || normalizeCustomerName(name)]);
    const prev = protocolLosses.get(key);
    protocolLosses.set(key, {
      bin, name: prev?.name || name,
      customerBin: validBin(prev?.customerBin) || lot.customerBin,
      customerName: prev?.customerName || lot.customerName, diff: prev?.diff ?? diff
    });
  };
  // История общая для обеих групп: заказчик, купивший у нас панели, покупал у нас.
  for (const key of ["ip", "kt"] as const) {
    for (const c of allPlans[key]?.wonCustomers ?? []) rememberPurchase(c.bin, c.name);
    for (const slice of views(allPlans[key])) {
      for (const c of slice.customers) {
        if (c.wonCount > 0 || c.planList.some((p) => p.outcomeCategory === "won")) rememberPurchase(c.bin, c.name);
      }
      for (const c of slice.lostTo?.competitors ?? []) {
        for (const d of c.deals) {
          if (crmLosses.has(d.id)) continue;
          crmLosses.set(d.id, {
            bin: c.bin, name: c.name, customerBin: d.customerBin, customerName: d.customerName,
            diff: d.contractSum == null ? null : pct(d.contractSum, d.planSum)
          });
        }
      }
    }
    for (const slice of views(allMarket[key])) {
      for (const c of slice.customers) {
        if (c.us || c.contractList.some((item) => item.us)) rememberPurchase(c.bin, c.name);
      }
      for (const supplier of slice.suppliers) {
        if (!supplier.us) continue;
        for (const c of supplier.contractList) rememberPurchase(c.customerBin, c.customer);
      }
    }
    for (const slice of views(allCompetitors[key])) {
      for (const c of slice.competitors) {
        for (const lot of c.lotList) {
          if (!lot.isWinner) continue;
          if (c.us) rememberPurchase(lot.customerBin, lot.customerName);
          else {
            const diff = lot.discountPct !== null ? -lot.discountPct :
              lot.bidTotalPrice === null || lot.plannedSum === null ? null : pct(lot.bidTotalPrice, lot.plannedSum);
            rememberProtocolLoss(lot, c.bin, c.name, diff);
          }
        }
      }
      for (const rival of slice.headToHead) {
        for (const lot of rival.lots) {
          if (lot.weWon) rememberPurchase(lot.customerBin, lot.customerName);
          else if (lot.rivalWon) {
            const diff = lot.winnerDiscountPct !== null ? -lot.winnerDiscountPct : null;
            rememberProtocolLoss(lot, lot.winnerBin || rival.bin, lot.winnerName || rival.name, diff);
          }
        }
      }
    }
  }
  for (const d of [...protocolLosses.values(), ...crmLosses.values()]) lost.add(d.customerBin, d.customerName, d);
  return { bought, lost };
}

// ---------- шаблоны ТС ----------

type TemplateSource = CompetitorsSliceSource["specTemplates"][number];
type TemplateLot = TemplateSource["lots"][number];
interface TemplateMatch { template: TemplateSource; lot: TemplateLot }
interface TemplateHit { template: TemplateSource; historical: boolean; strong: boolean; directStrong: boolean }

function buildTemplateIndex(group: CompetitorsSource | undefined): (item: BidItem) => TemplateHit | null {
  const customers = new CustomerIndex<TemplateMatch>();
  const byLot = new Map<string, TemplateMatch[]>();
  const byAnnouncement = new Map<string, TemplateMatch[]>();
  for (const template of group?.specTemplates ?? []) {
    for (const lot of template.lots) {
      const match = { template, lot };
      append(byLot, lot.lotNumber, match);
      append(byAnnouncement, lot.annoId, match);
      customers.add(lot.customerBin, lot.customerName, match);
    }
  }
  return (item) => {
    const announcement = item.annoId || String(item.announceUrl || item.lotUrl || "").match(/\/announce\/index\/(\d+)(?:[/?#]|$)/)?.[1];
    const history = customers.find(item.customerBin, item.customerName);
    const direct = (item.lotNumber && byLot.get(item.lotNumber)) || (announcement && byAnnouncement.get(announcement)) || undefined;
    const match = (direct || history).reduce<TemplateMatch | null>((best, m) => {
      if (!best) return m;
      if (m.lot.strength !== best.lot.strength) return m.lot.strength === "strong" ? m : best;
      return m.lot.sharePct > best.lot.sharePct ? m : best;
    }, null);
    if (!match) return null;
    return {
      template: match.template,
      historical: !direct,
      strong: match.lot.strength === "strong" || history.some((m) => m.template === match.template && m.lot.strength === "strong"),
      directStrong: Boolean(direct) && match.lot.strength === "strong"
    };
  };
}

// ---------- цена побед ----------

const diagonal = (value: unknown): string | undefined => String(value || "").match(/(?:^|\D)(65|75|86)\s*(?:["″”»]|дюйм|$)/i)?.[1];

function priceKind(label: unknown): string {
  const name = normalizeCustomerName(label);
  if (name === "компьютеры и моноблоки") return name;
  const kinds: Array<[RegExp, string]> = [
    [/панел|^(65|75|86)\b/, "панель"], [/доск/, "доска"], [/учебн.*комплект/, "учебный комплект"],
    [/системн.*блок/, "системный блок"], [/моноблок/, "моноблок"], [/компьютер/, "компьютер"],
    [/ноутбук/, "ноутбук"], [/монитор/, "монитор"], [/мфу|многофункциональн/, "мфу"], [/принтер/, "принтер"]
  ];
  return kinds.find(([pattern]) => pattern.test(name))?.[1] || name;
}

function priceKey(label: unknown): string {
  const kind = priceKind(label);
  const size = kind === "панель" && diagonal(label);
  return size ? `панель ${size}` : kind;
}

const positive = (...values: Array<number | null | undefined>): number | undefined =>
  values.find((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);

interface PriceBenchmark { med: number; exact: boolean }

function buildPriceIndex(group: CompetitorsSource | undefined, market: MarketSource | undefined): (item: BidItem) => PriceBenchmark | undefined {
  const prices = new Map<string, number>();
  const enough = (n: number | null) => n === null || n >= BID_PRICE_MIN_SAMPLES;
  for (const row of market?.kinds ?? []) {
    const med = enough(row.n) ? positive(row.med, row.usMed) : undefined;
    if (med) prices.set(priceKey(row.kind), med);
  }
  const compRows = group ? [...group.prices.rows, group.prices.kitsRow].filter((r): r is NonNullable<typeof r> => r !== null) : [];
  for (const row of compRows) {
    const med = positive(enough(row.compWinner.n) ? row.compWinner.med : null, enough(row.ourWinner.n) ? row.ourWinner.med : null);
    if (med) prices.set(priceKey(row.label || row.kind), med);
  }
  return (item) => {
    let kind = priceKind(item.kind);
    if (item.kind === "МФУ и принтеры" || item.kind === "Компьютеры и системные блоки") {
      const type = priceKind(item.itemName);
      if (["мфу", "принтер", "компьютер", "системный блок"].includes(type)) kind = type;
      else if (item.truCode?.startsWith("262016")) kind = "принтер";
      else if (item.truCode?.startsWith("262040")) kind = "системный блок";
      else if (item.kind === "Компьютеры и системные блоки") kind = "компьютер";
    }
    const size = kind === "панель" && (diagonal(item.itemName) || diagonal(item.kind));
    const sized = size ? prices.get(`панель ${size}`) : undefined;
    if (sized) return { med: sized, exact: true };
    const byKind = prices.get(kind);
    if (byKind) return { med: byKind, exact: !COARSE_PRICE_KINDS.has(kind) };
    const pc = ["компьютер", "моноблок"].includes(kind) ? prices.get("компьютеры и моноблоки") : undefined;
    return pc ? { med: pc, exact: true } : undefined;
  };
}

// ---------- прошлые отклонения наших заявок у заказчика ----------

function buildRejectionIndex(group: CompetitorsSource | undefined): CustomerIndex<LossReasonKey> {
  const index = new CustomerIndex<LossReasonKey>();
  const seen = new Set<string>();
  for (const slice of views(group)) {
    for (const r of slice.ourRejections) {
      const key = `${r.annoId}|${r.lotNumber}|${r.ourBin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // В отклонениях нет БИН заказчика: только название. Текст причины нужен лишь для категории.
      index.add("", r.customerName, classifyRejectionReason(r.rejectionShort, r.rejectionDetail));
    }
  }
  return index;
}

// ---------- причины и вердикт ----------

function lossReasons(losses: Loss[], customerBin: string): BidReason[] {
  if (!losses.length) return [];
  const rivals = new Map<string, Loss[]>();
  for (const loss of losses) append(rivals, loss.bin || normalizeCustomerName(loss.name), loss);
  const labels = [...rivals.values()].sort((a, b) => b.length - a.length).map((items) => {
    const known = items.map((d) => d.diff).filter((v): v is number => v !== null && Number.isFinite(v));
    const average = known.length ? Math.round(known.reduce((sum, value) => sum + value, 0) / known.length) : null;
    return [items[0].name || items[0].bin, `${fmt(items.length)}×`, signedPct(average)].filter(Boolean).join(" · ");
  });
  const title = (label: string) => `${label}. Процент — среднее отклонение цены победы от плана по известным ценам.`;
  if (!customerBin || !losses.some((d) => validBin(d.customerBin) === customerBin)) {
    return [{ kind: "rival", tone: "warn", text: "ранее забрал конкурент", title: title(labels.join("; ")) }];
  }
  return labels.map((label) => ({ kind: "rival", tone: "warn", text: `забирал ${label}`, title: title(label) }));
}

function templateReason(hit: TemplateHit): { reason: BidReason; ours: boolean } {
  const winner = hit.template.winners[0];
  const ours = Boolean(winner?.ourCompany);
  const text = `Шаблон ТС: ${hit.template.templateName}${winner ? ` · побеждал ${winner.name} (${winner.sharePct}%)` : ""}${hit.strong ? " · сильное совпадение" : ""}`;
  return {
    ours,
    reason: { kind: "template", tone: ours ? "good" : "warn", text, ...(hit.historical ? { title: "Ранее найден у этого заказчика" } : {}) }
  };
}

function rejectionReason(keys: LossReasonKey[]): BidReason {
  const counts = new Map<LossReasonKey, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [main] = sorted;
  return {
    kind: "rejections", tone: "warn",
    text: `нас отклоняли: ${LOSS_REASON_LABELS[main[0]]} · ${fmt(main[1])}×`,
    title: `Наши отклонённые заявки у этого заказчика по протоколам итогов: ${sorted.map(([k, n]) => `${LOSS_REASON_LABELS[k]} — ${fmt(n)}`).join("; ")}.`
  };
}

export interface BidContext {
  assess(item: BidItem): BidAssessment;
}

export function buildBidContext(sources: BidSources, key: GroupKey): BidContext {
  const competitors = sources.competitors[key];
  const { bought, lost } = buildCustomerIndices(sources);
  const findTemplate = buildTemplateIndex(competitors);
  const findPrice = buildPriceIndex(competitors, sources.market[key]);
  const rejections = buildRejectionIndex(competitors);

  return {
    assess(item) {
      const reasons: BidReason[] = [];
      let plus = 0, minus = 0, blocker = false;

      if (bought.find(item.customerBin, item.customerName).length) {
        reasons.push({ kind: "bought", tone: "good", text: "покупал у нас" });
        plus += 2;
      }
      const losses = lost.find(item.customerBin, item.customerName);
      if (losses.length) {
        reasons.push(...lossReasons(losses, validBin(item.customerBin)));
        minus += losses.length >= 3 ? 2 : 1;
      }
      const hit = findTemplate(item);
      if (hit) {
        const { reason, ours } = templateReason(hit);
        reasons.push(reason);
        if (ours) plus += 1;
        else if (hit.directStrong) blocker = true;
        else minus += !hit.historical ? 2 : hit.strong ? 2 : 1;
      }
      const rejected = rejections.find(item.customerBin, item.customerName);
      if (rejected.length) {
        reasons.push(rejectionReason(rejected));
        minus += rejected.length >= 2 ? 2 : 1;
      }

      const unit = item.price || (item.qty > 0 ? item.sum / item.qty : 0);
      const benchmark = findPrice(item);
      let price: BidPrice | undefined;
      if (unit > 0 && benchmark) {
        const median = benchmark.med;
        const status = !benchmark.exact ? "" : unit * 100 >= median * BID_PRICE_GOOD_PCT ? "good" : unit * 100 < median * BID_PRICE_BAD_PCT ? "bad" : "";
        price = { unit: Math.round(unit), winMedian: Math.round(median), status };
        if (status === "good") {
          plus += 1;
          reasons.push({ kind: "price", tone: "good", text: "цена с запасом к ценам побед" });
        } else if (status === "bad") {
          minus += 1;
          reasons.push({ kind: "price", tone: "bad", text: "цена ниже цен побед больше чем на 10%" });
        }
      }

      // Справочная цена (неточный ориентир) — не сигнал: одна она вердикт не выносит.
      const hasSignal = reasons.length > 0 || Boolean(benchmark?.exact && price);
      const verdict: BidVerdict = !competitors || !hasSignal ? "unknown"
        : blocker ? "nogo"
        : minus === 0 ? "go"
        : plus - minus <= -3 ? "nogo" : "caution";
      return { verdict, reasons, ...(price ? { price } : {}), value: Math.round((item.sum || 0) * BID_VALUE_WEIGHTS[verdict]) };
    }
  };
}

// ---------- payload ----------

const RADAR_COLUMNS = ["submitToday", "discussion", "secondChance"] as const;

function withRadarBids(radar: RadarView, ctx: (key: GroupKey) => BidContext): RadarView {
  const group = (key: GroupKey): RadarGroupView | undefined => {
    const g = radar[key];
    if (!g) return g;
    const out: RadarGroupView = { ...g };
    for (const col of RADAR_COLUMNS) {
      out[col] = (g[col] ?? []).map((card: RadarCard) => ({ ...card, bid: ctx(key).assess(card) }));
    }
    return out;
  };
  return { ...radar, ip: group("ip") as RadarGroupView, kt: group("kt") as RadarGroupView };
}

function withPlanBids(plans: PlansMonitorView, ctx: (key: GroupKey) => BidContext): PlansMonitorView {
  const out: PlansMonitorView = { ...plans };
  for (const key of ["ip", "kt"] as const) {
    const g = plans[key];
    if (!g) continue;
    out[key] = { ...g, openPlans: (g.openPlans ?? []).map((d) => ({ ...d, bid: ctx(key).assess(d) })) };
  }
  return out;
}

/**
 * Копия payload, в которой у карточек Радара (кроме пропущенных сроков) и открытых планов есть `bid`.
 * Входной payload не меняется. Источники — только этот payload: что не ушло в страницу, в вердикт не попадёт.
 */
export function withBids(payload: SalesPultPayload): SalesPultPayload {
  const hasRadar = Boolean(payload.radar && !payload.radar.error);
  const hasPlans = Boolean(payload.plans && !payload.plans.error);
  if (!hasRadar && !hasPlans) return payload;
  const { sources } = parseBidSources(payload);
  const cache = new Map<GroupKey, BidContext>();
  const ctx = (key: GroupKey): BidContext => {
    let c = cache.get(key);
    if (!c) { c = buildBidContext(sources, key); cache.set(key, c); }
    return c;
  };
  return {
    ...payload,
    ...(hasRadar ? { radar: withRadarBids(payload.radar!, ctx) } : {}),
    ...(hasPlans ? { plans: withPlanBids(payload.plans!, ctx) } : {})
  };
}

/** Сводка для лога сборки: только числа. */
export function summarizeBids(payload: SalesPultPayload): Record<GroupKey, Record<BidVerdict, number>> {
  const empty = (): Record<BidVerdict, number> => ({ go: 0, caution: 0, nogo: 0, unknown: 0 });
  const out = { ip: empty(), kt: empty() };
  for (const key of ["ip", "kt"] as const) {
    const g = payload.radar?.[key];
    for (const col of RADAR_COLUMNS) for (const c of g?.[col] ?? []) if (c.bid) out[key][c.bid.verdict]++;
    for (const d of payload.plans?.[key]?.openPlans ?? []) if (d.bid) out[key][d.bid.verdict]++;
  }
  return out;
}

/** Строка для лога сборки: число вердиктов по группам и битых записей источников. Без названий и сумм. */
export function formatBidSummary(payload: SalesPultPayload): string {
  const counts = summarizeBids(withBids(payload));
  const { dropped } = parseBidSources(payload);
  const part = (label: string, c: Record<BidVerdict, number>) =>
    `${label}: идём ${c.go}, осторожно ${c.caution}, не идём ${c.nogo}, без вердикта ${c.unknown}`;
  return `${part("ИП", counts.ip)}; ${part("КТ", counts.kt)}${dropped ? `; пропущено битых записей источников: ${dropped}` : ""}`;
}
