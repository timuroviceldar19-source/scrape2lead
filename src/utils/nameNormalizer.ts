/**
 * Нормализация названий компаний для матчинга между источниками
 * (stat.gov.kz ↔ 2GIS ↔ Kaspi)
 */

// Организационно-правовые формы (Казахстан)
const LEGAL_FORMS = [
  'ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ',
  'ТОВАРИЩЕСТВО С ОГРАНИЧ. ОТВЕТСТВЕННОСТЬЮ',
  'ТОО',
  'АКЦИОНЕРНОЕ ОБЩЕСТВО',
  'АО',
  'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ',
  'ИП',
  'КРЕСТЬЯНСКОЕ ХОЗЯЙСТВО',
  'КХ',
  'LTD',
  'LIMITED',
  'LLC',
  'JSC',
  'INC',
  'CORP',
];

// Транслитерация кириллица → латиница (упрощённая)
const CYRILLIC_TO_LATIN: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'ә': 'a', 'і': 'i', 'ң': 'n', 'ғ': 'g', 'ү': 'u', 'ұ': 'u', 'қ': 'k', 'ө': 'o', 'һ': 'h',
};

const LATIN_TO_CYRILLIC_MAP: Record<string, string> = {
  'zh': 'ж', 'kh': 'х', 'ts': 'ц', 'ch': 'ч', 'sh': 'ш', 'shch': 'щ',
  'yo': 'ё', 'yu': 'ю', 'ya': 'я',
  'a': 'а', 'b': 'б', 'v': 'в', 'g': 'г', 'd': 'д', 'e': 'е',
  'z': 'з', 'i': 'и', 'y': 'й', 'k': 'к', 'l': 'л', 'm': 'м',
  'n': 'н', 'o': 'о', 'p': 'п', 'r': 'р', 's': 'с', 't': 'т',
  'u': 'у', 'f': 'ф',
};

/**
 * Транслитерация кириллицы в латиницу
 */
export function transliterateToLatin(text: string): string {
  return text
    .toLowerCase()
    .split('')
    .map(char => CYRILLIC_TO_LATIN[char] || char)
    .join('');
}

/**
 * Транслитерация латиницы в кириллицу
 */
export function transliterateToCyrillic(text: string): string {
  const lower = text.toLowerCase();
  let result = '';
  let i = 0;

  while (i < lower.length) {
    let matched = false;
    for (let len = 4; len >= 2; len--) {
      if (i + len <= lower.length) {
        const chunk = lower.slice(i, i + len);
        if (LATIN_TO_CYRILLIC_MAP[chunk]) {
          result += LATIN_TO_CYRILLIC_MAP[chunk];
          i += len;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      result += LATIN_TO_CYRILLIC_MAP[lower[i]] || lower[i];
      i++;
    }
  }

  return result;
}

/**
 * Удаление организационно-правовых форм из названия
 */
export function removeLegalForm(name: string): string {
  let result = name;

  for (const form of LEGAL_FORMS) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    result = result.replace(regex, '');
  }

  return result.trim();
}

/**
 * Очистка названия: удаление кавычек, спецсимволов, лишних пробелов
 */
export function cleanName(name: string): string {
  return name
    .replace(/[""'`«»]/g, '')
    .replace(/[^\wа-яёәіңғүұқөһ\s-]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Полная нормализация названия
 */
export function normalizeName(name: string): string {
  return cleanName(removeLegalForm(name)).toLowerCase();
}

/**
 * Расстояние Левенштейна (редакционное расстояние)
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // замена
          matrix[i][j - 1] + 1,     // вставка
          matrix[i - 1][j] + 1      // удаление
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Коэффициент сходства (0-1) на основе расстояния Левенштейна
 */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

/**
 * Генерация вариантов названия для поиска
 */
export function generateNameVariants(name: string): string[] {
  const normalized = normalizeName(name);
  const variants = new Set<string>();

  // Оригинальное нормализованное
  variants.add(normalized);

  // Транслитерация
  if (/[а-яәіңғүұқөһ]/i.test(name)) {
    variants.add(normalizeName(transliterateToLatin(name)));
  }
  if (/[a-z]/i.test(name)) {
    variants.add(normalizeName(transliterateToCyrillic(name)));
  }

  // Без пробелов
  variants.add(normalized.replace(/\s+/g, ''));

  // Только первое слово
  const firstWord = normalized.split(' ')[0];
  if (firstWord.length > 3) {
    variants.add(firstWord);
  }

  return Array.from(variants);
}

/**
 * Матчинг двух названий с учётом всех вариантов
 */
export function matchNames(name1: string, name2: string, threshold = 0.8): {
  matched: boolean;
  score: number;
  bestVariant: string;
} {
  const variants1 = generateNameVariants(name1);
  const variants2 = generateNameVariants(name2);

  let bestScore = 0;
  let bestVariant = '';

  for (const v1 of variants1) {
    for (const v2 of variants2) {
      const score = similarity(v1, v2);
      if (score > bestScore) {
        bestScore = score;
        bestVariant = `${v1} ↔ ${v2}`;
      }
    }
  }

  return {
    matched: bestScore >= threshold,
    score: bestScore,
    bestVariant,
  };
}
