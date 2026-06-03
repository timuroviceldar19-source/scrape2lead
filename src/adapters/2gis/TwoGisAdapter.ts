import fs from "node:fs";
import path from "node:path";
import type { Page, Response } from "playwright";
import { BrowserSessionManager } from "../../browser/browserSessionManager.js";
import type {
  ISourceAdapter,
  RawCardDetail,
  RawCompanyCard,
  RawContacts,
  RawDetailDegradationReason,
  RawDetailDiagnostics,
  RuntimeConfig,
  SearchQuery,
  SourceCapabilities
} from "../../types.js";
import { logger } from "../../logger.js";
import { ApiCapture } from "./apiCapture.js";
import {
  buildTwoGisDiscoveryVariants,
  collectFirmCardsViaScroll,
  mergeDiscoveryVariantResults,
  type DiscoveryVariantResult,
  type DomFallbackTelemetry,
  type TwoGisDiscoveryVariant
} from "./discoveryFallback.js";
import { extractCardsFromPayload, findDetailPayload, mapContacts, mapDetail, toLead } from "./mapper.js";
import { classifySoftBlock, SoftBlockError, type SoftBlockClassification, type SoftBlockEvidence } from "./softBlock.js";

interface DetailDomFetchResult {
  payload: Record<string, unknown> | null;
  attempts: number;
  failure?: {
    reason: RawDetailDegradationReason;
    message: string;
  };
}

