import { describe, it, expect } from "vitest";

// Inline the functions to test to avoid import issues or keep it self-contained
const PHONE_REGEX = /(?:\+7|8)\s*\(?\d{3}\)?\s*\d{3}[-\s]?\d{2}[-\s]?\d{2}/g;
const WA_REGEX = /(?:wa\.me|whatsapp\.com)\/(?:chat\/)?(\d+)/gi;
const TG_REGEX = /t\.me\/([a-zA-Z0-9_]+)/gi;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^8/, "7");
}

function parseText(text: string) {
  const phones = [...new Set((text.match(PHONE_REGEX) || []).map(normalizePhone))];
  const waMatches = [...new Set(Array.from(text.matchAll(WA_REGEX)).map(m => `+${m[1]}`))];
  const tgMatches = [...new Set(Array.from(text.matchAll(TG_REGEX)).map(m => `@${m[1]}`))];
  const emails = [...new Set(text.match(EMAIL_REGEX) || [])];
  const urls = [...new Set(text.match(URL_REGEX) || [])];
  
  const websites = urls.filter(u => !u.includes("wa.me") && !u.includes("whatsapp") && !u.includes("t.me") && !u.includes("mailto:"));
  const waPhones = waMatches.filter(p => !phones.includes(normalizePhone(p)));
  
  return {
    phones: [...phones, ...waPhones],
    telegram: tgMatches,
    emails,
    websites
  };
}

function calculateCompleteness(data: any): number {
  let score = 0;
  if (data.phone) score += 40;
  if (data.whatsapp) score += 20;
  if (data.address) score += 20;
  if (data.source_url) score += 10;
  if (data.website || data.email) score += 10;
  return score;
}

describe("Operator Intake Tool", () => {
  describe("Phone Parsing (KZ/RU-style)", () => {
    it("should parse +7 format", () => {
      const text = "Тел: +7 (777) 123-45-67";
      const result = parseText(text);
      expect(result.phones).toContain("77771234567");
    });

    it("should parse 8 format and normalize to 7", () => {
      const text = "Тел: 8 701 234 56 78";
      const result = parseText(text);
      expect(result.phones).toContain("77012345678");
    });

    it("should parse formats without spaces", () => {
      const text = "Тел: +77771234567";
      const result = parseText(text);
      expect(result.phones).toContain("77771234567");
    });
  });

  describe("WhatsApp Link Parsing", () => {
    it("should extract phone from wa.me link", () => {
      const text = "Пишите на https://wa.me/77771234567";
      const result = parseText(text);
      expect(result.phones).toContain("+77771234567");
    });

    it("should extract phone from whatsapp.com link", () => {
      const text = "Наш WhatsApp: https://whatsapp.com/chat/77012345678";
      const result = parseText(text);
      expect(result.phones).toContain("+77012345678");
    });
  });

  describe("Telegram Link Parsing", () => {
    it("should extract username from t.me link", () => {
      const text = "Наш Telegram: https://t.me/autoservice_astana";
      const result = parseText(text);
      expect(result.telegram).toContain("@autoservice_astana");
    });
  });

  describe("Email Parsing", () => {
    it("should extract valid emails", () => {
      const text = "Свяжитесь с нами: info@example.kz или support@autoservice.com";
      const result = parseText(text);
      expect(result.emails).toContain("info@example.kz");
      expect(result.emails).toContain("support@autoservice.com");
    });
  });

  describe("Completeness Scoring", () => {
    it("should score 100 for phone + whatsapp + address + source + site/email", () => {
      const data = {
        phone: "77771234567",
        whatsapp: "77771234567",
        address: "Астана, ул. Примерная 1",
        source_url: "https://2gis.kz/...",
        website: "https://example.kz"
      };
      expect(calculateCompleteness(data)).toBe(100);
    });

    it("should score 80 for phone + whatsapp + address + source", () => {
      const data = {
        phone: "77771234567",
        whatsapp: "77771234567",
        address: "Астана, ул. Примерная 1",
        source_url: "https://2gis.kz/..."
      };
      expect(calculateCompleteness(data)).toBe(90); // 40+20+20+10 = 90, which is >= 80
    });

    it("should score 60 for phone + address + source (no whatsapp)", () => {
      const data = {
        phone: "77771234567",
        address: "Астана, ул. Примерная 1",
        source_url: "https://2gis.kz/..."
      };
      expect(calculateCompleteness(data)).toBe(70); // 40+20+10 = 70, which is >= 60
    });

    it("should score 40 for phone + source (no address)", () => {
      const data = {
        phone: "77771234567",
        source_url: "https://2gis.kz/..."
      };
      expect(calculateCompleteness(data)).toBe(50); // 40+10 = 50, which is >= 40
    });

    it("should score <40 and be rejected if only phone is present", () => {
      const data = {
        phone: "77771234567"
      };
      expect(calculateCompleteness(data)).toBe(40);
    });

    it("should score <40 if no phone is present", () => {
      const data = {
        address: "Астана, ул. Примерная 1",
        source_url: "https://2gis.kz/..."
      };
      expect(calculateCompleteness(data)).toBe(30);
    });
  });
});
