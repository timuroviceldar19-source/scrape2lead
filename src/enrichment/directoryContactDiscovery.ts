import type { Lead, DirectoryContactDiscoveryPolicy } from "../types.js";
import { normalizeEmail } from "../normalizer/normalize.js";
import {
  fetchText,
  textFromHtml,
  normalizeText,
  businessTokens,
  digitsOnly,
  lastPhoneDigits,
  compact,
  clampPositiveInt,
  extractSearchCandidates,
  normalizeCandidateUrl
} from "./websiteDiscovery.js";

export interface DirectoryDiscoveryTelemetry {
  attempted: boolean;
  succeeded: boolean;
  emailFound: boolean;
  messengersFound: number;
  searchRequests: number;
  candidatesVisited: number;
  candidatesRejected: number;
  timeouts: number;
}

export interface DirectoryDiscoveryResult {
  lead: Lead;
  telemetry: DirectoryDiscoveryTelemetry;
}

const DEFAULT_MAX_SEARCHES = 2;
const DEFAULT_MAX_CANDIDATES = 4;
const DEFAULT_TIMEOUT_MS = 5_000;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;
const LINK_TEXT_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const STRIP_TAGS_RE = /<[^>]+>/g;

const DEFAULT_ALLOWLIST = [
  "zoon.ru",
  "yell.ru",
  "orgpage.ru",
  "spravker.ru",
  "asktel.ru",
  "spravkus.com",
  "spravka7.ru",
  "firmika.ru",
  "flamp.ru"
];

