import type { Page, Response } from "playwright";
import { ApiCapture } from "../src/adapters/2gis/apiCapture.js";
import { buildSearchUrl, classifyWall } from "../src/adapters/2gis/TwoGisAdapter.js";
import { selectFirmCardCandidates, type FirmCardAnchor } from "../src/adapters/2gis/discoveryFallback.js";
import { extractCardsFromPayload } from "../src/adapters/2gis/mapper.js";
import { classifySoftBlock, type SoftBlockEvidence } from "../src/adapters/2gis/softBlock.js";
import type { BrowserSessionManager } from "../src/browser/browserSessionManager.js";
import type { RuntimeConfig } from "../src/types.js";

export const ENVIRONMENT_BLOCKED_EXIT_CODE = 2;

export type HealthGateBlockReason =
  | "rate_limited"
  | "proxy_timeout"
  | "network_timeout"
  | "blocked_dom"
  | "http_error";

export type AuditHealthGateResult =
  | {
      status: "ok";
      url: string;
      apiCards: number;
      domCards: number;
      httpStatus?: number;
    }
  | {
      status: "environment_blocked";
      reason: HealthGateBlockReason;
      url: string;
      detail: string;
      httpStatus?: number;
      apiCards?: number;
      domCards?: number;
    };

export interface HealthGateSnapshot {
  url: string;
  httpStatus?: number;
  responseStatuses?: number[];
  title: string;
  bodyText: string;
  apiCards: number;
  domCards: number;
  softBlockEvidence?: SoftBlockEvidence[];
}

export interface HealthGateOptions {
  timeoutMs?: number;
  renderWaitMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RENDER_WAIT_MS = 5_000;

export async function runAuditHealthGate(
  config: RuntimeConfig,
  browserSession: BrowserSessionManager,
  options: HealthGateOptions = {}
): Promise<AuditHealthGateResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const renderWaitMs = options.renderWaitMs ?? DEFAULT_RENDER_WAIT_MS;
  const url = buildSearchUrl(config.geo, config.category);
  const page = await browserSession.newPage();
  const capture = new ApiCapture();
  const responseStatuses: number[] = [];
  capture.attach(page);
  attachStatusProbe(page, responseStatuses);

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(renderWaitMs);
    const snapshot = await buildHealthGateSnapshot(page, config, capture, response, responseStatuses, url);
    return classifyHealthGateSnapshot(snapshot);
  } catch (error) {
    return classifyHealthGateError(error, url, hasProxyConfigured(config));
  } finally {
    await page.close().catch(() => undefined);
  }
}

