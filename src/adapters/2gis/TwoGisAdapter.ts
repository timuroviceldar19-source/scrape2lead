import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserSessionManager } from "../../browser/browserSessionManager.js";
import type { ISourceAdapter, RawCardDetail, RawCompanyCard, RawContacts, RuntimeConfig, SearchQuery, SourceCapabilities } from "../../types.js";
import { logger } from "../../logger.js";
import { ApiCapture } from "./apiCapture.js";
import { extractCardsFromPayload, findDetailPayload, mapContacts, mapDetail, toLead } from "./mapper.js";
import { classifySoftBlock, SoftBlockError, type SoftBlockClassification, type SoftBlockEvidence } from "./softBlock.js";

export class TwoGisAdapter implements ISourceAdapter {
  readonly source = "2gis";
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
      const cards = extractCardsFromPayload(payload, query.category, query.geo).slice(0, query.limit);
      this.assertFirmCards(cards, `fixture ${this.config.fixturePath}`);
      return cards;
    }

    const page = await this.browserSession.newPage();
    const capture = new ApiCapture();
    capture.attach(page);

    const url = buildSearchUrl(query.geo, query.category);
    logger.info("opening 2GIS search", { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await this.detectCaptcha(page);
    await this.scrollResults(page, query.limit);

    this.lastPayloads = capture.values();
    this.writeSnapshot("api-capture", this.lastPayloads);
    const captured = this.lastPayloads.flatMap((payload) => extractCardsFromPayload(payload, query.category, query.geo));
    if (captured.length > 0) {
      await page.close();
      return dedupeCards(captured).slice(0, query.limit);
    }

    const softBlock = await this.detectSoftBlock(page, capture.softBlockEvidence());
    if (softBlock) {
      await this.throwSoftBlock(page, softBlock);
    }

    const fallback = await this.domFallback(page, query);
    await page.close();
    // Validation guard: if neither API capture nor the DOM fallback produced a
    // single real firm card, fail loudly with an extraction-quality error
    // rather than enqueuing UI/map/promo junk as company_tasks.
    this.assertFirmCards(fallback, `${this.lastPayloads.length} captured payload(s)`);
    return fallback;
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
    const payload = findDetailPayload(this.lastPayloads, card.externalId) ?? asRecord(card.payload);
    return mapDetail(card, payload);
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

  private async domFallback(page: Page, query: SearchQuery): Promise<RawCompanyCard[]> {
    logger.warn("api capture returned no cards; using DOM fallback");
    const cards = await page.evaluate(({ category, geo }) => {
      const anchors = [...document.querySelectorAll("a[href*='/firm/'], a[href*='/branches/']")];
      return anchors.map((anchor) => {
        const element = anchor as HTMLAnchorElement;
        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const href = element.href;
        const id = href.match(/(?:firm|branches)\/(\d+)/)?.[1] ?? href;
        return {
          source: "2gis",
          externalId: id,
          name: text || id,
          category,
          city: geo,
          address: "",
          url: href,
          payload: { href, text }
        };
      });
    }, { category: query.category, geo: query.geo });
    return dedupeCards(cards).slice(0, query.limit);
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

function buildSearchUrl(geo: string, category: string): string {
  return `https://2gis.ru/${encodeURIComponent(geo)}/search/${encodeURIComponent(category)}`;
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
