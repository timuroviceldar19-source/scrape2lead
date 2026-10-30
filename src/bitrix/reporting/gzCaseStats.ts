import { fmtNumber } from "../salesPult/format.js";
import { PLAN_NUMBER_FIELDS, planRootsOf } from "../gzPlanItemChange.js";

/** Сводка для кейса: сколько сделок завёл робот, сколько выиграно и сколько ручной работы это заменило. */

export type GzCaseSource = "plans" | "lots" | "procurement" | "excel";

export const GZ_CASE_ORIGINATORS: Record<string, GzCaseSource> = {
  "scrape2lead-gz-plans": "plans",
  "scrape2lead-gz-lots": "lots",
  "scrape2lead-procurement": "procurement"
};

/** Название `[GZ …]` ставит робот. Менеджеры копируют его в свои сделки, поэтому по одному названию сделку роботу не засчитываем. */
export const GZ_CASE_TITLE_MARK = "[GZ";

/** Excel-импорт Bitrix, через который робот заводил первые сделки. */
export const GZ_CASE_EXCEL_ORIGINATOR = "app_iu_xls_import";

export const GZ_CASE_OUTCOME_FIELD = "UF_CRM_S2L_GZ_OUTCOME";

export const GZ_CASE_DEAL_SELECT = [
  "ID", "TITLE", "ORIGINATOR_ID", "ORIGIN_ID", "DATE_CREATE", "CATEGORY_ID", "STAGE_ID", "STAGE_SEMANTIC_ID", "OPPORTUNITY",
  ...PLAN_NUMBER_FIELDS, GZ_CASE_OUTCOME_FIELD
];

const SOURCE_LABELS: Record<GzCaseSource, string> = {
  plans: "Пункты планов goszakup",
  lots: "Лоты goszakup",
  procurement: "Другие площадки",
  excel: "Ранний Excel-импорт ([GZ …] в названии)"
};

/** Итоги с портала, которые пишет `deal-outcomes`; первые четыре строки отчёт показывает всегда. */
const OUTCOME_LABELS: Array<[string, string]> = [
  ["won", "Договор подписан с нами (портал)"],
  ["partner", "Выиграл партнёр группы"],
  ["lost", "Договор у другого поставщика"],
  ["terminated", "Договор расторгнут"],
  ["contract-draft", "Победитель определён, договор ещё не подписан"],
  ["published", "Объявление опубликовано, итога пока нет"],
  ["failed", "Закупка не состоялась"],
  ["cancelled", "Заказчик отказался от закупки"],
  ["repurposed", "Пункт плана переделан под другой товар"]
];
const ALWAYS_SHOWN_OUTCOMES = new Set(["won", "partner", "lost"]);

export interface GzCaseDeal {
  ID: string | number;
  TITLE?: string | null;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
  DATE_CREATE?: string | null;
  CATEGORY_ID?: string | number | null;
  STAGE_ID?: string | null;
  STAGE_SEMANTIC_ID?: string | null;
  OPPORTUNITY?: string | number | null;
  UF_CRM_PLAN_ID?: string | number | null;
  UF_CRM_1782386293000_IU_XLS?: string | number | null;
  UF_CRM_S2L_GZ_OUTCOME?: string | null;
}

export interface GzCaseBucket { deals: number; amount: number }

export interface GzCaseSummary {
  deals: number;
  amount: number;
  firstCreated: string | null;
  lastCreated: string | null;
  bySource: Record<GzCaseSource, GzCaseBucket>;
  /** Сделки с названием `[GZ …]`, которые завёл менеджер, а не робот: в итог не входят. */
  manualCopies: GzCaseBucket;
  /** Лоты, у которых уже есть сделка робота по тому же пункту плана: одна закупка, две сделки. */
  lotsRepeatingPlans: GzCaseBucket;
  /** Сделки робота без таких лотов — оценка числа разных закупок. */
  uniqueProcurements: GzCaseBucket;
  byMonth: Array<{ month: string } & GzCaseBucket>;
  /** `lost` — проиграно, `rejected` — менеджер отсеял закупку (этап с семантикой `apology`: не подходит, отменена, дубль…). */
  stages: { won: GzCaseBucket; lost: GzCaseBucket; rejected: GzCaseBucket; open: GzCaseBucket };
  /** Выигранные среди всех закрытых в Bitrix, включая отсеянные; null, пока закрытых нет. */
  winRate: number | null;
  /** Выигранные среди выигранных и проигранных; null, пока таких нет. */
  winRateContested: number | null;
  /** Вид итога с портала (`won`, `lost`, `partner`, `published`…) → число сделок; `none` — итога нет. */
  outcomes: Record<string, number>;
  portalWon: GzCaseBucket;
  /** Выиграно по этапу Bitrix или по порталу, каждая сделка один раз. */
  wonAny: GzCaseBucket;
  minutesPerDeal: number;
  hoursSaved: number;
}

