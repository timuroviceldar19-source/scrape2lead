import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  removeLegalForm,
  transliterateToLatin,
  transliterateToCyrillic,
  levenshteinDistance,
  similarity,
  matchNames,
  generateNameVariants,
} from '../src/utils/nameNormalizer.js';

describe('Name Normalizer', () => {
  describe('removeLegalForm', () => {
    it('removes ТОО from name', () => {
      expect(removeLegalForm('ТОО "API-KZ"')).toBe('"API-KZ"');
    });

    it('removes full legal form', () => {
      expect(removeLegalForm('ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "API-KZ"')).toBe('"API-KZ"');
    });

    it('removes ИП', () => {
      expect(removeLegalForm('ИП Иванов')).toBe('Иванов');
    });

    it('handles case insensitive', () => {
      expect(removeLegalForm('тоо "Test"')).toBe('"Test"');
    });
  });

  describe('normalizeName', () => {
    it('removes legal form and quotes', () => {
      expect(normalizeName('ТОО "API-KZ"')).toBe('api-kz');
    });

    it('handles complex names', () => {
      expect(normalizeName('ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "Астана Моторс"')).toBe('астана моторс');
    });

    it('normalizes whitespace', () => {
      expect(normalizeName('Company   Name')).toBe('company name');
    });
  });

  describe('transliteration', () => {
    it('transliterates Cyrillic to Latin', () => {
      expect(transliterateToLatin('Астана')).toBe('astana');
      expect(transliterateToLatin('Москва')).toBe('moskva');
    });

    it('transliterates Latin to Cyrillic', () => {
      expect(transliterateToCyrillic('astana')).toBe('астана');
      expect(transliterateToCyrillic('moskva')).toBe('москва');
    });

    it('handles Kazakh characters', () => {
      expect(transliterateToLatin('Әліппе')).toBe('alippe');
      expect(transliterateToCyrillic('alippe')).toBe('алиппе');
    });
  });

  describe('levenshteinDistance', () => {
    it('calculates distance for identical strings', () => {
      expect(levenshteinDistance('test', 'test')).toBe(0);
    });

    it('calculates distance for different strings', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    });

    it('handles empty strings', () => {
      expect(levenshteinDistance('', 'test')).toBe(4);
      expect(levenshteinDistance('test', '')).toBe(4);
    });
  });

  describe('similarity', () => {
    it('returns 1 for identical strings', () => {
      expect(similarity('test', 'test')).toBe(1);
    });

    it('returns high similarity for similar strings', () => {
      expect(similarity('api-kz', 'api kz')).toBeGreaterThan(0.8);
    });

    it('returns low similarity for different strings', () => {
      expect(similarity('api', 'xyz')).toBeLessThan(0.5);
    });
  });

  describe('generateNameVariants', () => {
    it('generates multiple variants', () => {
      const variants = generateNameVariants('ТОО "API-KZ"');
      expect(variants.length).toBeGreaterThan(1);
      expect(variants).toContain('api-kz');
    });

    it('includes transliterated variants', () => {
      const variants = generateNameVariants('Астана Моторс');
      expect(variants.some((v: string) => v.includes('astana'))).toBe(true);
    });
  });

  describe('matchNames', () => {
    it('matches identical names', () => {
      const result = matchNames('ТОО "API-KZ"', 'ТОО "API-KZ"');
      expect(result.matched).toBe(true);
      expect(result.score).toBe(1);
    });

    it('matches names with different legal forms', () => {
      const result = matchNames('ТОО "API-KZ"', 'ИП API-KZ');
      expect(result.matched).toBe(true);
      expect(result.score).toBeGreaterThan(0.8);
    });

    it('matches transliterated names', () => {
      const result = matchNames('Астана Моторс', 'Astana Motors');
      expect(result.matched).toBe(true);
      expect(result.score).toBeGreaterThan(0.7);
    });

    it('does not match different companies', () => {
      const result = matchNames('ТОО "API-KZ"', 'ТОО "Другая Компания"');
      expect(result.matched).toBe(false);
      expect(result.score).toBeLessThan(0.5);
    });

    it('respects custom threshold', () => {
      const result = matchNames('API-KZ', 'API KZ', 0.8);
      expect(result.matched).toBe(true);
    });
  });
});
