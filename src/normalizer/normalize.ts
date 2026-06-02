import type { Lead } from "../types.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 10) {
    return `+7${digits}`;
  }
  return null;
}

export function normalizePhones(phones: string[]): string[] {
  return [...new Set(phones.map(normalizePhone).filter((phone): phone is string => Boolean(phone)))];
}

export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const value = email.trim().toLowerCase();
  return EMAIL_RE.test(value) ? value : null;
}

export function normalizeUrl(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function finalizeLead(lead: Lead): Lead {
  const phones = normalizePhones(lead.phones);
  const email = normalizeEmail(lead.email);
  const website = normalizeUrl(lead.website);
  return {
    ...lead,
    company_name: lead.company_name.trim(),
    category: lead.category.trim(),
    city: lead.city.trim(),
    address: lead.address.trim(),
    phones,
    email,
    website,
    social_links: uniqueUrls(lead.social_links),
    messenger_links: uniqueUrls(lead.messenger_links),
    incomplete: lead.incomplete || phones.length === 0
  };
}

function uniqueUrls(values: string[]): string[] {
  return [...new Set(values.map(normalizeUrl).filter((value): value is string => Boolean(value)))];
}