export interface GzCaseOptions {
  minutesPerDeal: number;
  /** `STAGE_ID` → семантика этапа из `crm.status.list` (`success`, `failure`, `apology`, `process`). */
  stageSemantics?: Readonly<Record<string, string>>;
}

const hasTitleMark = (deal: GzCaseDeal) => String(deal.TITLE ?? "").includes(GZ_CASE_TITLE_MARK);

export function gzCaseSource(deal: GzCaseDeal): GzCaseSource | null {
  const byOrigin = GZ_CASE_ORIGINATORS[String(deal.ORIGINATOR_ID ?? "")];
  if (byOrigin) return byOrigin;
  return deal.ORIGINATOR_ID === GZ_CASE_EXCEL_ORIGINATOR && hasTitleMark(deal) ? "excel" : null;
}

export function isGzManualCopy(deal: GzCaseDeal): boolean {
  return gzCaseSource(deal) === null && deal.ORIGINATOR_ID !== GZ_CASE_EXCEL_ORIGINATOR && hasTitleMark(deal);
}

/** Число до дефиса в номере лота — пункт плана, из которого объявлен лот. */
function lotPlanNumber(deal: GzCaseDeal): number | null {
  const raw = /^gz-lot:(\d+)-/.exec(String(deal.ORIGIN_ID ?? "").trim())?.[1]
    ?? /\[GZ лот (\d+)-/.exec(String(deal.TITLE ?? ""))?.[1];
  return raw ? Number(raw) : null;
}

const emptyBucket = (): GzCaseBucket => ({ deals: 0, amount: 0 });

function add(bucket: GzCaseBucket, amount: number): void {
  bucket.deals += 1;
  bucket.amount += amount;
}

function amountOf(deal: GzCaseDeal): number {
  const value = Number(String(deal.OPPORTUNITY ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function stageOf(deal: GzCaseDeal, semantics: Readonly<Record<string, string>>): keyof GzCaseSummary["stages"] {
  if (deal.STAGE_SEMANTIC_ID === "S") return "won";
  if (deal.STAGE_SEMANTIC_ID !== "F") return "open";
  return semantics[String(deal.STAGE_ID ?? "")] === "apology" ? "rejected" : "lost";
}

export function summarizeGzCase(deals: GzCaseDeal[], options: GzCaseOptions): GzCaseSummary {
  const bySource: Record<GzCaseSource, GzCaseBucket> = {
    plans: emptyBucket(), lots: emptyBucket(), procurement: emptyBucket(), excel: emptyBucket()
  };
  const stages = { won: emptyBucket(), lost: emptyBucket(), rejected: emptyBucket(), open: emptyBucket() };
  const manualCopies = emptyBucket();
  const lotsRepeatingPlans = emptyBucket();
  const portalWon = emptyBucket();
  const wonAny = emptyBucket();
  const months = new Map<string, GzCaseBucket>();
  const outcomes: Record<string, number> = {};
  let total = 0;
  let amount = 0;
  let firstCreated: string | null = null;
  let lastCreated: string | null = null;

  const robot = new Map<string, GzCaseDeal & { source: GzCaseSource }>();
  const copies = new Set<string>();
  for (const deal of deals) {
    const id = String(deal.ID);
    const source = gzCaseSource(deal);
    if (source && !robot.has(id)) robot.set(id, { ...deal, source });
    if (isGzManualCopy(deal) && !copies.has(id)) {
      copies.add(id);
      add(manualCopies, amountOf(deal));
    }
  }
  const planNumbers = new Set([...robot.values()].filter((deal) => deal.source === "plans").flatMap((deal) => planRootsOf(deal)));

  for (const deal of robot.values()) {
    const sum = amountOf(deal);
    total += 1;
    amount += sum;
    add(bySource[deal.source], sum);

    const lotPlan = deal.source === "lots" ? lotPlanNumber(deal) : null;
    if (lotPlan !== null && planNumbers.has(lotPlan)) add(lotsRepeatingPlans, sum);

    const stage = stageOf(deal, options.stageSemantics ?? {});
    add(stages[stage], sum);

    const created = String(deal.DATE_CREATE ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(created)) {
      if (!firstCreated || created < firstCreated) firstCreated = created;
      if (!lastCreated || created > lastCreated) lastCreated = created;
      const month = created.slice(0, 7);
      if (!months.has(month)) months.set(month, emptyBucket());
      add(months.get(month)!, sum);
    }

    const outcome = /^([a-z-]+):/.exec(String(deal.UF_CRM_S2L_GZ_OUTCOME ?? "").trim())?.[1] ?? "none";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (outcome === "won") add(portalWon, sum);
    if (outcome === "won" || stage === "won") add(wonAny, sum);
  }

  const closed = stages.won.deals + stages.lost.deals + stages.rejected.deals;
  const contested = stages.won.deals + stages.lost.deals;
  return {
    deals: total,
    amount,
    firstCreated,
    lastCreated,
    bySource,
    manualCopies,
    lotsRepeatingPlans,
    uniqueProcurements: { deals: total - lotsRepeatingPlans.deals, amount: amount - lotsRepeatingPlans.amount },
    byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, bucket]) => ({ month, ...bucket })),
    stages,
    winRate: closed > 0 ? stages.won.deals / closed : null,
    winRateContested: contested > 0 ? stages.won.deals / contested : null,
    outcomes,
    portalWon,
    wonAny,
    minutesPerDeal: options.minutesPerDeal,
    hoursSaved: Math.round(total * options.minutesPerDeal / 60 * 10) / 10
  };
}

const money = (value: number) => `${fmtNumber(value)} ₸`;
const bucketText = (bucket: GzCaseBucket) => `${fmtNumber(bucket.deals)} на ${money(bucket.amount)}`;
const percent = (rate: number | null) => rate === null ? "—" : `${Math.round(rate * 100)}%`;

function outcomeLines(summary: GzCaseSummary): string[] {
  const known = new Set(OUTCOME_LABELS.map(([kind]) => kind));
  const lines = OUTCOME_LABELS
    .filter(([kind]) => ALWAYS_SHOWN_OUTCOMES.has(kind) || (summary.outcomes[kind] ?? 0) > 0)
    .map(([kind, label]) => kind === "won"
      ? `- ${label}: ${bucketText(summary.portalWon)}`
      : `- ${label}: ${fmtNumber(summary.outcomes[kind] ?? 0)}`);
  for (const [kind, count] of Object.entries(summary.outcomes)) {
    if (!known.has(kind) && kind !== "none") lines.push(`- Другой итог (${kind}): ${fmtNumber(count)}`);
  }
  lines.push(`- Итог ещё не определён: ${fmtNumber(summary.outcomes.none ?? 0)}`);
  return lines;
}

export function formatGzCaseReport(summary: GzCaseSummary, asOfDate: string): string {
  const lines = [
    `# Кейс Scrape2Lead: сделки робота в Bitrix24 на ${asOfDate}`,
    "",
    `Период: ${summary.firstCreated ?? "—"} — ${summary.lastCreated ?? "—"}`,
    `Создано сделок: ${fmtNumber(summary.deals)} (сумма по сделкам ${money(summary.amount)})`,
    `Уникальных закупок (оценка): ${bucketText(summary.uniqueProcurements)} — ${bucketText(summary.lotsRepeatingPlans)} `
      + "приходятся на лоты, по пункту плана которых сделка уже была",
    "",
    "## Этапы в Bitrix24",
    `- Выиграно (этап Bitrix): ${bucketText(summary.stages.won)}`,
    `- Проиграно: ${bucketText(summary.stages.lost)}`,
    `- Отсеяно менеджером (не подходит, отменена, дубль и т. п.): ${bucketText(summary.stages.rejected)}`,
    `- В работе: ${bucketText(summary.stages.open)}`,
    `- Доля выигранных среди выигранных и проигранных: ${percent(summary.winRateContested)}`,
    `- Доля выигранных среди всех закрытых, включая отсеянные: ${percent(summary.winRate)}`,
    "",
    "## Итог закупки по данным портала",
    ...outcomeLines(summary),
    "",
    `Выиграно всего (этап Bitrix или портал): ${bucketText(summary.wonAny)}`,
    "",
    "## Источники",
    ...(Object.keys(SOURCE_LABELS) as GzCaseSource[])
      .filter((source) => summary.bySource[source].deals > 0)
      .map((source) => `- ${SOURCE_LABELS[source]}: ${bucketText(summary.bySource[source])}`),
    ...(summary.manualCopies.deals > 0
      ? [`- Ручные копии сделок робота ([GZ …] в названии, завёл менеджер), в итог не входят: ${bucketText(summary.manualCopies)}`]
      : []),
    "",
    "## По месяцам",
    "| Месяц | Сделок | Сумма |",
    "| --- | ---: | ---: |",
    ...summary.byMonth.map((row) => `| ${row.month} | ${fmtNumber(row.deals)} | ${money(row.amount)} |`),
    "",
    `Сэкономлено часов: ~${fmtNumber(summary.hoursSaved)} (оценка: ${summary.minutesPerDeal} мин на сделку на ручной поиск и заведение; поменяйте --minutes-per-deal)`,
    "Суммы — из поля «Сумма» сделки (обычно плановая сумма закупки), а не сумма подписанного договора."
  ];
  return lines.join("\n") + "\n";
}
