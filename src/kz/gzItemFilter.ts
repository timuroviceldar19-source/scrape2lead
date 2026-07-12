/**
 * Shared "junk" filter for GZ exports (plans and lots).
 *
 * `keywords` in the configs are a search allowlist ("what to look for"). This
 * module is the opposite: a stop-list that drops items whose name is not worth
 * importing (furniture, stationery, etc.).
 */

/** Default stop-list; overridden by the `excludeKeywords` config field. */
export const DEFAULT_GZ_EXCLUDE_KEYWORDS = [
  "Уголок",
  "Стойка",
  "Калькулятор",
  "Игра",
  "Плинтус",
  "Источник бесперебойного питания"
] as const;

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/**
 * True when the item name should be dropped because it matches an exclude
 * keyword. Matching is case-insensitive (ru locale). A single-word keyword
 * matches on a whole token — so "игра" does not hit "выиграл" and "стойка"
 * does not hit "рабочая станция". A keyword containing whitespace (a phrase,
 * e.g. "Источник бесперебойного питания") matches as a substring.
 */
export function isExcludedByName(name: string, excludeKeywords: readonly string[]): boolean {
  if (!name || excludeKeywords.length === 0) return false;

  const normalized = name.toLocaleLowerCase("ru");
  const tokens = new Set(normalized.split(WORD_SPLIT).filter(Boolean));

  for (const raw of excludeKeywords) {
    const keyword = raw.trim().toLocaleLowerCase("ru");
    if (!keyword) continue;
    if (/\s/.test(keyword)) {
      if (normalized.includes(keyword)) return true;
    } else if (tokens.has(keyword)) {
      return true;
    }
  }

  return false;
}
