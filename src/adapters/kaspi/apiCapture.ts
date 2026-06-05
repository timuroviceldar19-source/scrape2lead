import type { Page, Response } from "playwright";
import { logger } from "../../logger.js";

const DEBUG = process.env.API_CAPTURE_DEBUG === "true";
const DEBUG_URL_CAP = 50;

export class KaspiApiCapture {
  private readonly payloads: unknown[] = [];
  private readonly urls: string[] = [];
  private debugLogged = 0;

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
    if (DEBUG) await this.debugLog(response, url);

    // Temporarily force DEBUG to true to catch ALL kaspi.kz JSON responses and find the exact endpoint.
    const forceDebug = true; 
    if (forceDebug) await this.debugLog(response, url);

    const contentType = response.headers()["content-type"] ?? "";
    const isJson = contentType.includes("json");

    // Allow all kaspi.kz JSON for now to identify the correct payload structure.
    const isKaspiShopApi = isJson && isKaspiHost(url);

    if (!isKaspiShopApi) return;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return;
    }

    // Basic validation: ensure it looks like a shop/product listing response
    if (!isShopPayload(payload)) return;

    this.payloads.push(payload);
    this.urls.push(url);
    logger.info("kaspi api capture matched payload", {
      url: safeUrl(url),
      payloadType: typeof payload
    });
  }

  private async debugLog(response: Response, url: string): Promise<void> {
    if (this.debugLogged >= DEBUG_URL_CAP) return;
    if (!isKaspiHost(url)) return;
    
    const request = response.request();
    const resourceType = request.resourceType();
    const contentType = (response.headers()["content-type"] ?? "").split(";")[0].trim();
    const isJsonish = contentType.includes("json") || resourceType === "xhr" || resourceType === "fetch";
    
    if (!isJsonish) return;
    this.debugLogged += 1;

    let topLevelShape: string | undefined;
    if (contentType.includes("json")) {
      try {
        const body = await response.json();
        topLevelShape = summarizeTopLevelShape(body);
      } catch {
        // streamed / partial JSON
      }
    }

    logger.info("[kaspi-api-capture-debug] response", {
      url: safeUrl(url),
      method: request.method(),
      status: response.status(),
      contentType,
      topLevelShape
    });
  }
}

function isKaspiHost(url: string): boolean {
  try {
    return /(^|\.)(kaspi\.kz|kaspi\.com)/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search ? " ?<stripped>" : ""}`;
  } catch {
    return "<unparsable-url>";
  }
}

// Kaspi shop/product search endpoints. 
// Includes the product-view results/filters which contain merchant/shop info.
const SHOP_ENDPOINT_RE = /\/yml\/product-view\/pl\/(results|filters)|\/shop\/api\/|\/shop\/search|\/api\/shop/i;

function isShopEndpoint(url: string): boolean {
  return SHOP_ENDPOINT_RE.test(url);
}

function isShopPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;

  // Heuristic: look for common shop listing structures
  // Kaspi often wraps responses in { data: { items: [...] } } or similar
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (Array.isArray(data.items) || Array.isArray(data.shops) || Array.isArray(data.results) || Array.isArray(data.filters)) {
      return true;
    }
  }

  if (Array.isArray(record.items) || Array.isArray(record.shops) || Array.isArray(record.results) || Array.isArray(record.filters)) {
    return true;
  }

  return false;
}

function summarizeTopLevelShape(payload: unknown): string {
  if (Array.isArray(payload)) return "<array>";
  if (payload && typeof payload === "object") {
    return `object{${Object.keys(payload as Record<string, unknown>).slice(0, 8).join(", ")}}`;
  }
  return typeof payload;
}