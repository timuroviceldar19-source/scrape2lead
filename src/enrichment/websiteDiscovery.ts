import type { Lead, WebsiteDiscoveryPolicy } from "../types.js";
import { normalizeUrl } from "../normalizer/normalize.js";

export interface WebsiteDiscoveryTelemetry {
  attempted: boolean;
  succeeded: boolean;
  websiteFound: boolean;
  searchRequests: number;
  candidatesValidated: number;
  candidatesRejected: number;
  timeouts: number;
}

export interface WebsiteDiscoveryResult {
  lead: Lead;
  telemetry: WebsiteDiscoveryTelemetry;
}

export interface SearchCandidate {
  url: string;
  text: string;
}

const DEFAULT_MAX_SEARCHES = 2;
const DEFAULT_MAX_CANDIDATES = 4;
const DEFAULT_TIMEOUT_MS = 5_000;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;
const LINK_TEXT_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const SCRIPT_STYLE_RE = /<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi;
const STRIP_TAGS_RE = /<[^>]+>/g;

export async function discoverLeadWebsite(
  lead: Lead,
  options?: WebsiteDiscoveryPolicy
): Promise<WebsiteDiscoveryResult> {
  const telemetry: WebsiteDiscoveryTelemetry = {
    attempted: false,
    succeeded: false,
    websiteFound: false,
    searchRequests: 0,
    candidatesValidated: 0,
    candidatesRejected: 0,
    timeouts: 0
  };

  if (!options || options.enabled === false || lead.website || lead.email) {
    return { lead, telemetry };
  }

  telemetry.attempted = true;
  const timeoutMs = clampPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxSearches = clampPositiveInt(options.maxSearches, DEFAULT_MAX_SEARCHES);
  const maxCandidates = clampPositiveInt(options.maxCandidates, DEFAULT_MAX_CANDIDATES);
  const candidates = new Map<string, SearchCandidate>();

  for (const searchUrl of buildSearchUrls(lead).slice(0, maxSearches)) {
    telemetry.searchRequests += 1;
    const fetched = await fetchText(searchUrl, timeoutMs);
    if (fetched.timedOut) telemetry.timeouts += 1;
    if (!fetched.text) continue;
    telemetry.succeeded = true;

    for (const candidate of extractSearchCandidates(fetched.text)) {
      const normalized = normalizeCandidateUrl(candidate.url);
      if (!normalized || isBlockedHost(new URL(normalized).hostname)) {
        telemetry.candidatesRejected += 1;
        continue;
      }
      if (!candidates.has(normalized)) {
        candidates.set(normalized, { ...candidate, url: normalized });
      }
      if (candidates.size >= maxCandidates) break;
    }
    if (candidates.size >= maxCandidates) break;
  }

  for (const candidate of candidates.values()) {
    telemetry.candidatesValidated += 1;
    const validation = await validateCandidate(candidate, lead, timeoutMs);
    if (validation.timedOut) telemetry.timeouts += 1;
    if (!validation.website) {
      telemetry.candidatesRejected += 1;
      continue;
    }
    return {
      lead: { ...lead, website: validation.website },
      telemetry: { ...telemetry, websiteFound: true }
    };
  }

  return { lead, telemetry };
}

