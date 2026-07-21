import type { ClassifiedProcurement, ProcurementClassification, ProcurementProduct, ProcurementRecord } from "./types.js";

export interface ProcurementFilterOptions {
  minAmount?: number;
  pkTruPrefixes?: string[];
  panelKeywords?: string[];
  stopWords?: string[];
}

const DEFAULT_PK_PREFIXES = ["262011.", "262013.", "262017.100."];
const DEFAULT_PANEL_KEYWORDS = ["доска специальная", "панель интерактивная", "панель жидкокристаллическая"];
const DEFAULT_STOP_WORDS = ["мфу", "принтер", "устройство многофункциональное"];
const PK_NAME_WORDS = ["компьютер", "моноблок", "ноутбук", "монитор", "рабочая станция"];

export function classifyProcurementRecords(records: ProcurementRecord[], options: ProcurementFilterOptions = {}): ProcurementClassification {
  const config = {
    minAmount: options.minAmount ?? 500_000,
    pkTruPrefixes: options.pkTruPrefixes ?? DEFAULT_PK_PREFIXES,
    panelKeywords: options.panelKeywords ?? DEFAULT_PANEL_KEYWORDS,
    stopWords: options.stopWords ?? DEFAULT_STOP_WORDS
  };
  const result: ProcurementClassification = { data: [], review: [], rejected: [] };
  for (const record of records) {
    const classification = classify(record, config);
    if (classification.bucket === "data") result.data.push(classification.item);
    else if (classification.bucket === "review") result.review.push(classification.item);
    else result.rejected.push(classification.item);
  }
  return result;
}

function classify(record: ProcurementRecord, config: Required<ProcurementFilterOptions>): {
  bucket: "data" | "review" | "rejected";
  item: ClassifiedProcurement;
} {
  if (!record.externalId.trim()) return rejected(record, null, "missing_external_id");
  if (!record.url.trim()) return rejected(record, null, "missing_url");
  if (record.amount < config.minAmount) return rejected(record, null, "below_min_amount");

  const haystack = normalize(`${record.productName} ${record.description}`);
  if (config.stopWords.some((word) => haystack.includes(normalize(word)))) return rejected(record, null, "stop_word");

  let product: ProcurementProduct;
  const panelMatched = config.panelKeywords.some((word) => haystack.includes(normalize(word)));
  const explicitlyInteractive = ["интерактив", "interactive", "сенсор"].some((word) => haystack.includes(word));
  if (panelMatched && explicitlyInteractive) {
    product = "panel";
  } else if (panelMatched) {
    return review(record, "panel", "ambiguous_panel");
  } else {
    const normalizedCode = normalizeTru(record.truCode);
    const codeAllowed = config.pkTruPrefixes.some((prefix) => normalizedCode.startsWith(normalizeTru(prefix)));
    const pkNamed = PK_NAME_WORDS.some((word) => haystack.includes(word));
    if (codeAllowed) product = "pk";
    else if (pkNamed && !normalizedCode) return review(record, "pk", "missing_tru_code");
    else if (pkNamed) return rejected(record, "pk", "irrelevant_tru_code");
    else return rejected(record, null, "irrelevant_product");
  }

  if (!record.customerBin) return review(record, product, "missing_bin");
  return { bucket: "data", item: { record, product, reason: null } };
}

function rejected(record: ProcurementRecord, product: ProcurementProduct | null, reason: ClassifiedProcurement["reason"]) {
  return { bucket: "rejected" as const, item: { record, product, reason } };
}
function review(record: ProcurementRecord, product: ProcurementProduct, reason: ClassifiedProcurement["reason"]) {
  return { bucket: "review" as const, item: { record, product, reason } };
}
function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/g, " ").trim(); }
function normalizeTru(value: string | null): string { return (value ?? "").replace(/\s+/g, "").replace(/,+/g, "."); }
