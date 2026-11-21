import type {
  CompetitorGroup,
  CompetitorsGroupSliceView,
  CompetitorsGroupView,
  CompetitorsView,
  HeadToHeadLotItem,
  LossBreakdown,
  LossHeadToHeadBucket,
  LossLotLink,
  LossReasonKey,
  LossReasonRow,
  OurRejectionItem
} from "./types.js";

/**
 * «Потери по причинам»: сколько денег группа F3 (F3 + партнёры) теряет на отклонённых заявках и проигрышах.
 * Правила (журнал: docs/testing/pult-losses-by-reason.tdd.md):
 * - деньги — `ourPrice`, сумма нашей заявки без НДС, как в источнике;
 * - лот (`annoId` + `lotNumber`) считается один раз, даже если отклонили и F3, и партнёра, или он повторяется
 *   у нескольких соперников в «Где мы встречались»;
 * - лот, который всё равно выиграла компания группы, потерей не считается;
 * - сумма по причинам равна итогу.
 */

/** Русские подписи категорий — только здесь. Порядок ключей — порядок проверки в классификаторе. */
export const LOSS_REASON_LABELS: Readonly<Record<LossReasonKey, string>> = {
  security: "Обеспечение заявки",
  software_docs: "Документы на ПО",
  manufacturer_letter: "Письмо производителя",
  tech_mismatch: "Несоответствие ТС",
  documents: "Прочие документы",
  other: "Другое"
};

export const LOSS_RECENT_DAYS = 7;
export const LOSS_LOTS_PER_REASON = 10;

/* ==================== Классификатор причин ==================== */

// Регулярки работают по нормализованному тексту (нижний регистр, ё → е, без кавычек).
// `\b` в JS не понимает кириллицу, поэтому границы слов — через `\p{L}` с флагом `u`.
const SOFTWARE_PHRASE = /программн\S*\s+обеспечени\S*|бағдарламалық\s+қамтамасыз\s+ет\S*/gu;
const SOFTWARE_TOKEN = " софт ";

const RE_SECURITY = new RegExp(
  [
    String.raw`обеспечени\S*\s+(?:\S+\s+){0,2}заявк`,
    String.raw`заявк\S*\s+обеспечени`,
    String.raw`гарантийн\S*\s+взнос`,
    String.raw`банковск\S*\s+гаранти`,
    String.raw`(?:не\s+внес\S*|не\s+предостав\S*|не\s+представ\S*|отсутств\S*)\s+обеспечени`,
    String.raw`обеспечени\S*\s+не\s+(?:внесен|предоставлен|представлен|поступил)`,
    // каз.: «өтінімді қамтамасыз ету» — обеспечение заявки
    String.raw`өтінім\S*\s+қамтамасыз`
  ].join("|"),
  "u"
);

const RE_SOFTWARE_ALWAYS = /лицензи|реестр\S*\s+(?:\S+\s+)?доверенн|доверенн\S*\s+софт/u;
// «документ», но не «конкурсная документация» — это общая формулировка, а не конкретный документ.
const RE_SOFTWARE_DOC_WORDS = /документ(?!аци)|письм|правообладател|сертификат|реестр|подтвержд|ключ\S*\s+активац|(?<![\p{L}])хат|құжат/u;
const RE_SOFTWARE_TOKEN = /(?<![\p{L}])софт(?![\p{L}])/u;
// «ПО» — только заглавными как отдельное слово и только в тексте, где есть строчные буквы (иначе это предлог).
const RE_PO_ABBR = /(?<![\p{L}\p{N}])ПО(?![\p{L}\p{N}])/u;

const RE_MANUFACTURER = new RegExp(
  [
    String.raw`письм\S*\s+(?:\S+\s+){0,3}(?:производител|изготовител|правообладател|завод|вендор)`,
    String.raw`(?:производител|изготовител|правообладател)\S*\s+(?:\S+\s+){0,2}письм`,
    String.raw`авторизац`,
    String.raw`авторизован`,
    String.raw`дилер`,
    String.raw`дистрибь?ют`,
    String.raw`официальн\S*\s+представител`,
    String.raw`(?<![\p{L}])maf(?![\p{L}])`,
    // каз.: «өндірушінің хаты» — письмо производителя
    String.raw`өндіруші\S*\s+(?:\S+\s+)?хат`,
    String.raw`хат\S*\s+(?:\S+\s+)?өндіруші`
  ].join("|"),
  "u"
);