export async function discoverDirectoryContacts(
  lead: Lead,
  options?: DirectoryContactDiscoveryPolicy
): Promise<DirectoryDiscoveryResult> {
  const telemetry: DirectoryDiscoveryTelemetry = {
    attempted: false,
    succeeded: false,
    emailFound: false,
    messengersFound: 0,
    searchRequests: 0,
    candidatesVisited: 0,
    candidatesRejected: 0,
    timeouts: 0
  };

  if (!options || options.enabled === false || lead.email) {
    return { lead, telemetry };
  }

  // Identity check: need name + (phone OR (city + address))
  const hasPhone = lead.phones.length > 0;
  const hasAddress = Boolean(lead.city && lead.address);
  if (!lead.company_name || (!hasPhone && !hasAddress)) {
    return { lead, telemetry };
  }

  telemetry.attempted = true;
  const timeoutMs = clampPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxSearches = clampPositiveInt(options.maxSearches, DEFAULT_MAX_SEARCHES);
  const maxCandidates = clampPositiveInt(options.maxCandidates, DEFAULT_MAX_CANDIDATES);
  const allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;

  const candidates = new Map<string, string>(); // url -> searchText

  for (const searchUrl of buildSearchUrls(lead).slice(0, maxSearches)) {
    telemetry.searchRequests += 1;
    const fetched = await fetchText(searchUrl, timeoutMs);
    if (fetched.timedOut) telemetry.timeouts += 1;
    if (!fetched.text) continue;

    for (const candidate of extractSearchCandidates(fetched.text)) {
      const normalized = normalizeCandidateUrl(candidate.url);
      if (!normalized || !isAllowlisted(normalized, allowlist)) {
        continue;
      }
      if (!candidates.has(normalized)) {
        candidates.set(normalized, candidate.text);
      }
      if (candidates.size >= maxCandidates) break;
    }
    if (candidates.size >= maxCandidates) break;
  }

  if (candidates.size > 0) telemetry.succeeded = true;

  const emails = new Set<string>();
  const messengers = new Set<string>(lead.messenger_links);

  for (const [url, searchText] of candidates) {
    telemetry.candidatesVisited += 1;
    const fetched = await fetchText(url, timeoutMs);
    if (fetched.timedOut) telemetry.timeouts += 1;
    if (!fetched.text) {
      telemetry.candidatesRejected += 1;
      continue;
    }

    const pageText = textFromHtml(fetched.text);
    if (!validatePage(url, searchText, pageText, lead)) {
      telemetry.candidatesRejected += 1;
      continue;
    }

    // Extraction
    for (const email of extractEmails(fetched.text, url)) emails.add(email);
    for (const messenger of extractMessengerLabels(fetched.text)) messengers.add(messenger);

    // If we found something, we can stop or continue. Let's continue for now to get more messengers.
    // But if we found an email, that's often enough for one lead.
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

function buildSearchUrls(lead: Lead): string[] {
  const queryParts = [
    compact([lead.company_name, lead.city, lead.address]),
    compact([lead.company_name, lead.city, lead.phones[0]])
  ].filter(Boolean);
  const urls: string[] = [];
  for (const query of queryParts) {
    // Add "отзывы" or "телефон" to nudge towards directory results
    const directoryQuery = `${query} отзывы контакты`;
    urls.push(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(directoryQuery)}`);
    urls.push(`https://www.bing.com/search?q=${encodeURIComponent(directoryQuery)}&count=10`);
  }
  return urls;
}

function isAllowlisted(url: string, allowlist: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return allowlist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function validatePage(url: string, searchText: string, pageText: string, lead: Lead): boolean {
  const pageHaystack = normalizeText(pageText);
  const phoneDigits = lead.phones.map(lastPhoneDigits).filter(Boolean);
  const hasPhoneSignal = phoneDigits.some((digits) => digits && digitsOnly(pageText).includes(digits));

  if (hasPhoneSignal) return true;

  const addressTokens = businessTokens(lead.address);
  const matchedAddressTokens = addressTokens.filter((token) => pageHaystack.includes(token));
  const hasAddressSignal = addressTokens.length > 0 && matchedAddressTokens.length >= Math.min(2, addressTokens.length);
  const hasCitySignal = Boolean(lead.city && pageHaystack.includes(normalizeText(lead.city)));

  if (hasAddressSignal && hasCitySignal) return true;

  const nameTokens = businessTokens(lead.company_name);
  const matchedNameTokens = nameTokens.filter((token) => pageHaystack.includes(token));
  const nameCoverage = nameTokens.length > 0 ? matchedNameTokens.length / nameTokens.length : 0;
  const hasStrongNameSignal = nameCoverage >= 0.8 && hasCitySignal;

  return hasStrongNameSignal;
}

function extractEmails(html: string, url: string): string[] {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const genericPrefixes = ["support", "info", "admin", "noreply", "help", "hello", "mail", "ad", "reklama"];

  const isDirectoryGeneric = (email: string) => {
    const [user, domain] = email.toLowerCase().split("@");
    const isDirectoryDomain = domain === hostname || domain.endsWith(`.${hostname}`);
    return isDirectoryDomain && genericPrefixes.includes(user);
  };

  const fromMailto = [...html.matchAll(/mailto:([^"'?<#\s]+)/gi)]
    .map((match) => normalizeEmail(decodeURIComponentSafe(match[1])))
    .filter((email): email is string => Boolean(email) && !isDirectoryGeneric(email as string));
  const fromText = [...html.matchAll(EMAIL_RE)]
    .map((match) => normalizeEmail(match[0]))
    .filter((email): email is string => Boolean(email) && !isDirectoryGeneric(email as string));
  return [...new Set([...fromMailto, ...fromText])];
}

function extractMessengerLabels(html: string): string[] {
  const labels = new Set<string>();
  for (const match of html.matchAll(HREF_RE)) {
    addMessengerFromText(labels, match[1].toLowerCase());
  }
  for (const match of html.matchAll(LINK_TEXT_RE)) {
    addMessengerFromText(labels, `${match[1]} ${match[2].replace(STRIP_TAGS_RE, " ")}`);
  }
  return [...labels];
}

function addMessengerFromText(out: Set<string>, value: string): void {
  if (/wa\.me|whatsapp|api\.whatsapp\.com/i.test(value)) out.add("WhatsApp");
  if (/t\.me|telegram/i.test(value)) out.add("Telegram");
  if (/viber/i.test(value)) out.add("Viber");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
