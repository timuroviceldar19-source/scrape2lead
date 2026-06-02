import type { Page, Response } from "playwright";
import { logger } from "../../logger.js";
import { countFirmRecords } from "./mapper.js";

export class ApiCapture {
  private readonly payloads: unknown[] = [];
  private readonly urls: string[] = [];

  attach(page: Page): void {
    page.on("response", (response) => {
      void this.capture(response);
    });
  }

  values(): unknown[] {
    return [...this.payloads];
  }

  responseUrls(): string[] {
    return [...this.urls];
  }

  private async capture(response: Response): Promise<void> {
    const url = response.url();
    // First gate: drop analytics, statistics, webvisor and map-asset endpoints
    // and keep only catalog/search firm endpoints.
    if (isBlockedUrl(url)) return;
    if (!isFirmUrl(url)) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("json")) return;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // Some endpoints advertise JSON but stream or return partial content.
      return;
    }

    // Second gate: keep only responses that actually contain firm/search
    // result records — a JSON map-style/config response slips past the URL
    // filter otherwise.
    const firmCount = countFirmRecords(payload);
    if (firmCount === 0) return;

    this.payloads.push(payload);
    this.urls.push(url);
    logger.info("2gis api capture matched firm payload", summarizeShape(url, payload, firmCount));
  }
}

/**
 * Analytics / statistics / webvisor / map-asset endpoints. These never carry
 * firm result data and are dropped before the firm-endpoint allowlist so that,
 * e.g., a 2GIS statistics host can't slip through on the `2gis` token.
 */
const BLOCKED_URL_RE =
  /webvisor|metrika|mc\.yandex|google-?analytics|googletagmanager|doubleclick|\bstat(?:ic|istic|s)?\b|usagestat|counter|\btiles?\b|mapgl|\/style|styles|fonts?\b|sprites?|\.(?:png|jpe?g|webp|svg|gif|pbf|css|js|woff2?)(?:\?|$)|disk\.2gis|gis-static|traffic|s\d+\.bss/i;

/**
 * Catalog / search firm endpoints. 2GIS firm cards come from the catalog API
 * (catalog.api.2gis .../3.0/items, /byid, /searchView, /branches).
 */
const FIRM_URL_RE = /catalog\.api\.2gis|catalog\.api\.dgis|\/(?:items|branches|byid|searchView|firms?)\b|\/3\.0\/|\/2\.0\/catalog/i;

function isBlockedUrl(url: string): boolean {
  return BLOCKED_URL_RE.test(url);
}

function isFirmUrl(url: string): boolean {
  return FIRM_URL_RE.test(url);
}

/**
 * Build a small, safe debug summary of a matched payload: the endpoint URL,
 * the top-level keys, the item-array length and the firm-record count. No raw
 * contact data is logged.
 */
function summarizeShape(url: string, payload: unknown, firmCount: number): Record<string, unknown> {
  const top = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const items = findItemsArray(payload);
  return {
    url,
    firmCount,
    topKeys: top ? Object.keys(top).slice(0, 12) : Array.isArray(payload) ? ["<array>"] : typeof payload,
    itemCount: items?.length
  };
}

function findItemsArray(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const result = record.result;
    if (result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).items)) {
      return (result as Record<string, unknown>).items as unknown[];
    }
    if (Array.isArray(record.items)) return record.items;
  }
  return undefined;
}