function buildSearchUrls(lead: Lead): string[] {
  const queryParts = [
    compact([lead.company_name, lead.city, lead.address]),
    compact([lead.company_name, lead.city, lead.category, lead.phones[0]])
  ].filter(Boolean);
  const urls: string[] = [];
  for (const query of queryParts) {
    urls.push(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    urls.push(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`);
  }
  return urls;
}

export function extractSearchCandidates(html: string): SearchCandidate[] {
  const decoded = decodeHtmlEntities(html);
  const candidates: SearchCandidate[] = [];

  for (const match of decoded.matchAll(LINK_TEXT_RE)) {
    candidates.push({
      url: unwrapSearchRedirect(match[1]),
      text: textFromHtml(match[2])
    });
  }

  if (candidates.length > 0) return candidates;
  return [...decoded.matchAll(HREF_RE)].map((match) => ({ url: unwrapSearchRedirect(match[1]), text: "" }));
}

async function validateCandidate(
  candidate: SearchCandidate,
  lead: Lead,
  timeoutMs: number
): Promise<{ website: string | null; timedOut: boolean }> {
  const website = normalizeCandidateUrl(candidate.url);
  if (!website) return { website: null, timedOut: false };

  const fetched = await fetchText(website, timeoutMs);
  if (!fetched.text) return { website: null, timedOut: fetched.timedOut };

  const pageText = textFromHtml(fetched.text);
  const score = scoreCandidate(website, candidate.text, pageText, lead);
  return { website: score >= 5 ? website : null, timedOut: fetched.timedOut };
}

function scoreCandidate(url: string, searchText: string, pageText: string, lead: Lead): number {
  const pageHaystack = normalizeText(pageText);
  const searchHaystack = normalizeText(searchText);
  const nameTokens = businessTokens(lead.company_name);
  const matchedNameTokens = nameTokens.filter((token) => pageHaystack.includes(token));
  const nameCoverage = nameTokens.length > 0 ? matchedNameTokens.length / nameTokens.length : 0;
  const addressTokens = businessTokens(lead.address);
  const matchedAddressTokens = addressTokens.filter((token) => pageHaystack.includes(token));
  const phoneDigits = lead.phones.map(lastPhoneDigits).filter(Boolean);
  const hasPhoneSignal = phoneDigits.some((digits) => digits && digitsOnly(pageText).includes(digits));
  const hasAddressSignal = addressTokens.length > 0 && matchedAddressTokens.length >= Math.min(2, addressTokens.length);
  const hasCitySignal = Boolean(lead.city && pageHaystack.includes(normalizeText(lead.city)));

  if (!hasPhoneSignal && !hasAddressSignal && !hasCitySignal) return 0;

  let score = 0;
  if (nameCoverage >= 0.7) score += 4;
  else if (nameCoverage >= 0.45) score += 2;
  if (pageHaystack.includes(normalizeText(lead.company_name))) score += 3;
  if (searchHaystack.includes(normalizeText(lead.company_name))) score += 1;
  if (businessTokens(new URL(url).hostname).some((token) => nameTokens.includes(token))) score += 2;
  if (hasPhoneSignal) score += 5;
  if (hasAddressSignal) score += 3;
  if (hasCitySignal) score += 1;
  return score;
}

export async function fetchText(url: string, timeoutMs: number): Promise<{ text: string | null; timedOut: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml,text/plain",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
      }
    });
    if (!response.ok) return { text: null, timedOut: false };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/html|text\/plain/i.test(contentType)) return { text: null, timedOut: false };
    return { text: await response.text(), timedOut: false };
  } catch (error) {
    return { text: null, timedOut: isAbortError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeCandidateUrl(value: string): string | null {
  const unwrapped = unwrapSearchRedirect(value);
  const normalized = normalizeUrl(unwrapped);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (!/\./.test(parsed.hostname)) return null;
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}

export function unwrapSearchRedirect(value: string): string {
  const decoded = decodeHtmlEntities(value.trim());
  try {
    const parsed = new URL(decoded, "https://search.local");
    const direct = parsed.searchParams.get("u") ?? parsed.searchParams.get("uddg") ?? parsed.searchParams.get("url");
    if (direct) return decodeSearchUrlParam(direct);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    return decoded;
  }
  return decoded;
}

function decodeSearchUrlParam(value: string): string {
  const decoded = decodeURIComponentSafe(value);
  if (!decoded.startsWith("a1") || decoded.length < 4) return decoded;
  const payload = decoded.slice(2);
  const padding = "=".repeat((4 - payload.length % 4) % 4);
  try {
    const out = Buffer.from(`${payload}${padding}`.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return out || decoded;
  } catch {
    return decoded;
  }
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const BLOCKED_HOST_SUFFIXES = [
  "2gis.ru",
  "2gis.kz",
  "dgis.ru",
  "dgis.kz",
  "yandex.ru",
  "ya.ru",
  "google.com",
  "bing.com",
  "search.local",
  "duckduckgo.com",
  "vk.com",
  "ok.ru",
  "facebook.com",
  "instagram.com",
  "t.me",
  "telegram.me",
  "whatsapp.com",
  "wa.me",
  "avito.ru",
  "zoon.ru",
  "flamp.ru",
  "orgpage.ru",
  "yell.ru",
  "spravker.ru",
  "asktel.ru",
  "spravkus.com",
  "spravka7.ru",
  "firmika.ru",
  "otzovik.com",
  "list-org.com",
  "rusprofile.ru",
  "sbis.ru",
  "wikipedia.org",
  "youtube.com",
  "youtu.be",
  "flashscore.com",
  "sofascore.com",
  "eliteprospects.com",
  "drom.ru",
  "drive2.ru"
];

export function textFromHtml(html: string): string {
  return decodeHtmlEntities(html.replace(SCRIPT_STYLE_RE, " ").replace(STRIP_TAGS_RE, " ")).replace(/\s+/g, " ").trim();
}

export function businessTokens(value: string): string[] {
  const stopWords = new Set([
    "www",
    "http",
    "https",
    "\u043e\u043e\u043e",
    "\u0438\u043f",
    "\u0430\u043e",
    "\u0437\u0430\u043e",
    "\u043e\u0430\u043e"
  ]);
  return [...new Set(normalizeText(value).split(/\s+/).filter((token) => token.length >= 3 && !stopWords.has(token)))];
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export function lastPhoneDigits(value: string): string {
  const digits = digitsOnly(value);
  return digits.length >= 7 ? digits.slice(-7) : "";
}

export function compact(values: Array<string | null | undefined>): string {
  return values.map((value) => value?.trim()).filter(Boolean).join(" ");
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function clampPositiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
