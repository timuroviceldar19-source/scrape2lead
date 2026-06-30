import type { Lead } from "../types.js";
import { normalizeEmail, normalizeUrl } from "../normalizer/normalize.js";

export interface WebsiteCrawlOptions {
  enabled?: boolean;
  maxPages?: number;
  timeoutMs?: number;
}

export interface WebsiteCrawlTelemetry {
  attempted: boolean;
  succeeded: boolean;
  emailFound: boolean;
  messengersFound: number;
  timeouts: number;
  pagesVisited: number;
}

export interface WebsiteCrawlResult {
  lead: Lead;
  telemetry: WebsiteCrawlTelemetry;
}

const DEFAULT_MAX_PAGES = 3;
const DEFAULT_TIMEOUT_MS = 5_000;

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;
const LINK_TEXT_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const STRIP_TAGS_RE = /<[^>]+>/g;

export async function enrichLeadFromWebsite(
  lead: Lead,
  options: WebsiteCrawlOptions = {}
): Promise<WebsiteCrawlResult> {
  const telemetry: WebsiteCrawlTelemetry = {
    attempted: false,
    succeeded: false,
    emailFound: false,
    messengersFound: 0,
    timeouts: 0,
    pagesVisited: 0
  };

  if (options.enabled === false || lead.email || !lead.website) {
    return { lead, telemetry };
  }

  const website = normalizeUrl(lead.website);
  if (!website) return { lead, telemetry };
  telemetry.attempted = true;

  const maxPages = clampPositiveInt(options.maxPages, DEFAULT_MAX_PAGES);
  const timeoutMs = clampPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pageUrls = buildCandidateUrls(website).slice(0, maxPages);
  const emails = new Set<string>();
  const messengers = new Set<string>(lead.messenger_links);

  for (const url of pageUrls) {
    const fetched = await fetchHtml(url, timeoutMs);
    if (fetched.timedOut) telemetry.timeouts += 1;
    if (!fetched.html) continue;
    telemetry.pagesVisited += 1;
    telemetry.succeeded = true;

    for (const email of extractEmails(fetched.html)) emails.add(email);
    for (const messenger of extractMessengerLabels(fetched.html)) messengers.add(messenger);

    if (emails.size > 0) break;
  }

  const email = normalizeEmail([...emails][0]) ?? lead.email;
  const messengerLinks = [...messengers];

  return {
    lead: {
      ...lead,
      email,
      messenger_links: messengerLinks
    },
    telemetry: {
      ...telemetry,
      emailFound: !lead.email && Boolean(email),
      messengersFound: Math.max(0, messengerLinks.length - lead.messenger_links.length)
    }
  };
}

function buildCandidateUrls(website: string): string[] {
  const base = new URL(website);
  const paths = [
    "/",
    "/contacts",
    "/contact",
    "/kontakty",
    "/kontakty.html",
    "/about",
    "/company"
  ];
  const urls = new Set<string>();
  for (const path of paths) {
    const url = new URL(path, base);
    url.hash = "";
    urls.add(url.toString());
  }
  return [...urls];
}

async function fetchHtml(url: string, timeoutMs: number): Promise<{ html: string | null; timedOut: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
      }
    });
    if (!response.ok) return { html: null, timedOut: false };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/html|text\/plain/i.test(contentType)) return { html: null, timedOut: false };
    return { html: await response.text(), timedOut: false };
  } catch (error) {
    return { html: null, timedOut: isAbortError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function extractEmails(html: string): string[] {
  const decoded = decodeHtmlEntities(html);
  const fromMailto = [...decoded.matchAll(/mailto:([^"'?<#\s]+)/gi)]
    .map((match) => normalizeEmail(decodeURIComponentSafe(match[1])))
    .filter((email): email is string => Boolean(email));
  const fromText = [...decoded.matchAll(EMAIL_RE)]
    .map((match) => normalizeEmail(match[0]))
    .filter((email): email is string => Boolean(email));
  return [...new Set([...fromMailto, ...fromText])];
}

function extractMessengerLabels(html: string): string[] {
  const labels = new Set<string>();
  const decoded = decodeHtmlEntities(html);

  for (const match of decoded.matchAll(HREF_RE)) {
    const href = match[1].toLowerCase();
    addMessengerFromText(labels, href);
  }

  for (const match of decoded.matchAll(LINK_TEXT_RE)) {
    addMessengerFromText(labels, `${match[1]} ${match[2].replace(STRIP_TAGS_RE, " ")}`);
  }

  return [...labels];
}

function addMessengerFromText(out: Set<string>, value: string): void {
  if (/wa\.me|whatsapp|api\.whatsapp\.com/i.test(value)) out.add("WhatsApp");
  if (/t\.me|telegram/i.test(value)) out.add("Telegram");
  if (/viber/i.test(value)) out.add("Viber");
  if (/(^|[^a-z])max([^a-z]|$)/i.test(value)) out.add("Max");
}

function decodeHtmlEntities(value: string): string {
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

function clampPositiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