const RE_TECH = new RegExp(
  [
    String.raw`техническ\S*\s+(?:\S+\s+)?(?:спецификац|характеристик|требовани|параметр|задани)`,
    String.raw`характеристик`,
    String.raw`техспец`,
    String.raw`(?<![\p{L}])тс(?![\p{L}])`,
    String.raw`(?:не\s+соответств|несоответстви)\S*\s+(?:\S+\s+){0,3}спецификац`,
    // каз.: «техникалық ерекшелік», «техникалық сипаттама»
    String.raw`техникалық\s+(?:ерекшелі|сипаттам)`
  ].join("|"),
  "u"
);

const RE_DOCUMENTS = new RegExp(
  [
    String.raw`не\s*предостав`,
    String.raw`не\s*представ`,
    String.raw`не\s+приложен`,
    String.raw`не\s+подписан`,
    String.raw`без\s+подпис`,
    String.raw`подпис\S*\s+(?:не|отсутств)`,
    String.raw`эцп`,
    String.raw`электронн\S*\s+цифров\S*\s+подпис`,
    String.raw`просроч`,
    String.raw`истек\S*\s+срок`,
    String.raw`срок\S*\s+действи\S*\s+истек`,
    String.raw`нотариальн`,
    String.raw`документ(?!аци)`,
    String.raw`справк`,
    String.raw`свидетельств`,
    String.raw`сертификат`,
    String.raw`ст-kz`,
    // каз.: «құжат» (документ), «ұсынылмаған» (не предоставлен), «қол қойылмаған» (не подписан), «ЭЦҚ» (ЭЦП)
    String.raw`құжат`,
    String.raw`ұсынылмаған`,
    String.raw`ұсынбаған`,
    String.raw`қол\s+қойылмаған`,
    String.raw`эцқ`
  ].join("|"),
  "u"
);

function normalizeReasonText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"“”„'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Категория причины отклонения по короткой причине и подробностям протокола.
 * Порядок проверки: обеспечение → документы на ПО → письмо производителя → несоответствие ТС → прочие документы.
 * Казахские формулировки узнаются только по надёжным ключам, остальные уходят в `other`.
 */
export function classifyRejectionReason(short: string, detail: string): LossReasonKey {
  const original = `${short ?? ""} ${detail ?? ""}`.replace(/ё/g, "е");
  const text = ` ${normalizeReasonText(original).replace(SOFTWARE_PHRASE, SOFTWARE_TOKEN)} `;

  if (RE_SECURITY.test(text)) return "security";

  const mentionsSoftware = RE_SOFTWARE_TOKEN.test(text) || (/[а-я]/.test(original) && RE_PO_ABBR.test(original));
  if (RE_SOFTWARE_ALWAYS.test(text) || (mentionsSoftware && RE_SOFTWARE_DOC_WORDS.test(text))) return "software_docs";

  if (RE_MANUFACTURER.test(text)) return "manufacturer_letter";
  if (RE_TECH.test(text)) return "tech_mismatch";
  if (RE_DOCUMENTS.test(text)) return "documents";
  return "other";
}

/* ==================== Разбивка потерь ==================== */

/** Что нужно из среза: отклонения и полный (не урезанный до 50 лотов) список очных встреч. */
export type LossBreakdownSource = Pick<CompetitorsGroupSliceView, "ourRejections" | "headToHead">;

export interface LossBreakdownOptions {
  /** БИН компаний группы (F3 + партнёры): подходит `CompetitorsConfig`. Лоты, выигранные ими, — не потери. */
  allOurBins?: ReadonlySet<string>;
  /** Дата среза (Алматы, YYYY-MM-DD) для «свежих» отклонений; без неё `recentCheaper` пустой. */
  asOfDate?: string;
  recentDays?: number;
  maxLotsPerReason?: number;
}

const lotKey = (x: { annoId: string; lotNumber: string }): string => `${x.annoId}:${x.lotNumber}`;

