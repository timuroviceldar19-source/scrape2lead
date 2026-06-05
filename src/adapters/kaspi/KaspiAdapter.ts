import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserSessionManager } from "../../browser/browserSessionManager.js";
import type {
  ISourceAdapter,
  RawCardDetail,
  RawCompanyCard,
  RawContacts,
  RuntimeConfig,
  SearchQuery,
  SourceCapabilities,
  Lead
} from "../../types.js";
import { logger } from "../../logger.js";
import { KaspiApiCapture } from "./apiCapture.js";
import { extractShopsFromPayload, mapContacts, mapDetail, toLead } from "./mapper.js";

export class KaspiAdapter implements ISourceAdapter {
  readonly source = "kaspi";
  private lastPayloads: unknown[] = [];

  constructor(
    private readonly config: RuntimeConfig,
    private readonly browserSession = new BrowserSessionManager(config)
  ) {}

  capabilities(): SourceCapabilities {
    return {
      needsBrowser: true,
      needsProxy: Boolean(this.config.proxy || this.config.proxyApiUrl),
      handlesCaptcha: true,
      supportsApiCapture: true,
      supportsDomFallback: true
    };
  }

  async searchCompanies(query: SearchQuery): Promise<RawCompanyCard[]> {
    return this.listCards(query);
  }

  async listCards(query: SearchQuery): Promise<RawCompanyCard[]> {
    if (this.config.fixturePath) {
      const payload = JSON.parse(fs.readFileSync(this.config.fixturePath, "utf8")) as unknown;
      this.lastPayloads = [payload];
      const cards = extractShopsFromPayload(payload, query.category, query.geo).slice(0, query.limit);
      this.assertShopCards(cards, `fixture ${this.config.fixturePath}`);
      return cards;
    }

    const page = await this.browserSession.newPage();
    const capture = new KaspiApiCapture();
    capture.attach(page);

    const baseUrl = this.config.kaspiBaseUrl ?? "https://kaspi.kz";
    const url = buildSearchUrl(query.category, query.geo, baseUrl);
    logger.info("opening Kaspi shop search", { url, category: query.category, geo: query.geo });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.detectCaptcha(page);
      
      // Wait for initial Nuxt hydration
      await page.waitForTimeout(5000);
      
      // Try to trigger the search API call directly if it hasn't happened
      // Kaspi often requires a specific search submission or catalog URL
      const directApiUrl = buildDirectApiUrl(query.category, query.geo, baseUrl);
      logger.info("attempting direct API fetch for Kaspi products", { url: directApiUrl });
      
      let directPayload: unknown = null;
      try {
        const response = await page.request.get(directApiUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': await page.evaluate(() => navigator.userAgent),
            'Referer': url
          }
        });
        
