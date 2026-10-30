import { fmtNumber } from "../salesPult/format.js";

/** Сводка для кейса: сколько сделок завёл робот, сколько выиграно и сколько ручной работы это заменило. */

export type GzCaseSource = "plans" | "lots" | "procurement" | "excel";

export const GZ_CASE_ORIGINATORS: Record<string, GzCaseSource> = {
  "scrape2lead-gz-plans": "plans",
  "scrape2lead-gz-lots": "lots",
  "scrape2lead-procurement": "procurement"
};

/** Первые сделки робот заводил через Excel-импорт Bitrix: их выдаёт только название `[GZ …]`. */
export const GZ_CASE_TITLE_MARK = "[GZ";

export const GZ_CASE_OUTCOME_FIELD = "UF_CRM_S2L_GZ_OUTCOME";

export const GZ_CASE_DEAL_SELECT = [
  "ID", "TITLE", "ORIGINATOR_ID", "DATE_CREATE", "STAGE_SEMANTIC_ID", "OPPORTUNITY", GZ_CASE_OUTCOME_FIELD
];

const SOURCE_LABELS: Record<GzCaseSource, string> = {
  plans: "Пункты планов goszakup",
  lots: "Лоты goszakup",
  procurement: "Другие площадки",
  excel: "Ранний Excel-импорт ([GZ …] в названии)"
};

export interface GzCaseDeal {
  ID: string | number;
  TITLE?: string | null;
  ORIGINATOR_ID?: string | null;
  DATE_CREATE?: string | null;
  STAGE_SEMANTIC_ID?: string | null;
  OPPORTUNITY?: string | number | null;
  UF_CRM_S2L_GZ_OUTCOME?: string | null;
}

export interface GzCaseBucket { deals: number; amount: number }

export interface GzCaseSummary {
  deals: number;
  amount: number;
  firstCreated: string | null;
  lastCreated: string | null;
  bySource: Record<GzCaseSource, GzCaseBucket>;
  byMonth: Array<{ month: string } & GzCaseBucket>;
  stages: { won: GzCaseBucket; lost: GzCaseBucket; open: GzCaseBucket };
  /** Выигранные среди закрытых в Bitrix; null, пока закрытых нет. */
  winRate: number | null;
  /** Вид итога с портала (`won`, `lost`, `partner`, `published`…) → число сделок; `none` — итога нет. */
  outcomes: Record<string, number>;
  minutesPerDeal: number;
  hoursSaved: number;
}

export function gzCaseSource(deal: GzCaseDeal): GzCaseSource | null {
  const byOrigin = GZ_CASE_ORIGINATORS[String(deal.ORIGINATOR_ID ?? "")];
  if (byOrigin) return byOrigin;
  return String(deal.TITLE ?? "").includes(GZ_CASE_TITLE_MARK) ? "excel" : null;
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

export function summarizeGzCase(deals: GzCaseDeal[], options: { minutesPerDeal: number }): GzCaseSummary {
  const bySource: Record<GzCaseSource, GzCaseBucket> = {
    plans: emptyBucket(), lots: emptyBucket(), procurement: emptyBucket(), excel: emptyBucket()
  };
  const stages = { won: emptyBucket(), lost: emptyBucket(), open: emptyBucket() };
  const months = new Map<string, GzCaseBucket>();
  const outcomes: Record<string, number> = {};
  const seen = new Set<string>();
  let total = 0;
  let amount = 0;
  let firstCreated: string | null = null;
  let lastCreated: string | null = null;

  for (const deal of deals) {
    const id = String(deal.ID);
    const source = gzCaseSource(deal);
    if (!source || seen.has(id)) continue;
    seen.add(id);
    const sum = amountOf(deal);
    total += 1;
    amount += sum;
    add(bySource[source], sum);

    const stage = deal.STAGE_SEMANTIC_ID === "S" ? "won" : deal.STAGE_SEMANTIC_ID === "F" ? "lost" : "open";
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
  }

  const closed = stages.won.deals + stages.lost.deals;
  return {
    deals: total,
    amount,
    firstCreated,
    lastCreated,
    bySource,
    byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, bucket]) => ({ month, ...bucket })),
    stages,
    winRate: closed > 0 ? stages.won.deals / closed : null,
    outcomes,
    minutesPerDeal: options.minutesPerDeal,
    hoursSaved: Math.round(total * options.minutesPerDeal / 60 * 10) / 10
  };
}

const money = (value: number) => `${fmtNumber(value)} ₸`;
const bucketText = (bucket: GzCaseBucket) => `${fmtNumber(bucket.deals)} на ${money(bucket.amount)}`;

export function formatGzCaseReport(summary: GzCaseSummary, asOfDate: string): string {
  const outcome = (kind: string) => fmtNumber(summary.outcomes[kind] ?? 0);
  const lines = [
    `# Кейс Scrape2Lead: сделки робота в Bitrix24 на ${asOfDate}`,
    "",
    `Период: ${summary.firstCreated ?? "—"} — ${summary.lastCreated ?? "—"}`,
    `Создано сделок: ${fmtNumber(summary.deals)} (сумма по сделкам ${money(summary.amount)})`,
    "",
    "## Этапы в Bitrix24",
    `- Выиграно (этап Bitrix): ${bucketText(summary.stages.won)}`,
    `- Проиграно или закрыто: ${bucketText(summary.stages.lost)}`,
    `- В работе: ${bucketText(summary.stages.open)}`,
    `- Доля выигранных среди закрытых: ${summary.winRate === null ? "—" : `${Math.round(summary.winRate * 100)}%`}`,
    "",
    "## Итог закупки по данным портала",
    `- Договор подписан с нами (портал): ${outcome("won")}`,
    `- Выиграл партнёр группы: ${outcome("partner")}`,
    `- Договор у другого поставщика: ${outcome("lost")}`,
    `- Итог ещё не определён: ${outcome("none")}`,
    "",
    "## Источники",
    ...(Object.keys(SOURCE_LABELS) as GzCaseSource[])
      .filter((source) => summary.bySource[source].deals > 0)
      .map((source) => `- ${SOURCE_LABELS[source]}: ${bucketText(summary.bySource[source])}`),
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
