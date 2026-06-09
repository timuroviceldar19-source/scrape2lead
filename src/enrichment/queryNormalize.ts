/**
 * Normalises raw user-supplied company names so they are friendlier both
 * to 2GIS search and to name-similarity scoring.
 *
 * Two real-world problems are addressed here:
 *
 * 1. Kaspi-sourced company names are often decorated with tags that 2GIS
 *    treats as spammy: "НДС", "Официальный дистрибьютор", "ИП Ашимова",
 *    "- KZ" and similar. 2GIS renders an empty-results page (and the
 *    adapter classifies it as throttled) for queries that contain these
 *    tokens. Stripping them up-front avoids the throttle.
 *
 * 2. The same names are scored with Levenshtein distance. "Akvilon.kz"
 *    and "Аквилон" produce 0.1 similarity because the TLD and the
 *    Latin/Cyrillic scripts each contribute edit operations. Stripping
 *    TLDs and legal-form tokens before tokenising brings the score back
 *    into a useful range and unblocks the channel-based decision.
 *
 * The function is intentionally conservative: it never invents
 * characters, never transliterates, never re-orders tokens, and never
 * re-orders the result. It just removes noise.
 */

const SUFFIX_TOKENS = new Set<string>([
  // Russian / Kazakh legal forms and marketing tags that 2GIS throttles
  "ндс", "ип", "тоо", "ооо", "оао", "зао", "пао", "ао", "ипшд", "ипшс",
  "официальный", "дистрибьютор", "дистрибьюторы", "дилер", "дилеры",
  "партнер", "представительство", "филиал",
  // English legal / corporate suffixes that 2GIS does not index under.
  // "shop" / "store" / "market" / "магазин" are intentionally KEPT here
  // because they are useful 2GIS category hints, not brand noise.
  "company", "co", "ltd", "llc", "inc", "limited", "group", "holdings",
  "corp", "corporation", "trading"
]);

// TLDs to drop when they appear as their own token. "Akvilon.kz" splits
// on the dot into ["akvilon", "kz"]; we drop "kz" so that similarity
// can match against the brand without the noise. "shop" is
// intentionally NOT here — it is a useful 2GIS category hint, not a TLD.
const TLD_TOKENS = new Set<string>([
  "kz", "ru", "com", "org", "net", "biz", "info", "io", "ua", "by"
]);

// Russian single-character / two-character prepositions and conjunctions.
// These never carry brand meaning and would otherwise survive the
// tokenisation step (e.g. "СтройМастер с НДС" → "строймастер с ндс",
// where "с" is noise and gets dropped).
const STOP_WORDS = new Set<string>([
  "с", "и", "в", "во", "на", "по", "о", "об", "от", "из", "для",
  "к", "ко", "за", "под", "над", "при", "без", "через", "the", "of", "and"
]);

// City names that frequently leak into a company name (Kaspi vendors
// often add the city to the product description). Stripping them keeps
// the name-similarity comparison from being penalised for the city
// mismatch between the original and the 2GIS-returned name.
const CITY_TOKENS = new Set<string>([
  "астана", "алматы", "павлодар", "актобе", "караганда", "шымкент",
  "актау", "атырау", "уральск", "костанай", "петропавловск", "тараз",
  "москва", "спб", "санктпетербург", "минск", "ташкент", "бишкек"
]);

/**
 * Normalises a free-form company name into a clean search string.
 *
 * Rules, in order:
 *   - lowercased
 *   - ё → е (so "Лёд" and "Лед" normalise identically)
 *   - parenthetical content removed ("220 VOLT (ИП Ашимова)" → "220 volt")
 *   - non-letter, non-digit, non-space chars replaced with a single
 *     space (so "Akvilon.kz" becomes "akvilon kz")
 *   - split on whitespace
 *   - empty tokens dropped
 *   - TLD tokens ("kz", "ru", "com", ...) dropped
 *   - legal-form / marketing tokens ("НДС", "ИП", "ТОО", "Официальный
 *     дистрибьютор", "Company", "LTD", ...) dropped
 *   - remaining tokens rejoined with single spaces
 *
 * The function never throws and always returns a string. An empty
 * input returns an empty string.
 */
export function normalizeQuery(input: string | null | undefined): string {
  if (!input) return "";
  let text = input.toLowerCase().replace(/ё/g, "е");

  // Drop parenthetical content first so the tokens inside the
  // parentheses (typically the legal form) are discarded without
  // having to split them.
  text = text.replace(/\s*\([^)]*\)/g, "");

  // Replace every non-letter, non-digit, non-space character with a
  // single space. Keeps Cyrillic + Latin letters (the \p{L} class) and
  // digits (\p{N}); turns dots, slashes, dashes, etc. into token
  // boundaries.
  text = text.replace(/[^\p{L}\p{N}\s]/gu, " ");

  const tokens = text.split(/\s+/).filter((t) => t.length > 0);

  const kept: string[] = [];
  for (const token of tokens) {
    if (SUFFIX_TOKENS.has(token)) continue;
    if (TLD_TOKENS.has(token)) continue;
    if (STOP_WORDS.has(token)) continue;
    if (CITY_TOKENS.has(token)) continue;
    kept.push(token);
  }
  return kept.join(" ").trim();
}

/**
 * Returns true when the normalised form is non-empty. Used by callers
 * that want to fall back to the original input rather than send an
 * empty query string to 2GIS.
 */
export function hasUsefulNormalizedForm(input: string | null | undefined): boolean {
  return normalizeQuery(input).length > 0;
}