export class TwoGisAdapter implements ISourceAdapter {
  readonly source = "2gis";
  private lastPayloads: unknown[] = [];
  private detailDebugLogged = 0;

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
      const cards = extractCardsFromPayload(payload, query.category, query.geo).slice(0, query.limit);
      this.assertFirmCards(cards, `fixture ${this.config.fixturePath}`);
      return cards;
    }

    const variants = buildTwoGisDiscoveryVariants(query);
    const variantResults: DiscoveryVariantResult[] = [];
    const capturedPayloads: unknown[] = [];

    for (const variant of variants) {
      const result = await this.listCardsForVariant(query, variant);
      capturedPayloads.push(...result.payloads);
      variantResults.push({ cards: result.cards, telemetry: result.telemetry });
      const merged = mergeDiscoveryVariantResults(variantResults, query.limit, variants.length);
      if (merged.cards.length >= query.limit) break;
    }

    this.lastPayloads = capturedPayloads;
    this.writeSnapshot("api-capture", this.lastPayloads);
    const { cards, diagnostics } = mergeDiscoveryVariantResults(variantResults, query.limit, variants.length);
    logger.info("2gis discovery source cap", diagnostics);
    this.assertFirmCards(cards, `${this.lastPayloads.length} captured payload(s)`);
    return cards;
  }

  private async listCardsForVariant(
    query: SearchQuery,
    variant: TwoGisDiscoveryVariant
  ): Promise<{ cards: RawCompanyCard[]; payloads: unknown[]; telemetry?: DomFallbackTelemetry }> {
    const page = await this.browserSession.newPage();
    const capture = new ApiCapture();
    capture.attach(page);
    const markersCapture = new MarkersResponseListener();
    markersCapture.attach(page);

    const url = buildSearchUrl(variant.geo, variant.searchText);
    logger.info("opening 2GIS search", {
      url,
      variantKind: variant.kind,
      searchText: variant.searchText
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.detectCaptcha(page);
      await this.scrollResults(page, query.limit);

      const payloads = capture.values();
      const captured = payloads.flatMap((payload) => extractCardsFromPayload(payload, query.category, query.geo));
      if (captured.length > 0) {
        return { cards: dedupeCards(captured).slice(0, query.limit), payloads };
      }

      const softBlock = await this.detectSoftBlock(page, capture.softBlockEvidence());
      if (softBlock) {
        await this.throwSoftBlock(page, softBlock);
      }

      logger.warn("api capture returned no cards; using DOM fallback", {
        variantKind: variant.kind,
        searchText: variant.searchText
      });
      const fallback = await collectFirmCardsViaScroll(page, query, {
        delayRangeMs: this.config.delayRangeMs,
        detectCaptcha: (p) => this.detectCaptcha(p),
        markersPayloads: markersCapture.values()
      });
      return {
        cards: fallback.cards,
        payloads,
        telemetry: fallback.telemetry
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Throw an extraction-quality error when discovery yielded no real firm
   * cards. JobManager.discoverCards classifies `extraction_failed` and records
   * evidence before the run aborts, so the job never finalises as `completed`
   * with junk leads.
   */
  private assertFirmCards(cards: RawCompanyCard[], context: string): void {
    if (cards.length > 0) return;
    throw new Error(
      `extraction_failed: 2GIS discovery found no real firm result cards (${context}); ` +
        `refusing to enqueue UI/map/promo entries as leads`
    );
  }

  async getCardDetail(card: RawCompanyCard): Promise<RawCardDetail> {
    const capturedPayload = findDetailPayload(this.lastPayloads, card.externalId) ?? asRecord(card.payload);
    if (this.config.fixturePath) {
      return withDetailDiagnostics(mapDetail(card, capturedPayload), {
        stage: "fixture",
        degraded: false,
        fallbackUsed: false,
        sparseFallback: false,
        attempts: 0
      });
    }

    const domResult = await this.fetchDomDetailWithRetry(card);

    if (!domResult.payload) {
      return withDetailDiagnostics(mapDetail(card, capturedPayload), {
        stage: "captured_fallback",
        degraded: true,
        fallbackUsed: true,
        sparseFallback: isSparseDetailPayload(capturedPayload),
        attempts: domResult.attempts,
        reason: domResult.failure?.reason ?? "unknown",
        message: domResult.failure?.message
      });
    }
    return withDetailDiagnostics(mapDetail(
      {
        ...card,
        name: getRecordString(domResult.payload, "name") ?? card.name,
        category: getRecordString(domResult.payload, "category") ?? card.category,
        city: getRecordString(domResult.payload, "city_name") ?? card.city,
        address: getRecordString(domResult.payload, "address_name") ?? card.address,
        url: getRecordString(domResult.payload, "url") ?? card.url
      },
      {
        ...capturedPayload,
        ...domResult.payload
      }
    ), {
      stage: "dom",
      degraded: false,
      fallbackUsed: false,
      sparseFallback: false,
      attempts: domResult.attempts
    });
  }

  private async fetchDomDetailWithRetry(card: RawCompanyCard): Promise<DetailDomFetchResult> {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return { payload: await this.fetchDomDetail(card), attempts: attempt };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isBlockLikeError(message)) throw error;
        const retryable = isRetryableDetailDomError(message);
        if (retryable && attempt < maxAttempts) {
          logger.warn("2GIS detail DOM extraction failed; retrying once", {
            externalId: card.externalId,
            attempt,
            message
          });
          continue;
        }
        logger.warn("2GIS detail DOM extraction failed; falling back to captured payload", {
          externalId: card.externalId,
          attempts: attempt,
          message
        });
        return {
          payload: null,
          attempts: attempt,
          failure: {
            reason: classifyDetailDomFailure(message),
            message
          }
        };
      }
    }
    return { payload: null, attempts: maxAttempts };
  }

  async getContacts(detail: RawCardDetail): Promise<RawContacts> {
    return mapContacts(detail, detail.payload);
  }

  normalize(detail: RawCardDetail, contacts: RawContacts) {
    return toLead(detail, contacts);
  }

  async close(): Promise<void> {
    await this.browserSession.close();
  }

  private async scrollResults(page: Page, limit: number): Promise<void> {
    let stagnant = 0;
    let previousHeight = 0;
    for (let index = 0; index < Math.min(60, Math.ceil(limit / 10) + 10); index += 1) {
      const height = await page.evaluate(() => {
        const candidates = [
          document.querySelector("[data-scroll-container]"),
          document.querySelector("[class*='scroll']"),
          document.scrollingElement
        ].filter(Boolean) as Element[];
        const target = candidates[0] as HTMLElement | undefined;
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

  private async domFallback(page: Page, query: SearchQuery, markersPayloads: unknown[] = []): Promise<RawCompanyCard[]> {
    logger.warn("api capture returned no cards; using DOM fallback");
    // Progressive scroll-and-collect: the previous version grabbed only
    // the firm anchors already in the DOM, which capped discovery to
    // whatever was rendered above the fold. The helper scrolls the
    // results panel until the configured limit is reached, no new cards
    // appear for N scrolls, an anti-bot wall is detected, the max
    // scroll budget is exhausted, or the overall timeout trips. CAPTCHA
    // detection is delegated back into the adapter's own probe so the
    // existing thrown-error / evidence-snapshot pipeline is preserved.
    //
    // 2GIS renders the results list as a virtual scroller that only
    // exposes ~12 firm anchors in the DOM, no matter how much the
    // panel is scrolled. The hybrid supplement passes the
    // `markers/clustered` payloads (already collected by the separate
    // listener attached in `listCards`) into the helper so the
    // synthesis can top the result set up to `query.limit`. The
    // synthesis is strictly additive — it never replaces the
    // DOM-collected cards and only runs when the loop finished
    // below the target.
    const { cards } = await collectFirmCardsViaScroll(page, query, {
      delayRangeMs: this.config.delayRangeMs,
      detectCaptcha: (p) => this.detectCaptcha(p),
      markersPayloads
    });
    return cards;
  }

  private async fetchDomDetail(card: RawCompanyCard): Promise<Record<string, unknown> | null> {
    const detailUrl = canonicalFirmUrl(card.url) ?? buildFirmUrl(this.config.geo, card.externalId);
    const page = await this.browserSession.newPage();
    try {
      logger.info("opening 2GIS detail", { externalId: card.externalId, url: stripQuery(detailUrl) });
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.detectCaptcha(page);
      await page.waitForTimeout(randomDelay(this.config.delayRangeMs));
      let snapshot = await collectDomFirmSnapshot(page);
      let reveal = revealEvidenceFromButtons(snapshot.buttons, false);

      // Phone-reveal gate: only click "Показать телефон" when the panel
      // does not already expose a usable `tel:` href. The audit calls this
      // out explicitly — clicking through reveal when a real tel: link
      // already exists is wasted traffic and (worse) trips the counter
      // 2GIS uses to throttle masked-phone reveals.
      if (!hasUsableTelLink(snapshot)) {
        reveal = await clickContactRevealControls(page);
        await page.waitForTimeout(700);
        await this.detectCaptcha(page);
        snapshot = await collectDomFirmSnapshot(page);
      }

      const dom = buildDomFirmPayload(snapshot, card, this.config.category, this.config.geo, reveal);
      this.logDetailDebug(card.externalId, dom.debug);
      return dom.payload;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private logDetailDebug(externalId: string, debug: Record<string, unknown>): void {
    if (this.detailDebugLogged >= 2) return;
    this.detailDebugLogged += 1;
    logger.info("[2gis-detail-debug] safe detail extraction evidence", {
      externalId,
      ...debug
    });
  }

  private async detectCaptcha(page: Page): Promise<void> {
    const [title, bodyText] = await Promise.all([
      page.title().catch(() => ""),
      page.evaluate(() => document.body?.innerText ?? "").catch(() => "")
    ]);
    const wall = classifyWall(title, bodyText);
    if (!wall) return;
    const screenshotPath = path.join(this.config.rawSnapshotDir, `${wall}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    // The error message is classified downstream by JobManager.classifyError:
    // both "CAPTCHA detected" and "blocked" map to the `blocked` bucket, so a
    // discovery-phase wall is recorded as a captcha/blocked event and the run
    // fails loudly instead of silently completing with 0 cards.
    if (wall === "captcha") {
      throw new Error(`CAPTCHA detected; screenshot saved to ${screenshotPath}`);
    }
    throw new Error(
      `blocked: 2GIS ${wall} interstitial — no results rendered; screenshot saved to ${screenshotPath}`
    );
  }

  private async detectSoftBlock(page: Page, payloadEvidence: SoftBlockEvidence[]): Promise<SoftBlockClassification | null> {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return classifySoftBlock(bodyText, payloadEvidence);
  }

  private async throwSoftBlock(page: Page, classification: SoftBlockClassification): Promise<never> {
    const screenshotPath = path.join(this.config.rawSnapshotDir, `${classification.reason}-${Date.now()}.png`);
    const screenshotSaved = await page.screenshot({ path: screenshotPath, fullPage: true })
      .then(() => true)
      .catch(() => false);
    throw new SoftBlockError(
      `${classification.reason}: 2GIS rendered an empty-results page with throttling/soft-block signals` +
        (screenshotSaved ? `; screenshot saved to ${screenshotPath}` : ""),
      classification,
      screenshotSaved ? screenshotPath : undefined
    );
  }

  private writeSnapshot(kind: string, payload: unknown): void {
    fs.mkdirSync(this.config.rawSnapshotDir, { recursive: true });
    const filePath = path.join(this.config.rawSnapshotDir, `${kind}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
}

/**
 * Anti-bot / CAPTCHA signatures for 2GIS. Matched against both the page
 * `<title>` and the visible body text.
 *
 * 2GIS's interstitial wall reads "Мы заметили подозрительную активность …
 * чтобы подтвердить, что вы не робот, заполните форму ниже" and carries the
 * literal word "Captcha" only in the `<title>` ("2GIS Captcha") — never in
 * the body. The old body-only `captcha|капча|проверка` check therefore let
 * the wall through, and the job mis-reported `status: completed, leads: 0`
 * instead of failing loudly. (Confirmed by the no-proxy Novosibirsk smoke
 * test, 2026-06-02: a direct IP gets served this wall, 0 data responses.)
 */
const CAPTCHA_SIGNATURES: RegExp[] = [
  /captcha/i,
  /капч/i, // stem — matches капча / капчу / капчи across grammatical cases
  /проверка/i,
  /подозрительную активность/i,
  /не робот/i,
  /\brobot\b/i
];

/**
 * Non-CAPTCHA blocking interstitials. These are not anti-bot challenges per
 * se but still prevent results from rendering, so discovery must treat them
 * as a block (fail loudly) rather than "0 cards found".
 *
 * The "browser upgrade" wall ("2ГИС советует обновить браузер … 2ГИС
 * прекрасно работает в новых браузерах") is served when 2GIS judges the
 * User-Agent too old. The adapter's spoofed `Chrome/124` UA trips it, so a
 * direct run silently returned 0 cards. (Confirmed by the no-proxy
 * Novosibirsk smoke test, 2026-06-02, replicating the adapter context.)
 */
const BLOCK_SIGNATURES: RegExp[] = [
  /обновит[ьея].{0,12}браузер/i,
  /обновите ваш браузер/i,
  /устаревш\w*\s+браузер/i,
  /update your browser/i,
  /unsupported browser/i
];

/**
 * True when the page title or body text matches a known anti-bot/CAPTCHA
 * signature. Pure so it can be unit-tested without a live browser.
 */
export function looksLikeCaptcha(title: string, bodyText: string): boolean {
  const haystack = `${title}\n${bodyText}`;
  return CAPTCHA_SIGNATURES.some((re) => re.test(haystack));
}

/**
 * Classify a page as a known blocking wall, or `null` if it looks normal.
 * Pure so it can be unit-tested without a live browser. CAPTCHA takes
 * precedence over the browser-upgrade interstitial.
 */
export function classifyWall(title: string, bodyText: string): "captcha" | "browser-upgrade" | null {
  if (looksLikeCaptcha(title, bodyText)) return "captcha";
  const haystack = `${title}\n${bodyText}`;
  if (BLOCK_SIGNATURES.some((re) => re.test(haystack))) return "browser-upgrade";
  return null;
}

/**
 * One anchor collected from the firm detail panel. The DOM-detail extractor
 * scopes every collection to the same panel (an `<article>` element, the
 * closest containing block of the firm h1, etc.) so list / sidebar / promo /
 * map / footer anchors are never mixed into the detail payload.
 */
export interface DomFirmLink {
  href: string;
  text: string;
  ariaLabel: string;
}

/**
 * Snapshot of the opened 2GIS firm detail panel. `scope` records whether the
 * extractor found a panel container (`"panel"`) or fell back to `document`
 * (`"document"`). The mapper uses this evidence to fail loud when scoping
 * never resolved — the slice must never silently scrape list / footer
 * anchors as firm contact data.
 */
export interface DomFirmSnapshot {
  title: string;
  url: string;
  scope: "panel" | "document";
  h1: string[];
  buttons: string[];
  telLinks: DomFirmLink[];
  mailtoLinks: DomFirmLink[];
  addressLinks: DomFirmLink[];
  httpLinks: DomFirmLink[];
  allAnchors: DomFirmLink[];
  selectorCounts: Record<string, number>;
}

export interface ContactRevealEvidence {
  present: boolean;
  clicked: number;
  labels: string[];
}

/**
 * Safe, redirect-free description of a messenger entry. The URL is omitted
 * on purpose: 2GIS renders messenger links as `link.2gis.ru` redirects that
 * carry per-session tracking tokens, so we never persist or log them. The
 * provider label is the only thing safe to keep.
 */
export interface DomFirmMessenger {
  provider: string;
  label: string;
}

const MESSENGER_PROVIDERS: Array<{ provider: string; re: RegExp; hrefRe?: RegExp }> = [
  { provider: "WhatsApp", re: /whats?app/i, hrefRe: /(?:^|\.)wa\.me\/|whatsapp\.com\//i },
  { provider: "Telegram", re: /телеграм|telegram/i, hrefRe: /(?:^|\.)t\.me\/|telegram\.me\//i },
  { provider: "Viber", re: /viber/i, hrefRe: /viber(?:\.click)?:|(?:^|\.)viber\.com\//i },
  { provider: "Max", re: /(?:^|\s)(max)(?:\s|$)/i, hrefRe: /(?:^|\.)max\.ru\//i }
];

export function buildSearchUrl(geo: string, category: string): string {
  return `https://2gis.ru/${citySegment(geo)}/search/${encodeURIComponent(category)}`;
}

function buildFirmUrl(geo: string, externalId: string): string {
  return `https://2gis.ru/${citySegment(geo)}/firm/${encodeURIComponent(externalId)}`;
}

export function citySegment(geo: string): string {
  const normalized = geo.trim().toLowerCase();
  const known = CITY_SLUGS.get(normalized);
  return known ?? encodeURIComponent(geo);
}

const CITY_SLUGS = new Map<string, string>([
  ["moscow", "moscow"],
  ["\u043c\u043e\u0441\u043a\u0432\u0430", "moscow"],
  ["novosibirsk", "novosibirsk"],
  ["\u043d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a", "novosibirsk"],
  ["saint petersburg", "spb"],
  ["st petersburg", "spb"],
  ["spb", "spb"],
  ["\u0441\u0430\u043d\u043a\u0442-\u043f\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433", "spb"]
]);

async function clickContactRevealControls(page: Page): Promise<ContactRevealEvidence> {
  return page.evaluate(async () => {
    const revealRe = new RegExp(
      [
        "\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c\\s+\\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d",
        "\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c\\s+\\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d\\u044b",
        "\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c\\s+\\u043a\\u043e\\u043d\\u0442\\u0430\\u043a\\u0442",
        "\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c\\s+\\u043a\\u043e\\u043d\\u0442\\u0430\\u043a\\u0442\\u044b"
      ].join("|"),
      "i"
    );
    const controls = [...document.querySelectorAll("button, [role='button'], a")]
      .filter((el) => revealRe.test((el.textContent ?? "").replace(/\s+/g, " ").trim()));
    const labels = controls.slice(0, 10)
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    let clicked = 0;
    for (const el of controls.slice(0, 3)) {
      try {
        (el as HTMLElement).click();
        clicked += 1;
      } catch {
        // Ignore stale or non-clickable controls; existing anchors may already
        // contain the contact data.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { present: controls.length > 0, clicked, labels };
  });
}

/**
 * Signal counts extracted from a candidate panel subtree. Pure data, so the
 * scoring function is unit-testable without a DOM.
 *
 * Why this is its own type instead of an inlined object: the
 * `findPanel` decision is a *scored selection* over ancestors, and the
 * audit's documented failure mode is exactly the case where the
 * "smallest h1 ancestor that has any contact-like anchor" picks the
 * narrow header block (only "Проехать" / "Записаться" / "Позвонить" CTAs)
 * instead of the broader detail panel that actually carries the
 * address, mailto, real tel, website, and messenger labels. The signals
 * below mirror the audit's positive/negative checklist so the scoring
 * can be re-derived from the audit without re-reading the DOM code.
 */
export interface PanelSignals {
  addressAnchors: number;
  telAnchorsWithDigits: number;
  telAnchorsTotal: number;
  mailtoAnchors: number;
  websiteAnchors: number;
  revealButtons: number;
  messengerMatches: number;
  routeLinks: number;
}

export interface PanelGeometry {
  width: number;
  height: number;
}

/**
 * Hard upper bounds for the panel bounding box. Any candidate larger than
 * this is treated as having already bled into the page chrome
 * (header / list / sidebar / footer) and is rejected. The values match
 * the audit's "not a tiny header-only block" requirement on the low end
 * and stay well below a desktop document body on the high end so a
 * full-page container never wins over a real panel.
 */
const PANEL_MIN_WIDTH = 200;
const PANEL_MIN_HEIGHT = 200;
const PANEL_MAX_WIDTH = 1400;
const PANEL_MAX_HEIGHT = 2500;

/**
 * A panel must clear this score to be considered scoped. Below this
 * threshold, no ancestor looks like a real firm detail block (e.g. only
 * nav / route links) and the snapshot falls back to `document` so the
 * caller can fail loud.
 */
export const MIN_PANEL_SCORE = 5;

/**
 * Score a candidate ancestor purely on the signals it contains and its
 * bounding box. No DOM access here — the counts come from
 * {@link collectPanelSignals}. Exported so the unit tests can pin the
 * scoring curve without spinning up a browser.
 *
 * Positive weights (audit signals):
 *  - `/geo/` address anchor is the strongest single "this is the firm
 *    detail panel" indicator on 2GIS, since the address link is the
 *    only place 2GIS wraps the firm address in a `/geo/` anchor.
 *  - `tel:` with digits and `mailto:` are firm contact anchors. A bare
 *    `tel:` (no digits) is a masked phone and is *not* counted.
 *  - Website anchors that don't point at 2gis are firm domains.
 *  - "Показать телефон" / "Показать контакт" buttons only live inside
 *    the firm detail block.
 *  - Messenger labels (WhatsApp / Telegram / Viber / Max) only live in
 *    the contact section.
 *
 * Negative weights (avoid signals):
 *  - Route/booking CTA links point at `2gis.ru` route or booking
 *    endpoints and belong to the header block, not the contact block.
 *  - An ancestor with no address anchor, no mailto, and no digit tel
 *    looks like a header-only block; it gets a flat penalty so a small
 *    "Позвонить" CTA above the contact section never wins.
 */
export function scorePanelCandidate(signals: PanelSignals, geometry: PanelGeometry): number {
  const { width, height } = geometry;
  if (width < PANEL_MIN_WIDTH || height < PANEL_MIN_HEIGHT) return Number.NEGATIVE_INFINITY;
  if (width > PANEL_MAX_WIDTH || height > PANEL_MAX_HEIGHT) return Number.NEGATIVE_INFINITY;

  let score = 0;

  score += signals.addressAnchors * 10;
  score += signals.telAnchorsWithDigits * 5;
  score += signals.mailtoAnchors * 5;
  score += signals.websiteAnchors * 3;
  score += signals.revealButtons * 4;
  score += Math.min(signals.messengerMatches, 4) * 2;

  score -= signals.routeLinks * 3;

  if (
    signals.addressAnchors === 0 &&
    signals.mailtoAnchors === 0 &&
    signals.telAnchorsWithDigits === 0
  ) {
    score -= 8;
  }

  if (width >= 400 && height >= 300) score += 2;
  if (width >= 600 && height >= 400) score += 3;
  if (width >= 800 && height >= 500) score += 4;

  return score;
}

/**
 * Count firm-detail signals inside a candidate subtree. Pure DOM access
 * — no extraction of values, only counts. Exported for direct unit
 * testing with a synthetic DOM (the integration test exercises the full
 * walk via `collectDomFirmSnapshot`).
 */
export function collectPanelSignals(candidate: Element): PanelSignals {
  const addressAnchors = candidate.querySelectorAll("a[href*='/geo/']").length;

  const telNodes = [...candidate.querySelectorAll("a[href^='tel:']")];
  const telAnchorsTotal = telNodes.length;
  const telAnchorsWithDigits = telNodes.filter((node) => {
    const raw = node.getAttribute("href") ?? "";
    if (!raw.toLowerCase().startsWith("tel:")) return false;
    return /\d/.test(decodeURIComponent(raw).slice(4));
  }).length;

  const mailtoAnchors = candidate.querySelectorAll("a[href^='mailto:']").length;

  const websiteAnchors = [...candidate.querySelectorAll("a[href^='http']")].filter((node) => {
    try {
      const host = new URL(node.getAttribute("href") ?? "").hostname.toLowerCase();
      return !is2GisLikeHost(host);
    } catch {
      return false;
    }
  }).length;

  const revealRe = /Показать\s+(?:телефон|телефоны|контакт|контакты)/i;
  const revealButtons = [...candidate.querySelectorAll("button, [role='button']")]
    .filter((node) => revealRe.test((node.textContent ?? "").replace(/\s+/g, " ").trim()))
    .length;

  const messengerRe = /(?:whats?app|телеграм|telegram|viber|\bmax\b)/i;
  let messengerMatches = 0;
  for (const node of candidate.querySelectorAll("a, [aria-label]")) {
    const haystack = `${node.textContent ?? ""}\n${node.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (messengerRe.test(haystack)) messengerMatches += 1;
  }

  const routeRe = /(?:routing|route|booking|onelinek|onelink|proehat|proezd|marshrut)/i;
  const ctaTextRe = /Проехать|Записаться|Схема\s+проезда|Как\s+добраться|Открыть\s+в\s+приложении/i;
  const routeLinks = [...candidate.querySelectorAll("a[href]")].filter((node) => {
    const href = node.getAttribute("href") ?? "";
    if (routeRe.test(href)) return true;
    const text = (node.textContent ?? "").trim();
    return ctaTextRe.test(text);
  }).length;

  return {
    addressAnchors,
    telAnchorsWithDigits,
    telAnchorsTotal,
    mailtoAnchors,
    websiteAnchors,
    revealButtons,
    messengerMatches,
    routeLinks
  };
}

function is2GisLikeHost(host: string): boolean {
  return /(^|\.)2gis\./i.test(host) || /(^|\.)dgis\./i.test(host);
}

/**
 * Collect a structured snapshot of the firm detail panel.
 *
 * Scoping strategy (no obfuscated CSS classes — only semantic / stable hooks):
 *  1. Find every visible `<h1>`; the firm name is the longest visible h1.
 *  2. Look for an `<article>` element. If one is in bounds and clears the
 *     minimum-score gate, use it as the panel scope.
 *  3. Otherwise walk up from each visible firm h1, score every ancestor
 *     with the inlined copy of `scorePanelCandidate`, and pick the
 *     highest-scoring container. The score rewards /geo/ address anchors,
 *     mailto:, digit-bearing tel: anchors, external website anchors,
 *     "Показать телефон" reveal buttons and messenger labels; it penalises
 *     route/booking CTA links and header-only blocks that carry none of
 *     the firm-detail signals. The walk stops once an ancestor has bled
 *     into the page chrome.
 *  4. When no panel container clears the gate, the snapshot is collected
 *     from `document` and `scope: "document"` is set so the caller can
 *     detect that scoping never resolved.
 *
 * The DOM-touching helpers (signal collection, scoring walk, CTA
 * filter) are inlined inside the `page.evaluate` callback on purpose:
 * Playwright serialises the function and runs it in the browser page
 * context, so any reference to a top-level helper in the Node module
 * (even a pure one) becomes a `ReferenceError` at runtime. The pure
 * `scorePanelCandidate` is exported for unit tests; the live version
 * here mirrors the weights one-to-one so the test pins the exact curve
 * that runs against real 2GIS pages.
 */
async function collectDomFirmSnapshot(page: Page): Promise<DomFirmSnapshot> {
  return page.evaluate(() => {
    const title = document.title;
    const href = location.href;

    const visibleH1s = [...document.querySelectorAll("h1")].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const h1 = visibleH1s
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 5);

    const PANEL_MIN_WIDTH = 200;
    const PANEL_MIN_HEIGHT = 200;
    const PANEL_MAX_WIDTH = 1400;
    const PANEL_MAX_HEIGHT = 2500;
    const MIN_PANEL_SCORE = 5;

    const is2GisLikeHost = (host: string): boolean =>
      /(^|\.)2gis\./i.test(host) || /(^|\.)dgis\./i.test(host);

    const collectSignals = (candidate: Element): PanelSignals => {
      const addressAnchors = candidate.querySelectorAll("a[href*='/geo/']").length;

      const telNodes = [...candidate.querySelectorAll("a[href^='tel:']")];
      const telAnchorsTotal = telNodes.length;
      const telAnchorsWithDigits = telNodes.filter((node) => {
        const raw = node.getAttribute("href") ?? "";
        if (!raw.toLowerCase().startsWith("tel:")) return false;
        return /\d/.test(decodeURIComponent(raw).slice(4));
      }).length;

      const mailtoAnchors = candidate.querySelectorAll("a[href^='mailto:']").length;

      const websiteAnchors = [...candidate.querySelectorAll("a[href^='http']")].filter((node) => {
        try {
          const host = new URL(node.getAttribute("href") ?? "").hostname.toLowerCase();
          return !is2GisLikeHost(host);
        } catch {
          return false;
        }
      }).length;

      const revealRe = /Показать\s+(?:телефон|телефоны|контакт|контакты)/i;
      const revealButtons = [...candidate.querySelectorAll("button, [role='button']")]
        .filter((node) => revealRe.test((node.textContent ?? "").replace(/\s+/g, " ").trim()))
        .length;

      const messengerRe = /(?:whats?app|телеграм|telegram|viber|\bmax\b)/i;
      let messengerMatches = 0;
      for (const node of candidate.querySelectorAll("a, [aria-label]")) {
        const haystack = `${node.textContent ?? ""}\n${node.getAttribute("aria-label") ?? ""}`.toLowerCase();
        if (messengerRe.test(haystack)) messengerMatches += 1;
      }

      const routeRe = /(?:routing|route|booking|onelinek|onelink|proehat|proezd|marshrut)/i;
      const ctaTextRe = /Проехать|Записаться|Схема\s+проезда|Как\s+добраться|Открыть\s+в\s+приложении/i;
      const routeLinks = [...candidate.querySelectorAll("a[href]")].filter((node) => {
        const href = node.getAttribute("href") ?? "";
        if (routeRe.test(href)) return true;
        const text = (node.textContent ?? "").trim();
        return ctaTextRe.test(text);
      }).length;

      return {
        addressAnchors,
        telAnchorsWithDigits,
        telAnchorsTotal,
        mailtoAnchors,
        websiteAnchors,
        revealButtons,
        messengerMatches,
        routeLinks
      };
    };

    const scoreCandidate = (signals: PanelSignals, geometry: PanelGeometry): number => {
      const { width, height } = geometry;
      if (width < PANEL_MIN_WIDTH || height < PANEL_MIN_HEIGHT) return Number.NEGATIVE_INFINITY;
      if (width > PANEL_MAX_WIDTH || height > PANEL_MAX_HEIGHT) return Number.NEGATIVE_INFINITY;

      let score = 0;
      score += signals.addressAnchors * 10;
      score += signals.telAnchorsWithDigits * 5;
      score += signals.mailtoAnchors * 5;
      score += signals.websiteAnchors * 3;
      score += signals.revealButtons * 4;
      score += Math.min(signals.messengerMatches, 4) * 2;
      score -= signals.routeLinks * 3;

      if (
        signals.addressAnchors === 0 &&
        signals.mailtoAnchors === 0 &&
        signals.telAnchorsWithDigits === 0
      ) {
        score -= 8;
      }

      if (width >= 400 && height >= 300) score += 2;
      if (width >= 600 && height >= 400) score += 3;
      if (width >= 800 && height >= 500) score += 4;

      return score;
    };

    const selectScoredPanel = (visible: Element[]): { panel: Element | null; isScoped: boolean } => {
      const article = document.querySelector("article");
      if (article) {
        const rect = article.getBoundingClientRect();
        if (
          rect.width >= PANEL_MIN_WIDTH &&
          rect.height >= PANEL_MIN_HEIGHT &&
          rect.width <= PANEL_MAX_WIDTH &&
          rect.height <= PANEL_MAX_HEIGHT
        ) {
          const signals = collectSignals(article);
          const score = scoreCandidate(signals, { width: rect.width, height: rect.height });
          if (score >= MIN_PANEL_SCORE) {
            return { panel: article, isScoped: true };
          }
        }
      }

      let best: { panel: Element; score: number } | null = null;
      for (const h1El of visible) {
        let candidate: Element | null = h1El.parentElement;
        for (let depth = 0; depth < 10 && candidate; depth += 1) {
          const rect = candidate.getBoundingClientRect();
          if (rect.width < PANEL_MIN_WIDTH || rect.height < PANEL_MIN_HEIGHT) {
            candidate = candidate.parentElement;
            continue;
          }
          if (rect.width > PANEL_MAX_WIDTH || rect.height > PANEL_MAX_HEIGHT) {
            break;
          }
          const signals = collectSignals(candidate);
          const score = scoreCandidate(signals, { width: rect.width, height: rect.height });
          if (best === null || score > best.score) {
            best = { panel: candidate, score };
          }
          candidate = candidate.parentElement;
        }
      }

      if (best !== null && best.score >= MIN_PANEL_SCORE) {
        return { panel: best.panel, isScoped: true };
      }
      return { panel: null, isScoped: false };
    };

    const isRouteOrBookingTelAnchor = (anchor: HTMLAnchorElement): boolean => {
      const raw = (anchor.getAttribute("href") ?? "").toLowerCase();
      if (raw.startsWith("tel:") && /^tel:\+?(?:78|8)00\d{5,}/i.test(raw)) return true;
      const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
      if (/Позвонить\s+в\s+службу|Заказать\s+звонок|Связаться\s+с\s+поддержкой/i.test(text)) return true;
      return false;
    };

    const { panel, isScoped } = selectScoredPanel(visibleH1s);
    const scope: ParentNode = panel ?? document;
    // No generic type parameter here on purpose: esbuild's keepNames
    // transform wraps a generic arrow in `__name(...)`, but the helper
    // only exists in the Node runtime, not in the page context where
    // `page.evaluate` runs.
    const $ = (selector: string): Element[] => [...scope.querySelectorAll(selector)];

    const linkRecord = (el: HTMLAnchorElement): DomFirmLink => ({
      href: el.href,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      ariaLabel: el.getAttribute("aria-label")?.trim() ?? ""
    });

    const telAnchors = $("a[href^='tel:']");
    const firmTelAnchors = telAnchors.filter((el) => !isRouteOrBookingTelAnchor(el as HTMLAnchorElement));
    const telLinks = firmTelAnchors.map((el) => linkRecord(el as HTMLAnchorElement));
    const mailtoLinks = $("a[href^='mailto:']").map((el) => linkRecord(el as HTMLAnchorElement));
    const addressLinks = $("a[href*='/geo/']").map((el) => linkRecord(el as HTMLAnchorElement));
    const httpLinks = $("a[href^='http']").map((el) => linkRecord(el as HTMLAnchorElement));
    const allAnchors = $("a[href]").map((el) => linkRecord(el as HTMLAnchorElement));

    // Buttons are not panel-scoped on purpose: the reveal click happens
    // *before* the panel is confirmed, and a "Показать телефон" button that
    // lives next to the h1 (sibling of the contact section) is a stronger
    // reveal signal than one buried deep in the panel tree. The button list
    // is only used to detect / count reveal controls, never as a contact
    // source, so scoping it to the panel would only hide real reveal
    // controls.
    const buttons = [...document.querySelectorAll("button, [role='button']")]
      .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 30);

    return {
      title,
      url: href,
      scope: isScoped ? "panel" : "document",
      h1,
      buttons,
      telLinks,
      mailtoLinks,
      addressLinks,
      httpLinks,
      allAnchors,
      selectorCounts: {
        h1: visibleH1s.length,
        "a[href^='tel:']": telAnchors.length,
        "a[href^='tel:']:firm": telLinks.length,
        "a[href^='mailto:']": mailtoLinks.length,
        "a[href*='/geo/']": addressLinks.length,
        "a[href^='http']": httpLinks.length
      }
    } satisfies DomFirmSnapshot;
  });
}

export function buildDomFirmPayload(
  snapshot: DomFirmSnapshot,
  card: RawCompanyCard,
  fallbackCategory: string,
  fallbackCity: string,
  reveal: ContactRevealEvidence = { present: false, clicked: 0, labels: [] }
): { payload: Record<string, unknown>; debug: Record<string, unknown> } {
  const titleParts = parse2GisTitle(snapshot.title, fallbackCity);
  const name = firstNonEmpty(snapshot.h1[0], titleParts.name, card.name);
  const category = firstNonEmpty(titleParts.category, card.category, fallbackCategory);
  const city = firstNonEmpty(titleParts.city, card.city, fallbackCity);
  const address = firstNonEmpty(extractAddressLink(snapshot), titleParts.address, card.address, "");
  const phones = uniqueStrings(snapshot.telLinks.map(extractPhoneHref));
  const email = uniqueStrings(snapshot.mailtoLinks.map(extractEmailHref))[0] ?? null;
  const website = uniqueStrings(snapshot.httpLinks.map(extractWebsiteLink))[0] ?? null;
  const messengers = extractMessengerEntries(snapshot.allAnchors);

  const contacts: Array<Record<string, string>> = [
    ...phones.map((value) => ({ type: "phone", value })),
    ...(email ? [{ type: "email", value: email }] : []),
    ...(website ? [{ type: "website", value: website, url: website }] : [])
  ];

  const payload = {
    id: card.externalId,
    type: "branch",
    name,
    category,
    city_name: city,
    address_name: address,
    rubrics: category ? [{ name: category }] : [],
    contacts,
    messengers: messengers.map((messenger) => ({ provider: messenger.provider, label: messenger.label })),
    url: stripQuery(snapshot.url),
    dom_debug: {
      scope: snapshot.scope,
      selectors: snapshot.selectorCounts,
      contactReveal: {
        present: reveal.present,
        clicked: reveal.clicked,
        labelCount: reveal.labels.length
      },
      fieldPresence: {
        name: Boolean(name),
        address: Boolean(address),
        phones: phones.length,
        email: Boolean(email),
        website: Boolean(website),
        messengers: messengers.length
      }
    }
  };

  const debug = {
    url: stripQuery(snapshot.url),
    scope: snapshot.scope,
    selectorsUsed: [
      "h1",
      "button",
      "[role='button']",
      "a[href^='tel:']",
      "a[href^='mailto:']",
      "a[href*='/geo/']",
      "a[href^='http']",
      "document.title"
    ],
    selectorCounts: snapshot.selectorCounts,
    textShape: {
      titleChars: snapshot.title.length,
      h1Count: snapshot.h1.length,
      buttonCount: snapshot.buttons.length,
      telCount: snapshot.telLinks.length,
      mailtoCount: snapshot.mailtoLinks.length,
      addressCount: snapshot.addressLinks.length,
      httpCount: snapshot.httpLinks.length
    },
    contactReveal: {
      present: reveal.present,
      clicked: reveal.clicked,
      labels: reveal.labels.map(redactContactLabel)
    },
    fieldsFound: {
      name: Boolean(name),
      address: Boolean(address),
      phones: phones.length,
      email: Boolean(email),
      website: Boolean(website),
      messengers: messengers.map((messenger) => messenger.provider)
    }
  };

  return { payload, debug };
}

function parse2GisTitle(title: string, fallbackCity: string): {
  name: string | null;
  category: string | null;
  address: string | null;
  city: string | null;
} {
  const clean = title.replace(/\s+\u2014\s+2\u0413\u0418\u0421.*$/u, "").trim();
  const parts = clean.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { name: null, category: null, address: null, city: fallbackCity || null };
  }
  const city = parts.length > 1 && !/\d/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : fallbackCity;
  const cityIndex = city === parts[parts.length - 1] ? parts.length - 1 : parts.length;
  let digitIndex = -1;
  for (let index = cityIndex - 1; index > 0; index -= 1) {
    if (/\d/.test(parts[index])) {
      digitIndex = index;
      break;
    }
  }
  const address = digitIndex > 0
    ? parts.slice(Math.max(1, digitIndex - 1), cityIndex).join(", ")
    : null;
  return {
    name: parts[0] ?? null,
    category: parts[1] ?? null,
    address,
    city
  };
}

/**
 * Pull a phone string out of a `tel:` href. Returns the empty string when
 * the href carries no digits (e.g. `tel:` for a masked phone). The presence
 * of at least one non-empty value is the signal the phone-reveal gate looks
 * for.
 */
function extractPhoneHref(link: DomFirmLink): string {
  if (!link.href.toLowerCase().startsWith("tel:")) return "";
  const decoded = decodeURIComponent(link.href.slice(4)).trim();
  return /\d/.test(decoded) ? decoded : "";
}

/**
 * True when the snapshot already carries at least one usable phone — i.e. a
 * `tel:` href with a real digit sequence. The phone-reveal gate refuses to
 * click "Показать телефон" when this is true, both to avoid pointless work
 * and to keep the adapter from clicking buttons the page is hiding behind
 * a counter. Exported so the unit tests can pin the gate's behaviour.
 */
export function hasUsableTelLink(snapshot: DomFirmSnapshot): boolean {
  return snapshot.telLinks.some((link) => extractPhoneHref(link).length > 0);
}

function revealEvidenceFromButtons(buttons: string[], clicked: boolean): ContactRevealEvidence {
  const revealRe = new RegExp(
    [
      "\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c\\s+\\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d",
      "\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c\\s+\\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d\\u044b",
      "\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c\\s+\\u043a\\u043e\\u043d\\u0442\\u0430\\u043a\\u0442",
      "\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c\\s+\\u043a\\u043e\\u043d\\u0442\\u0430\\u043a\\u0442\\u044b"
    ].join("|"),
    "i"
  );
  const labels = buttons.filter((button) => revealRe.test(button)).slice(0, 10);
  return { present: labels.length > 0, clicked: clicked ? labels.length : 0, labels };
}

function extractEmailHref(link: DomFirmLink): string {
  if (!link.href.toLowerCase().startsWith("mailto:")) return "";
  const decoded = decodeURIComponent(link.href.slice(7).split("?")[0]).trim();
  return decoded.includes("@") ? decoded : "";
}

function extractWebsiteLink(link: DomFirmLink): string {
  // Prefer the visible domain text. 2GIS serves the firm's real domain as
  // the link's *text* and wraps the click target in a `link.2gis.ru`
  // tracking redirect; trusting the href would persist the redirect
  // (and the per-session token in its query string).
  const textUrl = websiteFromText(link.text);
  if (textUrl) return textUrl;
  const textAriaUrl = link.ariaLabel ? websiteFromText(link.ariaLabel) : null;
  if (textAriaUrl) return textAriaUrl;
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return "";
  }
  if (isBlockedWebsiteHost(url.hostname)) return "";
  if (!/\./.test(url.hostname)) return "";
  return `${url.protocol}//${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
}

/**
 * Address is taken from the firm detail panel's geo anchor — 2GIS wraps the
 * visible address in `<a href="/geo/…">` and the link text is the human-
 * readable address. Falling back to the title-parsed / card-supplied
 * address only happens when the panel has no geo anchor at all (older pages
 * or pages where the address renders as plain text inside a `<span>`).
 */
function extractAddressLink(snapshot: DomFirmSnapshot): string {
  for (const link of snapshot.addressLinks) {
    const text = link.text;
    if (text) return text;
  }
  return "";
}

function extractMessengerEntries(anchors: DomFirmLink[]): DomFirmMessenger[] {
  const out: DomFirmMessenger[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const provider = matchMessengerProvider(anchor);
    if (!provider) continue;
    if (seen.has(provider)) continue;
    seen.add(provider);
    out.push({ provider, label: provider });
  }
  return out;
}

function matchMessengerProvider(link: DomFirmLink): string | null {
  const haystack = `${link.text} ${link.ariaLabel} ${link.href}`.toLowerCase();
  for (const entry of MESSENGER_PROVIDERS) {
    if (entry.re.test(haystack)) return entry.provider;
    if (entry.hrefRe && entry.hrefRe.test(haystack)) return entry.provider;
  }
  return null;
}

function websiteFromText(text: string): string | null {
  if (!text || /\s/.test(text) || text.includes("@")) return null;
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(text)) return null;
  const value = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    if (isBlockedWebsiteHost(new URL(value).hostname)) return null;
  } catch {
    return null;
  }
  return value;
}

function canonicalFirmUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/firm\/(\d+)/);
    if (!match) return null;
    return `${parsed.origin}${parsed.pathname.slice(0, match.index ?? parsed.pathname.length)}/firm/${match[1]}`;
  } catch {
    return null;
  }
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

function is2GisHost(hostname: string): boolean {
  return /(^|\.)2gis\./i.test(hostname) || /(^|\.)dgis\./i.test(hostname);
}

function isBlockedWebsiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    is2GisHost(host) ||
    host === "otello.ru" ||
    host.endsWith(".otello.ru") ||
    host === "2gis.onelink.me" ||
    host === "onelink.me"
  );
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function redactContactLabel(label: string): string {
  return label.replace(/(?:\+?\d[\d\s().-]{5,}\d)/g, "<phone>");
}

function getRecordString(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isBlockLikeError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("captcha") ||
    lower.includes("blocked") ||
    lower.includes("soft_blocked") ||
    lower.includes("throttled") ||
    lower.includes("403") ||
    lower.includes("429")
  );
}

function withDetailDiagnostics(detail: RawCardDetail, diagnostics: RawDetailDiagnostics): RawCardDetail {
  return {
    ...detail,
    detailDiagnostics: diagnostics
  };
}

function classifyDetailDomFailure(message: string): RawDetailDegradationReason {
  const lower = message.toLowerCase();
  if (lower.includes("err_tunnel") || lower.includes("tunnel")) return "tunnel_failure";
  if (lower.includes("proxy")) return "proxy_failure";
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (
    lower.includes("net::") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("socket hang up")
  ) {
    return "network_failure";
  }
  if (lower.includes("navigation") || lower.includes("browser") || lower.includes("page.goto")) {
    return "browser_error";
  }
  return "unknown";
}

function isSparseDetailPayload(payload: Record<string, unknown>): boolean {
  return !hasDetailSignal(payload);
}

function hasDetailSignal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDetailSignal);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (
      /^(address|address_name|full_address|phone|phones|contact|contacts|contact_groups|email|website|site|rubric|rubrics|schedule|city_name)$/i.test(key) &&
      hasTruthyDetailValue(child)
    ) {
      return true;
    }
    if (hasDetailSignal(child)) return true;
  }
  return false;
}

function hasTruthyDetailValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

function isRetryableDetailDomError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("navigation") ||
    lower.includes("net::") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("socket hang up")
  );
}

function randomDelay([min, max]: [number, number]): number {
  return Math.floor(min + Math.random() * Math.max(1, max - min));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function dedupeCards(cards: RawCompanyCard[]): RawCompanyCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (seen.has(card.externalId)) return false;
    seen.add(card.externalId);
    return true;
  });
}

/**
 * Lightweight listener for `markers/clustered` responses, kept
 * deliberately separate from {@link ApiCapture} so the strict primary
 * capture path stays untouched. The mapper rejects the composite
 * `id` format (`<numeric>_<hash>`) and the missing context fields
 * (address_name, contact_groups, etc.) — that is by design and we
 * must not paper over it here. The hybrid DOM-fallback path
 * consumes the raw payloads as a *supplement* (see
 * {@link collectFirmCardsViaScroll}'s `markersPayloads` option), so
 * the values exposed by this listener are only ever used as a
 * post-loop top-up and never feed the primary discovery contract.
 *
 * The URL allowlist is path-shaped (`/3.0/markers/clustered`) so
 * unrelated endpoints never slip in. We deliberately do not parse
 * or validate the payload here — the synthesis helper in
 * `discoveryFallback.ts` owns the structural rules and the unit
 * tests pin them. Streaming / partial JSON responses are dropped
 * silently (same posture as `ApiCapture`).
 */
class MarkersResponseListener {
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
    if (!MARKERS_CLUSTERED_PATH_RE.test(url)) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("json")) return;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return;
    }
    this.payloads.push(body);
    this.urls.push(safeMarkersUrl(url));
  }
}

const MARKERS_CLUSTERED_PATH_RE = /catalog\.api\.(?:2gis|dgis)\.ru\/3\.0\/markers\/clustered\b/;

function safeMarkersUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "<unparsable-url>";
  }
}
