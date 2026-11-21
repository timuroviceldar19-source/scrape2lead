// Вердикт «идём / осторожно / не идём» по лоту или плану (пункт 5 RFC). Считается на сервере (`assess.ts`),
// браузер его только рисует (`page/bid.client.js`).

/** `unknown` — вердикт не выносится: нет ни одного сигнала или нет данных «Конкурентов» по группе. */
export type BidVerdict = "go" | "caution" | "nogo" | "unknown";

export type BidReasonKind = "bought" | "rival" | "template" | "rejections" | "price";

export interface BidReason {
  kind: BidReasonKind;
  /** good — за подачу, warn/bad — против. */
  tone: "good" | "warn" | "bad";
  text: string;
  title?: string;
}

/** Цена за единицу против медианы цены побед по виду товара; status: good ≥ 115%, bad < 90%. */
export interface BidPrice {
  unit: number;
  winMedian: number;
  status: "good" | "bad" | "";
}

export interface BidAssessment {
  verdict: BidVerdict;
  reasons: BidReason[];
  price?: BidPrice;
  /** Сумма × вес вердикта (`BID_VALUE_WEIGHTS`): порядок «по ценности» на Радаре. */
  value: number;
}
