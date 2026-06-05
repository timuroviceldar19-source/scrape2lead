import type { Lead, RuntimeConfig } from "../../types.js";
import { TwoGisAdapter } from "../../adapters/2gis/TwoGisAdapter.js";
import { BrowserSessionManager } from "../../browser/browserSessionManager.js";
import type { IEnrichmentAdapter, EnrichmentRawResult } from "./EnrichmentAdapter.js";

export class TwoGisEnrichmentAdapter implements IEnrichmentAdapter {
  private browserSession: BrowserSessionManager;
  private ownsBrowserSession: boolean;

  constructor(
    private readonly config: RuntimeConfig,
    sharedBrowserSession?: BrowserSessionManager
  ) {
    if (sharedBrowserSession) {
      this.browserSession = sharedBrowserSession;
      this.ownsBrowserSession = false;
    } else {
      this.browserSession = new BrowserSessionManager(config);
      this.ownsBrowserSession = true;
    }
  }

  async enrich(lead: Lead): Promise<EnrichmentRawResult> {
    if (!lead.company_name || !lead.city) {
      return { status: "unsupported_city", source: "2gis", error_message: "Missing company_name or city" };
    }

    try {
      const enrichmentConfig: RuntimeConfig = { ...this.config, geo: lead.city, category: lead.company_name };
      const adapter = new TwoGisAdapter(enrichmentConfig, this.browserSession);

      const cards = await adapter.searchCompanies({
        source: "2gis",
        geo: lead.city,
        category: lead.company_name,
        limit: 3
      });

      if (cards.length === 0) {
        return { status: "not_found", source: "2gis" };
      }

      const topCard = cards[0];
      const detail = await adapter.getCardDetail(topCard);
      const contacts = await adapter.getContacts(detail);

      return {
        status: "found",
        source: "2gis",
        found_name: detail.name,
        phone_raw: contacts.phones?.[0],
        address_raw: detail.address,
        website_raw: contacts.website || detail.website || undefined,
        social_links_raw: contacts.socialLinks,
        enrichment_url: detail.url,
        raw_match_metadata: { category: detail.category, city: detail.city }
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isBlocked = msg.includes("CAPTCHA") || msg.includes("blocked") || msg.includes("browser-upgrade");
      return {
        status: isBlocked ? "captcha_or_blocked" : "failed",
        source: "2gis",
        error_message: msg
      };
    }
  }

  async close(): Promise<void> {
    if (this.ownsBrowserSession) {
      await this.browserSession.close();
    }
  }
}
