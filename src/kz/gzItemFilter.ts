/** Shared junk filtering for GZ plan and lot exports. */

export const DEFAULT_GZ_EXCLUDE_KEYWORDS = [
  "Уголок", "Стойка", "Калькулятор", "Игра", "Плинтус",
  "Источник бесперебойного питания"
] as const;

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const RUSSIAN_SUFFIXES = [
  "иями", "ями", "ами", "ого", "ему", "ому", "ими", "ыми",
  "ий", "ый", "ой", "ая", "яя", "ое", "ее", "ые", "ие", "ых", "их", "ую", "юю",
  "ов", "ев", "ам", "ям", "ах", "ях", "ом", "ем", "а", "я", "ы", "и", "е", "о", "у", "ю"
] as const;

export interface GzItemFilterOptions<T> {
  minAmount: number;
  excludeKeywords: readonly string[];
  getAmount: (item: T) => number;
  getName: (item: T) => string;
}

export interface GzItemFilterResult<T> {
  items: T[];
  droppedBelowMinAmount: number;
  droppedByName: number;
}

/** Filters arbitrary GZ rows and reports mutually exclusive drop reasons. */
export function filterGzItems<T>(items: readonly T[], options: GzItemFilterOptions<T>): GzItemFilterResult<T> {
  const kept: T[] = [];
  let droppedBelowMinAmount = 0;
  let droppedByName = 0;

  for (const item of items) {
    if (options.minAmount > 0 && options.getAmount(item) < options.minAmount) {
      droppedBelowMinAmount++;
      continue;
    }
    if (isExcludedByName(options.getName(item), options.excludeKeywords)) {
      droppedByName++;
      continue;
    }
    kept.push(item);
  }

  return { items: kept, droppedBelowMinAmount, droppedByName };
}

/** Matches normalized whole words and adjacent phrase words with conservative Russian stemming. */
export function isExcludedByName(name: string, excludeKeywords: readonly string[]): boolean {
  if (!name || excludeKeywords.length === 0) return false;
  const nameTokens = tokenize(name);
  if (nameTokens.length === 0) return false;

  return excludeKeywords.some((rawKeyword) => {
    const keywordTokens = tokenize(rawKeyword);
    if (keywordTokens.length === 0 || keywordTokens.length > nameTokens.length) return false;
    for (let start = 0; start <= nameTokens.length - keywordTokens.length; start++) {
      if (keywordTokens.every((keyword, offset) => wordsMatch(nameTokens[start + offset], keyword))) return true;
    }
    return false;
  });
}

function tokenize(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").split(WORD_SPLIT).filter(Boolean);
}

function wordsMatch(candidate: string, keyword: string): boolean {
  if (candidate === keyword) return true;
  const keywordStem = russianStem(keyword);
  return keywordStem.length >= 3 && russianStem(candidate).startsWith(keywordStem);
}

function russianStem(word: string): string {
  for (const suffix of RUSSIAN_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}