/** Дата для окна «свежих»: окончание приёма заявок, иначе дата начала лота. */
export function rejectionDateOf(r: Pick<OurRejectionItem, "date" | "endDate">): string {
  return (r.endDate || r.date || "").slice(0, 10);
}

function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(Date.parse(`${iso}T12:00:00Z`));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Окно `days` календарных дней, заканчивающееся `asOfDate` включительно: (asOf − days; asOf]. */
function inRecentWindow(date: string, asOfDate: string, days: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return false;
  return date > shiftIsoDate(asOfDate, -days) && date <= asOfDate;
}

/** Лот выиграла компания группы: по БИН из настроек или по БИН наших же заявок в этом лоте. */
function wonByGroup(r: OurRejectionItem, ourBins: ReadonlySet<string>): boolean {
  return Boolean(r.winnerBin) && ourBins.has(r.winnerBin);
}

/**
 * Одна строка на лот: из нескольких отклонённых заявок группы берётся самая «больная» —
 * дешевле победителя, затем с наименьшей ценой. Её причина и сумма идут в разбивку.
 */
function representativeRejections(rows: readonly OurRejectionItem[], allOurBins?: ReadonlySet<string>): OurRejectionItem[] {
  const ourBins = new Set<string>(allOurBins ?? []);
  for (const r of rows) if (r.ourBin) ourBins.add(r.ourBin);

  const byLot = new Map<string, OurRejectionItem>();
  for (const r of rows) {
    if (wonByGroup(r, ourBins)) continue;
    const key = lotKey(r);
    const prev = byLot.get(key);
    if (!prev || isMorePainful(r, prev)) byLot.set(key, r);
  }
  return [...byLot.values()];
}

function isMorePainful(a: OurRejectionItem, b: OurRejectionItem): boolean {
  if (a.cheaperThanWinner !== b.cheaperThanWinner) return a.cheaperThanWinner;
  const pa = a.ourPrice ?? Infinity;
  const pb = b.ourPrice ?? Infinity;
  return pa < pb;
}

function toLink(r: OurRejectionItem): LossLotLink {
  return {
    lotNumber: r.lotNumber,
    date: r.date,
    ourCompany: r.ourCompany,
    ourPrice: r.ourPrice,
    winnerPrice: r.winnerPrice,
    cheaper: r.cheaperThanWinner,
    url: r.url
  };
}

const byPainThenSum = (a: OurRejectionItem, b: OurRejectionItem): number =>
  Number(b.cheaperThanWinner) - Number(a.cheaperThanWinner) ||
  (b.ourPrice ?? 0) - (a.ourPrice ?? 0) ||
  b.date.localeCompare(a.date);

const money = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

function emptyBucket(): LossHeadToHeadBucket {
  return { count: 0, sumOur: 0, sumGap: 0 };
}

function headToHeadLosses(rivals: LossBreakdownSource["headToHead"]): LossBreakdown["lostHeadToHead"] {
  const seen = new Set<string>();
  const byPrice = emptyBucket();
  const byCondDiscount = emptyBucket();
  for (const rival of rivals) {
    for (const l of rival.lots) {
      if (!l.rivalWon || l.weWon) continue;
      if (l.reason !== "price" && l.reason !== "cond_discount") continue;
      const key = lotKey(l);
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = l.reason === "price" ? byPrice : byCondDiscount;
      addToBucket(bucket, l);
    }
  }
  return { byPrice: roundBucket(byPrice), byCondDiscount: roundBucket(byCondDiscount) };
}

function addToBucket(bucket: LossHeadToHeadBucket, l: HeadToHeadLotItem): void {
  bucket.count++;
  bucket.sumOur += money(l.ourPrice);
  if (l.ourPrice !== null && l.winnerPrice !== null) bucket.sumGap += l.ourPrice - l.winnerPrice;
}

function roundBucket(b: LossHeadToHeadBucket): LossHeadToHeadBucket {
  return { count: b.count, sumOur: Math.round(b.sumOur), sumGap: Math.round(b.sumGap) };
}

