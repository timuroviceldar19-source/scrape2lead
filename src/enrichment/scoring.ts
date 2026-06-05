const CITIES_TO_REMOVE = new Set(["астана", "алматы", "павлодар", "актобе", "караганда", "шымкент", "актау", "атырау", "уральск", "костанай", "петропавловск", "тараз"]);

export function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, "") // Убираем кавычки, скобки, пунктуацию
    .split(/\s+/)                     // Разбиваем на слова
    .filter(word => word.length > 0 && !CITIES_TO_REMOVE.has(word)) // Убираем города
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
  const normOrig = normalizeText(original);
  const normFound = normalizeText(found);
  if (!normOrig || !normFound) return 0;

  const distance = levenshtein(normOrig, normFound);
  const maxLength = Math.max(normOrig.length, normFound.length);
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
  hasValidPhoneOrWebsite: boolean
): EnrichmentScore {
  const nameSim = calculateNameSimilarity(originalName, foundName);

  // Для городов мы просто сравниваем их без учета регистра, не удаляя название города
  const normOrigCity = originalCity.toLowerCase().trim();
  const normFoundCity = foundCity.toLowerCase().trim();
  const cityMatch = (normOrigCity && normFoundCity && normOrigCity === normFoundCity) ? 1.0 : 0.0;

  const normOrigCat = normalizeText(originalCategory);
  const normFoundCat = normalizeText(foundCategory);
  const categoryMatch = (normOrigCat && normFoundCat && (normFoundCat.includes(normOrigCat) || normOrigCat.includes(normFoundCat))) ? 1.0 : 0.0;

  const signalScore = hasValidPhoneOrWebsite ? 1.0 : 0.0;

  const total = (nameSim * 0.55) + (cityMatch * 0.20) + (categoryMatch * 0.15) + (signalScore * 0.10);

  let confidence_level: "high" | "medium" | "low" = "low";
  if (total >= 0.85) confidence_level = "high";
  else if (total >= 0.65) confidence_level = "medium";

  return { name_similarity: nameSim, city_match: cityMatch, category_match: categoryMatch, signal_score: signalScore, total, confidence_level };
}
