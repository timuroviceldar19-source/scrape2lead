import { normalizeQuery } from "./queryNormalize.js";

const CITIES_TO_REMOVE = new Set(["астана", "алматы", "павлодар", "актобе", "караганда", "шымкент", "актау", "атырау", "уральск", "костанай", "петропавловск", "тараз"]);

const GENERIC_WORDS = new Set([
  "auto", "avto", "авто", "shop", "store", "market", "mart",
  "kz", "kazakhstan", "group", "company", "service", "trade",
  "parts", "center", "центр", "магазин"
]);

export function isGenericOrShort(normalizedName: string): boolean {
  if (normalizedName.length < 5) return true;
  const tokens = normalizedName.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return true;
  return tokens.every(t => GENERIC_WORDS.has(t));
}

export function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(word => word.length > 0 && !CITIES_TO_REMOVE.has(word))
    .join(" ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }
  return matrix[b.length][a.length];
}

export function calculateNameSimilarity(original: string, found: string): number {
  const normOrig = normalizeQuery(original);
  const normFound = normalizeQuery(found);
  if (!normOrig || !normFound) return 0;

  const [a, b] = normOrig.length <= normFound.length ? [normOrig, normFound] : [normFound, normOrig];
  const distance = levenshtein(a, b);
  const maxLength = b.length;
  if (maxLength === 0) return 1;

  return 1 - distance / maxLength;
}

export interface EnrichmentScore {
  name_similarity: number;
  city_match: number;
  category_match: number;
  signal_score: number;
  total: number;
  confidence_level: "high" | "medium" | "low";
}

export function calculateConfidenceScore(
  originalName: string,
  foundName: string,
  originalCity: string,
  foundCity: string,
  originalCategory: string,
  foundCategory: string,
  hasValidPhone: boolean,
  hasValidAddress: boolean,
  hasValidWebsite: boolean,
  websiteUrl?: string | null
): EnrichmentScore {
  let nameSim = calculateNameSimilarity(originalName, foundName);

  const normOrig = normalizeQuery(originalName);
  const normFound = normalizeQuery(foundName);

  const normOrigCat = normalizeText(originalCategory);
  const normFoundCat = normalizeText(foundCategory);
  const categoryMatch = (normOrigCat && normFoundCat && (normFoundCat.includes(normOrigCat) || normOrigCat.includes(normFoundCat))) ? 1.0 : 0.0;

  let domainMatch = false;
  if (websiteUrl && normOrig) {
    try {
      const domain = new URL(websiteUrl).hostname.replace(/^www\./, "").split(".")[0];
      domainMatch = domain.includes(normOrig);
    } catch {}
  }

  const hasAdditionalSignal = domainMatch || categoryMatch > 0 || hasValidPhone || hasValidAddress;

  if (nameSim < 0.5 && domainMatch && normOrig && !isGenericOrShort(normOrig)) {
    nameSim = Math.max(nameSim, 0.9);
  }

  if (nameSim < 0.5 && normOrig && normFound) {
    const [a, b] = normOrig.length <= normFound.length ? [normOrig, normFound] : [normFound, normOrig];
    const isSubstringMatch = b.includes(a) || a.includes(b);
    if (isSubstringMatch && !isGenericOrShort(a) && hasAdditionalSignal) {
      nameSim = Math.max(nameSim, 0.8);
    }
  }

  const normOrigCity = originalCity.toLowerCase().trim();
  const normFoundCity = foundCity.toLowerCase().trim();
  const cityMatch = (normOrigCity && normFoundCity && normOrigCity === normFoundCity) ? 1.0 : 0.0;

  const hasValidSignal = hasValidPhone || hasValidWebsite;
  const signalScore = hasValidSignal ? 1.0 : 0.0;

  const total = (nameSim * 0.55) + (cityMatch * 0.20) + (categoryMatch * 0.15) + (signalScore * 0.10);

  let confidence_level: "high" | "medium" | "low" = "low";
  if (total >= 0.85) confidence_level = "high";
  else if (total >= 0.65) confidence_level = "medium";

  return { name_similarity: nameSim, city_match: cityMatch, category_match: categoryMatch, signal_score: signalScore, total, confidence_level };
}

/**
 * Status of a single validated contact channel after enrichment.
 * Mirrors the "valid" | "invalid" | "empty" string union from
 * {@link ValidationResult}.
 */
export type ChannelStatus = "valid" | "invalid" | "empty" | "unknown";

export interface ChannelBoostInput {
  phone: ChannelStatus;
  address: ChannelStatus;
  website: ChannelStatus;
}

export interface ChannelBoostResult {
  level: "high" | "medium" | "low";
  validChannelCount: number;
  applied: boolean;
}

/**
 * Applies the channel-based confidence boost to a base confidence level.
 *
 * Problem: with Kaspi-sourced leads the original company name is often
 * a brand shorthand ("Akvilon.kz", "ASTANA-KREP", "12 Месяцев") that
 * 2GIS returns transliterated or in Cyrillic ("Аквилон", "Астана КРЕП",
 * "12 Месяцев"). Levenshtein similarity between scripts is ~0, so the
 * pure-text score stays "low" even when 2GIS has returned a real firm
 * with a valid phone, address, and website.
 *
 * Solution: when 2+ of the 3 contact channels (phone/address/website)
 * are independently validated, promote the confidence level from "low"
 * to "medium". This is the minimum evidence the lead is a real,
 * contactable business. The downstream decision routes "medium" to
 * "Needs manual review" so a human still verifies the name before
 * the lead is marked as "Ready to contact".
 *
 * "high" is never downgraded: a strong name match is still the
 * strongest signal we have. The boost is one-way: low → medium only.
 */
export function applyChannelBoost(
  baseLevel: "high" | "medium" | "low",
  channels: ChannelBoostInput
): ChannelBoostResult {
  const validChannelCount = [
    channels.phone === "valid",
    channels.address === "valid",
    channels.website === "valid"
  ].filter(Boolean).length;

  if (baseLevel === "low" && validChannelCount >= 2) {
    return { level: "medium", validChannelCount, applied: true };
  }
  return { level: baseLevel, validChannelCount, applied: false };
}
