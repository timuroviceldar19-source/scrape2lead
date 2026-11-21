import fs from "node:fs";
import path from "node:path";
import type {
  CompiledSpecTemplate,
  CompiledSpecTemplatesConfig,
  CompetitorBid,
  CompetitorLot,
  LotTemplateMatch,
  SpecTemplateMatch,
  SpecTemplateSummary,
  SpecTemplatesFileConfig,
  TemplateLotItem,
  TemplateWinnerRow
} from "./types.js";

const DEFAULT_SHINGLE_SIZE = 6;

export function normalizeTemplateText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^0-9a-zа-яәғқңөұүһі]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractWordShingles(normalizedText: string, n = DEFAULT_SHINGLE_SIZE): Set<string> {
  const words = normalizedText.split(" ").filter(Boolean);
  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(" "));
  }
  return shingles;
}

/**
 * Шаблоны ТС не хранятся в репозитории (он публичный): это куски текста ТС заказчиков.
 * Локально — `data/spec-templates.json` (в .gitignore), в GitHub шаг workflow пишет туда секрет
 * `SPEC_TEMPLATES`. Другой путь задаёт `SPEC_TEMPLATES_PATH`. Нет файла — шаблонов нет, сбор идёт как обычно.
 */
export const DEFAULT_SPEC_TEMPLATES_PATH = "data/spec-templates.json";