export function classifyHealthGateSnapshot(snapshot: HealthGateSnapshot): AuditHealthGateResult {
  const statuses = [snapshot.httpStatus, ...(snapshot.responseStatuses ?? [])].filter(
    (status): status is number => typeof status === "number"
  );
  const rateLimitedStatus = statuses.find((status) => status === 429);
  if (rateLimitedStatus !== undefined || looksLikeRateLimit(snapshot.bodyText) || looksLikeRateLimit(snapshot.title)) {
    return {
      status: "environment_blocked",
      reason: "rate_limited",
      url: snapshot.url,
      detail: "2GIS returned 429 / Too Many Requests during the preflight probe",
      httpStatus: rateLimitedStatus ?? snapshot.httpStatus,
      apiCards: snapshot.apiCards,
      domCards: snapshot.domCards
    };
  }

  if (snapshot.apiCards > 0 || snapshot.domCards > 0) {
    return {
      status: "ok",
      url: snapshot.url,
      httpStatus: snapshot.httpStatus,
      apiCards: snapshot.apiCards,
      domCards: snapshot.domCards
    };
  }

  const wall = classifyWall(snapshot.title, snapshot.bodyText);
  if (wall) {
    return {
      status: "environment_blocked",
      reason: "blocked_dom",
      url: snapshot.url,
      detail: `2GIS rendered a blocking ${wall} wall instead of search cards`,
      httpStatus: snapshot.httpStatus,
      apiCards: snapshot.apiCards,
      domCards: snapshot.domCards
    };
  }

  const softBlock = classifySoftBlock(snapshot.bodyText, snapshot.softBlockEvidence ?? []);
  if (softBlock) {
    return {
      status: "environment_blocked",
      reason: "blocked_dom",
      url: snapshot.url,
      detail: `2GIS rendered an empty/soft-blocked search DOM (${softBlock.reason})`,
      httpStatus: snapshot.httpStatus,
      apiCards: snapshot.apiCards,
      domCards: snapshot.domCards
    };
  }

  if (snapshot.httpStatus !== undefined && snapshot.httpStatus >= 400) {
    return {
      status: "environment_blocked",
      reason: "http_error",
      url: snapshot.url,
      detail: `2GIS search page returned HTTP ${snapshot.httpStatus}`,
      httpStatus: snapshot.httpStatus,
      apiCards: snapshot.apiCards,
      domCards: snapshot.domCards
    };
  }

  return {
    status: "environment_blocked",
    reason: "blocked_dom",
    url: snapshot.url,
    detail: "2GIS search page loaded but exposed no API or DOM firm cards within the bounded probe",
    httpStatus: snapshot.httpStatus,
    apiCards: snapshot.apiCards,
    domCards: snapshot.domCards
  };
}

export function classifyHealthGateError(
  error: unknown,
  url: string,
  proxyConfigured: boolean
): AuditHealthGateResult {
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeRateLimit(message)) {
    return {
      status: "environment_blocked",
      reason: "rate_limited",
      url,
      detail: message
    };
  }
  const reason = proxyConfigured && looksLikeProxyFailure(message) ? "proxy_timeout" : "network_timeout";
  return {
    status: "environment_blocked",
    reason,
    url,
    detail: message
  };
}

async function buildHealthGateSnapshot(
  page: Page,
  config: RuntimeConfig,
  capture: ApiCapture,
  response: Response | null,
  responseStatuses: number[],
  url: string
): Promise<HealthGateSnapshot> {
  const [title, bodyText, anchors] = await Promise.all([
    page.title().catch(() => ""),
    page.evaluate(() => document.body?.innerText ?? "").catch(() => ""),
    collectFirmAnchors(page).catch(() => [])
  ]);
  const apiCards = capture.values()
    .flatMap((payload) => extractCardsFromPayload(payload, config.category, config.geo))
    .length;
  const domCards = selectFirmCardCandidates(anchors).length;

  return {
    url,
    httpStatus: response?.status(),
    responseStatuses,
    title,
    bodyText,
    apiCards,
    domCards,
    softBlockEvidence: capture.softBlockEvidence()
  };
}

function attachStatusProbe(page: Page, responseStatuses: number[]): void {
  page.on("response", (response) => {
    if (!is2GisUrl(response.url())) return;
    responseStatuses.push(response.status());
  });
}

async function collectFirmAnchors(page: Page): Promise<FirmCardAnchor[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll("a[href*='/firm/']")].map((a) => {
      const el = a as HTMLAnchorElement;
      return {
        href: el.href,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        ariaLabel: (el.getAttribute("aria-label") ?? "").trim()
      };
    });
  });
}

function looksLikeRateLimit(value: string): boolean {
  return /(?:\b429\b|too many requests|rate[-\s]?limit|throttled)/i.test(value);
}

function looksLikeProxyFailure(value: string): boolean {
  return /proxy|tunnel|econnrefused|econnreset|enetunreach|socket hang up|timed out|timeout/i.test(value);
}

function hasProxyConfigured(config: RuntimeConfig): boolean {
  return Boolean(config.proxy || config.proxyApiUrl);
}

function is2GisUrl(url: string): boolean {
  try {
    return /(^|\.)(2gis|dgis)\./i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