        if (response.ok()) {
          directPayload = await response.json();
          logger.info("direct API fetch successful, saving snapshot for analysis");
          this.writeSnapshot("direct-api-response", directPayload);
        }
      } catch (apiError) {
        logger.warn("direct API fetch failed, falling back to DOM", { message: apiError instanceof Error ? apiError.message : String(apiError) });
      }
      
      await this.scrollResults(page, query.limit);

      const payloads = capture.values();
      if (directPayload) {
        payloads.push(directPayload);
      }
      const captured = payloads.flatMap((payload) => extractShopsFromPayload(payload, query.category, query.geo));

      if (captured.length > 0) {
        // Enrich each discovered merchant with rating summary from the dedicated API
        const enrichedCards = await Promise.all(captured.map(async (card) => {
          const merchantId = card.externalId;
          const summaryUrl = `https://kaspi.kz/yml/creview/rest/misc/merchant/${merchantId}/summary`;
          try {
            const res = await page.request.get(summaryUrl, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': await page.evaluate(() => navigator.userAgent),
                'Referer': url
              }
            });
            if (res.ok()) {
              const summary = await res.json() as Record<string, unknown>;
              const data = summary?.data as Record<string, unknown> | undefined;
              if (data) {
                const currentPayload = typeof card.payload === "object" && card.payload !== null ? card.payload as Record<string, unknown> : {};
                card.payload = {
                  ...currentPayload,
                  rating: data.global,
                  reviewCount: data.reviewsCount ?? data.ratingCount
                };
              }
            }
          } catch (e) {
            // Ignore individual merchant rating fetch failures to keep the pipeline resilient
          }
          // Polite delay between API calls
          await page.waitForTimeout(randomDelay(this.config.delayRangeMs));
          return card;
        }));

        this.lastPayloads = payloads;
        this.writeSnapshot("api-capture", this.lastPayloads);
        this.assertShopCards(enrichedCards, `${this.lastPayloads.length} captured payload(s)`);
        return dedupeCards(enrichedCards).slice(0, query.limit);
      }

      logger.warn("api capture returned no cards; falling back to DOM extraction for Kaspi shops");
      const domCards = await this.extractShopsFromDom(page, query);
      this.assertShopCards(domCards, "DOM extraction");
      return dedupeCards(domCards).slice(0, query.limit);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private assertShopCards(cards: RawCompanyCard[], context: string): void {
    if (cards.length > 0) return;
    throw new Error(
      `extraction_failed: Kaspi discovery found no real shop result cards (${context}); ` +
        `refusing to enqueue empty entries as leads`
    );
  }

  async getCardDetail(card: RawCompanyCard): Promise<RawCardDetail> {
    // For Kaspi, the detail payload is often the same as the list payload, 
    // or requires a separate navigation to the shop page.
    // We'll attempt to fetch the detail page if needed, but start with captured payload.
    const capturedPayload = card.payload;
    
    if (this.config.fixturePath) {
      return mapDetail(card, capturedPayload);
    }

    // Attempt DOM detail fetch if the captured payload is sparse
    const domResult = await this.fetchDomDetailWithRetry(card);

    if (domResult.payload) {
      const domName = getRecordString(domResult.payload, "name");
      
      // Prevent error page titles or generic Kaspi UI text from overwriting valid API-extracted names
      const isInvalidName = domName && /страница не найдена|not found|ошибка|error|404|выберите ваш город/i.test(domName);
      const safeName = isInvalidName ? card.name : (domName ?? card.name);

      return mapDetail(
        {
          ...card,
          name: safeName,
          category: getRecordString(domResult.payload, "category") ?? card.category,
          city: getRecordString(domResult.payload, "city") ?? card.city,
          address: getRecordString(domResult.payload, "address") ?? card.address,
          url: getRecordString(domResult.payload, "url") ?? card.url
        },
        {
          ...(typeof capturedPayload === "object" && capturedPayload !== null ? (capturedPayload as Record<string, unknown>) : {}),
          ...domResult.payload
        }
      );
    }

    return mapDetail(card, capturedPayload);
  }

  private async fetchDomDetailWithRetry(card: RawCompanyCard): Promise<{ payload: Record<string, unknown> | null; attempts: number }> {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return { payload: await this.fetchDomDetail(card), attempts: attempt };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isBlockLikeError(message)) throw error;
        
        if (attempt < maxAttempts) {
          logger.warn("Kaspi detail DOM extraction failed; retrying once", {
            externalId: card.externalId,
            attempt,
            message
          });
          continue;
        }
        
        logger.warn("Kaspi detail DOM extraction failed; falling back to captured payload", {
          externalId: card.externalId,
          attempts: attempt,
          message
        });
        return { payload: null, attempts: attempt };
      }
    }
    return { payload: null, attempts: maxAttempts };
  }

  private async fetchDomDetail(card: RawCompanyCard): Promise<Record<string, unknown> | null> {
    const baseUrl = this.config.kaspiBaseUrl ?? "https://kaspi.kz";
    const detailUrl = card.url || `${baseUrl}/shop/${encodeURIComponent(card.externalId)}`;
    const page = await this.browserSession.newPage();
    
    try {
      logger.info("opening Kaspi shop detail", { externalId: card.externalId, url: detailUrl });
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.detectCaptcha(page);
      
      // Wait for potential dynamic content loading
      await page.waitForTimeout(randomDelay(this.config.delayRangeMs));
      
      // Extract basic info and inline JSON from DOM
      const domData = await page.evaluate(() => {
        // 1. Try to find inline JSON with merchant info (uid, name, phone, rating)
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const text = script.textContent || "";
          if (text.includes('"uid"') && text.includes('"phone"') && text.includes('"rating"')) {
            try {
              // More flexible regex to catch the exact structure provided by the user
              const regex = /\{\s*"uid"\s*:\s*"\d+"\s*,\s*"name"\s*:\s*"[^"]+"\s*,\s*"phone"\s*:\s*"[^"]+"\s*,[^}]+\}/;
              const match = text.match(regex);
              if (match) {
                try {
                  const parsed = JSON.parse(match[0]);
                  if (parsed.uid && parsed.phone) {
                    return { ...parsed, source: "inline_json" };
                  }
                } catch (e) {
                  // Ignore parsing errors for non-matching blocks
                }
              }
            } catch (e) {
              // Ignore
            }
          }
        }
        
        // 2. Fallback to exact DOM selectors provided by user
        const phoneEl = document.querySelector('.merchant-profile__contact-text, [itemprop="telephone"], a[href^="tel:"]');
        const nameEl = document.querySelector('h1, .shop-name, .title, .merchant-profile__name');
        
        return {
          name: nameEl?.textContent?.trim() || null,
          phone: phoneEl?.textContent?.trim() || phoneEl?.getAttribute('href')?.replace('tel:', '') || null,
          source: "dom_fallback"
        };
      });

      return (domData.name || domData.phone) ? domData : null;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async getContacts(detail: RawCardDetail): Promise<RawContacts> {
    return mapContacts(detail, detail.payload);
  }

  normalize(detail: RawCardDetail, contacts: RawContacts): Lead {
    return toLead(detail, contacts, this.config.geo);
  }

  async close(): Promise<void> {
    await this.browserSession.close();
  }

  private async scrollResults(page: Page, limit: number): Promise<void> {
    let stagnant = 0;
    let previousHeight = 0;
    for (let index = 0; index < Math.min(60, Math.ceil(limit / 10) + 10); index += 1) {
      const height = await page.evaluate(() => {
        const target = document.querySelector("[data-test-id='shop-list']") || 
                       document.querySelector(".shop-list") || 
                       document.scrollingElement as HTMLElement | null;
        if (!target) return 0;
        target.scrollBy(0, 900);
        return target.scrollHeight;
      });
      stagnant = height === previousHeight ? stagnant + 1 : 0;
      previousHeight = height;
      await page.waitForTimeout(randomDelay(this.config.delayRangeMs));
      if (stagnant >= 4) break;
      await this.detectCaptcha(page);
    }
  }

  private async detectCaptcha(page: Page): Promise<void> {
    const [title, bodyText] = await Promise.all([
      page.title().catch(() => ""),
      page.evaluate(() => document.body?.innerText ?? "").catch(() => "")
    ]);
    
    const wall = classifyKaspiWall(title, bodyText);
    if (!wall) return;
    
    const screenshotPath = path.join(this.config.rawSnapshotDir, `kaspi-${wall}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    
    if (wall === "captcha") {
      throw new Error(`CAPTCHA detected on Kaspi; screenshot saved to ${screenshotPath}`);
    }
    throw new Error(
      `blocked: Kaspi ${wall} interstitial — no results rendered; screenshot saved to ${screenshotPath}`
    );
  }

  private async extractShopsFromDom(page: Page, query: SearchQuery): Promise<RawCompanyCard[]> {
    logger.info("extracting Kaspi shops from DOM", { category: query.category, geo: query.geo });
    
    // Wait for Nuxt hydration and shop cards to render
    await page.waitForTimeout(5000);
    
    // Save HTML snapshot for debugging and selector analysis
    const htmlContent = await page.content();
    const snapshotPath = path.join(this.config.rawSnapshotDir, `kaspi-search-dom-${Date.now()}.html`);
    fs.mkdirSync(this.config.rawSnapshotDir, { recursive: true });
    fs.writeFileSync(snapshotPath, htmlContent, "utf8");
    logger.info("kaspi search DOM snapshot saved", { path: snapshotPath });
    
    const cardsData = await page.evaluate(() => {
      // Look for actual shop links. Exclude root, merchant, and known city patterns.
      const nodes = document.querySelectorAll('a[href^="/shop/"]:not([href="/shop/"]):not([href*="/merchant/"])');
      const results: Record<string, unknown>[] = [];
      const seenUrls = new Set<string>();
      
      // Common city slugs to exclude from shop results
      const citySlugs = new Set(["almaty", "astana", "aktobe", "karaganda", "shymkent", "abai", "abay", "aktau", "atyrau"]);
      
      nodes.forEach((node) => {
        const el = node as HTMLElement;
        const href = el.getAttribute('href') || "";
        const slug = href.split('/shop/')[1]?.split('/')[0]?.toLowerCase();
        
        // Skip if it's a city page or already processed
        if (!slug || seenUrls.has(href) || citySlugs.has(slug)) return;
        seenUrls.add(href);
        
        // Get the closest card container to extract richer data
        const card = el.closest('.shop-card, .catalog-item, [data-test-id="shop-item"], .shop-info') || el;
        const name = card.querySelector('.shop-name, .title, h2, h3, .shop-title')?.textContent?.trim() || 
                     el.textContent?.trim().split('\n')[0]?.trim() || `Магазин`;
        
        // Extract basic info if available in the card
        const ratingText = card.querySelector('.rating, .stars, [data-test-id="shop-rating"]')?.textContent?.trim() || "";
        const rating = parseFloat(ratingText.replace(/[^\d.]/g, '')) || undefined;
        
        const reviewText = card.querySelector('.reviews-count, .reviews, [data-test-id="shop-reviews"]')?.textContent?.trim() || "";
        const reviewCount = parseInt(reviewText.replace(/[^\d]/g, ''), 10) || undefined;

        results.push({
          id: slug,
          name,
          url: href.startsWith('http') ? href : `https://kaspi.kz${href}`,
          rating,
          reviewCount,
          source: "dom_fallback"
        });
      });
      
      return results;
    });

    return cardsData.map((data) => ({
      source: "kaspi" as const,
      externalId: String(data.id),
      name: String(data.name),
      category: query.category,
      city: query.geo,
      address: "",
      url: String(data.url),
      payload: data
    }));
  }

  private writeSnapshot(kind: string, payload: unknown): void {
    fs.mkdirSync(this.config.rawSnapshotDir, { recursive: true });
    const filePath = path.join(this.config.rawSnapshotDir, `${kind}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
}

// --- Helpers ---

function buildDirectApiUrl(category: string, geo: string, baseUrl: string = "https://kaspi.kz"): string {
  // Endpoint confirmed to return merchant/shop lists via data.filters[id="allMerchants"].rows
  // Removed restrictive zone filter to avoid returning only hidden/inactive merchants
  const params = new URLSearchParams({
    sort: "relevance",
    text: category,
    sc: "",
    ui: "DESKTOP",
    filteredByCategory: "false"
  });

  return `${baseUrl}/yml/product-view/pl/filters?${params.toString()}`;
}

function buildSearchUrl(category: string, geo: string, baseUrl: string = "https://kaspi.kz"): string {
  // Kaspi has a dedicated merchant/shop search section.
  // We use the merchant search URL instead of product search to find actual shops.
  const citySlug = geo.toLowerCase().trim()
    .replace(/алматы/g, "almaty")
    .replace(/астана|nur-sultan/g, "astana")
    .replace(/актобе/g, "aktobe")
    .replace(/караганда/g, "karaganda")
    .replace(/шымкент/g, "shymkent")
    .replace(/[^a-z0-9-]/g, "");

  // Example: https://kaspi.kz/shop/almaty/merchants/?text=Стройматериалы
  const params = new URLSearchParams();
  if (category) params.set("text", category);
  
  return `${baseUrl}/shop/${citySlug}/merchants/?${params.toString()}`;
}

function dedupeCards(cards: RawCompanyCard[]): RawCompanyCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (seen.has(card.externalId)) return false;
    seen.add(card.externalId);
    return true;
  });
}

function getRecordString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    return typeof val === "string" ? val : undefined;
  }
  return undefined;
}

function randomDelay(range: [number, number]): number {
  const [min, max] = range;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isBlockLikeError(message: string): boolean {
  return /blocked|captcha|403|429/i.test(message);
}

const KASPI_CAPTCHA_SIGNATURES: RegExp[] = [
  /captcha/i,
  /капч/i,
  /подозрительную активность/i,
  /не робот/i,
  /security check/i
];

function classifyKaspiWall(title: string, bodyText: string): "captcha" | "blocked" | null {
  const haystack = `${title}\n${bodyText}`;
  if (KASPI_CAPTCHA_SIGNATURES.some((re) => re.test(haystack))) return "captcha";
  if (/доступ ограничен|blocked|forbidden/i.test(haystack)) return "blocked";
  return null;
}