export function loadSpecTemplatesConfig(configPath?: string): CompiledSpecTemplatesConfig {
  const resolved = path.resolve(configPath || process.env.SPEC_TEMPLATES_PATH || DEFAULT_SPEC_TEMPLATES_PATH);
  if (!fs.existsSync(resolved)) {
    return { shingleSize: DEFAULT_SHINGLE_SIZE, templates: [] };
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as SpecTemplatesFileConfig;
  const shingleSize = raw.shingleSize ?? DEFAULT_SHINGLE_SIZE;
  const templates: CompiledSpecTemplate[] = (raw.templates ?? []).map((t) => {
    let text = t.text ?? "";
    if (!text && t.textPath) {
      const textResolved = path.isAbsolute(t.textPath) ? t.textPath : path.resolve(t.textPath);
      text = fs.readFileSync(textResolved, "utf8");
    }
    const normalized = normalizeTemplateText(text);
    const shingles = extractWordShingles(normalized, shingleSize);
    return {
      id: t.id,
      name: t.name,
      note: t.note ?? "",
      strongShare: t.strongShare ?? 0.4,
      partialShare: t.partialShare ?? 0.2,
      shingleSize,
      shingles,
      corePhrases: (t.corePhrases ?? []).map((p) => ({
        label: p.label,
        normalizedPhrase: normalizeTemplateText(p.phrase)
      })),
      extraPhrases: (t.extraPhrases ?? []).map((p) => ({
        label: p.label,
        normalizedPhrase: normalizeTemplateText(p.phrase)
      }))
    };
  });
  return { shingleSize, templates };
}

/**
 * Stage 2 reusable helper: matches a techspec text against all configured templates.
 */
export function matchSpecTemplates(
  specText: string,
  compiled: CompiledSpecTemplatesConfig
): SpecTemplateMatch[] {
  if (!specText || compiled.templates.length === 0) return [];
  const normalized = normalizeTemplateText(specText);
  if (!normalized) return [];

  const docShinglesBySize = new Map<number, Set<string>>();
  const matches: SpecTemplateMatch[] = [];

  for (const tpl of compiled.templates) {
    if (tpl.shingles.size === 0) continue;
    let docShingles = docShinglesBySize.get(tpl.shingleSize);
    if (!docShingles) {
      docShingles = extractWordShingles(normalized, tpl.shingleSize);
      docShinglesBySize.set(tpl.shingleSize, docShingles);
    }

    let common = 0;
    for (const sh of tpl.shingles) {
      if (docShingles.has(sh)) common++;
    }
    const share = common / tpl.shingles.size;

    const coreMatched = tpl.corePhrases.filter((p) => normalized.includes(p.normalizedPhrase)).map((p) => p.label);
    const extraMatched = tpl.extraPhrases.filter((p) => normalized.includes(p.normalizedPhrase)).map((p) => p.label);
    const matchedPhrases = [...coreMatched, ...extraMatched];

    let strength: "strong" | "partial" | null = null;
    if (share >= tpl.strongShare || coreMatched.length >= 2) {
      strength = "strong";
    } else if (share >= tpl.partialShare || coreMatched.length === 1) {
      strength = "partial";
    }

    if (strength) {
      matches.push({
        templateId: tpl.id,
        templateName: tpl.name,
        note: tpl.note,
        share,
        strength,
        matchedPhrases,
        coreMatchesCount: coreMatched.length
      });
    }
  }

  return matches.sort((a, b) => b.share - a.share);
}

/**
 * Stage 2 reusable helper: aggregates who wins lots matching a given spec template.
 */
export function summarizeTemplateWinners(
  template: Pick<CompiledSpecTemplate, "id" | "name" | "note">,
  lots: readonly CompetitorLot[],
  bids: readonly CompetitorBid[],
  matches: readonly LotTemplateMatch[]
): SpecTemplateSummary {
  const bestByLot = new Map<string, LotTemplateMatch>();
  for (const m of matches) {
    if (m.templateId !== template.id) continue;
    const key = `${m.annoId}:${m.lotNumber}`;
    const prev = bestByLot.get(key);
    if (!prev || m.share > prev.share) bestByLot.set(key, m);
  }

  const lotMap = new Map(lots.map((l) => [`${l.annoId}:${l.lotNumber}`, l]));
  const bidsByLot = new Map<string, CompetitorBid[]>();
  for (const b of bids) {
    const key = `${b.annoId}:${b.lotNumber}`;
    if (!bestByLot.has(key)) continue;
    const arr = bidsByLot.get(key) ?? [];
    arr.push(b);
    bidsByLot.set(key, arr);
  }

  const matchedLots: TemplateLotItem[] = [];
  const customers = new Set<string>();
  const winnerAgg = new Map<string, { bin: string; name: string; ourCompany: string; wins: number; wonSum: number }>();
  let strongLots = 0;
  let partialLots = 0;
  let decidedLots = 0;
  let bidsTotal = 0;
  let bidsAdmitted = 0;

  for (const [key, match] of bestByLot) {
    const lot = lotMap.get(key);
    if (!lot) continue;

    if (match.strength === "strong") strongLots++;
    else partialLots++;
    if (lot.customerBin || lot.customerName) customers.add(lot.customerBin || lot.customerName);

    const lotBids = bidsByLot.get(key) ?? [];
    bidsTotal += lotBids.length;
    bidsAdmitted += lotBids.filter((b) => b.admittedStatus === "Допущен").length;

    if (lot.status === "Закупка состоялась" && lot.winnerBin) {
      decidedLots++;
      const w = winnerAgg.get(lot.winnerBin) ?? {
        bin: lot.winnerBin,
        name: lot.winnerName || lot.winnerBin,
        ourCompany: lot.winnerIsOurs,
        wins: 0,
        wonSum: 0
      };
      w.wins++;
      w.wonSum += lot.winnerBidTotalPriceNoVat ?? lot.plannedSumNoVat ?? 0;
      winnerAgg.set(lot.winnerBin, w);
    }

    matchedLots.push({
      annoId: lot.annoId,
      lotNumber: lot.lotNumber,
      date: lot.startDate,
      customerName: lot.customerName,
      customerBin: lot.customerBin || undefined,
      kind: lot.kind,
      status: lot.status,
      strength: match.strength,
      sharePct: Math.round(match.share * 100),
      matchedPhrases: match.matchedPhrases,
      winnerName: lot.winnerName,
      winnerBin: lot.winnerBin,
      winnerIsOurs: lot.winnerIsOurs,
      plannedSum: lot.plannedSumNoVat,
      annoUrl: lot.annoUrl,
      techspecUrl: lot.techspecUrl
    });
  }

  matchedLots.sort((a, b) => b.sharePct - a.sharePct || b.date.localeCompare(a.date));

  const winners: TemplateWinnerRow[] = [...winnerAgg.values()]
    .map((w) => ({
      ...w,
      wonSum: Math.round(w.wonSum),
      sharePct: decidedLots > 0 ? Math.round((w.wins / decidedLots) * 1000) / 10 : 0
    }))
    .sort((a, b) => b.wins - a.wins || b.wonSum - a.wonSum);

  return {
    templateId: template.id,
    templateName: template.name,
    note: template.note,
    totalLots: matchedLots.length,
    strongLots,
    partialLots,
    uniqueCustomers: customers.size,
    decidedLots,
    bidsTotal,
    bidsAdmitted,
    admittedRatePct: bidsTotal > 0 ? Math.round((bidsAdmitted / bidsTotal) * 1000) / 10 : null,
    winners,
    lots: matchedLots
  };
}
