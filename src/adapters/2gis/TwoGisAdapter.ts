import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserSessionManager } from "../../browser/browserSessionManager.js";
import type { ISourceAdapter, RawCardDetail, RawCompanyCard, RawContacts, RuntimeConfig, SearchQuery, SourceCapabilities } from "../../types.js";
import { logger } from "../../logger.js";
import { ApiCapture } from "./apiCapture.js";
import { extractCardsFromPayload, findDetailPayload, mapContacts, mapDetail, toLead } from "./mapper.js";

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
      return extractCardsFromPayload(payload, query.category, query.geo).slice(0, query.limit);
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

    const fallback = await this.domFallback(page, query);
    await page.close();
    return fallback;
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
    const hasCaptcha = await page.locator("text=/captcha|капча|проверка/i").count().catch(() => 0);
    if (hasCaptcha > 0) {
      const screenshotPath = path.join(this.config.rawSnapshotDir, `captcha-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      throw new Error(`CAPTCHA detected; screenshot saved to ${screenshotPath}`);
    }
  }

  private writeSnapshot(kind: string, payload: unknown): void {
    fs.mkdirSync(this.config.rawSnapshotDir, { recursive: true });
    const filePath = path.join(this.config.rawSnapshotDir, `${kind}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
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