export function buildLossBreakdown(slice: LossBreakdownSource, cfg: LossBreakdownOptions = {}): LossBreakdown {
  const maxLots = cfg.maxLotsPerReason ?? LOSS_LOTS_PER_REASON;
  const days = cfg.recentDays ?? LOSS_RECENT_DAYS;
  const reps = representativeRejections(slice.ourRejections, cfg.allOurBins);

  const groups = new Map<LossReasonKey, OurRejectionItem[]>();
  for (const r of reps) {
    const key = classifyRejectionReason(r.rejectionShort, r.rejectionDetail);
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const byReason: LossReasonRow[] = [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      label: LOSS_REASON_LABELS[key],
      count: rows.length,
      sumOur: Math.round(rows.reduce((s, r) => s + money(r.ourPrice), 0)),
      cheaperCount: rows.filter((r) => r.cheaperThanWinner).length,
      lots: [...rows].sort(byPainThenSum).slice(0, maxLots).map(toLink)
    }))
    .sort((a, b) => b.sumOur - a.sumOur || b.count - a.count || a.key.localeCompare(b.key));

  const cheaper = reps.filter((r) => r.cheaperThanWinner);
  const recent = cfg.asOfDate
    ? cheaper.filter((r) => inRecentWindow(rejectionDateOf(r), cfg.asOfDate!, days))
    : [];
  recent.sort((a, b) => rejectionDateOf(b).localeCompare(rejectionDateOf(a)) || money(b.ourPrice) - money(a.ourPrice));

  return {
    rejected: {
      count: reps.length,
      sumOur: byReason.reduce((s, r) => s + r.sumOur, 0),
      cheaperCount: cheaper.length,
      cheaperSumOur: Math.round(cheaper.reduce((s, r) => s + money(r.ourPrice), 0)),
      byReason
    },
    lostHeadToHead: headToHeadLosses(slice.headToHead),
    recentCheaper: {
      days,
      count: recent.length,
      sumOur: Math.round(recent.reduce((s, r) => s + money(r.ourPrice), 0)),
      lots: recent.slice(0, maxLots).map(toLink)
    }
  };
}

/* ==================== Свежие отклонения для утреннего пульса ==================== */

export interface RecentCheaperRejectionItem {
  group: CompetitorGroup;
  lotNumber: string;
  /** Окончание приёма заявок (или дата начала лота, если окончания нет). */
  date: string;
  kind: string;
  ourPrice: number | null;
  winnerPrice: number | null;
  url: string;
  ourCompany: string;
  customerName: string;
}

export interface RecentCheaperRejectionsSummary {
  count: number;
  sumOur: number;
  items: RecentCheaperRejectionItem[];
}

function groupOurBins(g: CompetitorsGroupView): Set<string> {
  return new Set<string>([
    ...g.competitors.filter((c) => c.us).map((c) => c.bin),
    ...g.ourRejections.map((r) => r.ourBin).filter(Boolean)
  ]);
}

/**
 * Отклонения группы при цене ниже победителя за `days` дней до `asOfDate` включительно, по ИП и КТ.
 * Лот считается один раз; лоты, выигранные компанией группы, не входят. Сортировка — свежие сверху.
 * Для утреннего пульса (подключает интегратор).
 */
export function summarizeRecentCheaperRejections(
  view: CompetitorsView,
  asOfDate: string,
  days = LOSS_RECENT_DAYS
): RecentCheaperRejectionsSummary {
  const items: RecentCheaperRejectionItem[] = [];
  let sumOur = 0;
  for (const g of [view.ip, view.kt]) {
    if (!g) continue;
    const reps = representativeRejections(g.ourRejections ?? [], groupOurBins(g));
    for (const r of reps) {
      if (!r.cheaperThanWinner) continue;
      const date = rejectionDateOf(r);
      if (!inRecentWindow(date, asOfDate, days)) continue;
      sumOur += money(r.ourPrice);
      items.push({
        group: g.group,
        lotNumber: r.lotNumber,
        date,
        kind: r.kind,
        ourPrice: r.ourPrice,
        winnerPrice: r.winnerPrice,
        url: r.url,
        ourCompany: r.ourCompany,
        customerName: r.customerName
      });
    }
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || money(b.ourPrice) - money(a.ourPrice));
  return { count: items.length, sumOur: Math.round(sumOur), items };
}
