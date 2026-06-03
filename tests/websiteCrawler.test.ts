import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichLeadFromWebsite } from "../src/enrichment/websiteCrawler.js";
import type { Lead } from "../src/types.js";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    source: "2gis",
    external_id: "ext-1",
    company_name: "Company",
    category: "auto",
    city: "nsk",
    address: "",
    phones: ["+71234567890"],
    email: null,
    website: "https://example.com",
    social_links: [],
    messenger_links: [],
    parsed_at: new Date(0).toISOString(),
    incomplete: false,
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("website crawl enrichment", () => {
  it("skips leads without website or with an existing email", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const noWebsite = await enrichLeadFromWebsite(lead({ website: null }));
    const hasEmail = await enrichLeadFromWebsite(lead({ email: "info@example.com" }));

    expect(noWebsite.telemetry.attempted).toBe(false);
    expect(hasEmail.telemetry.attempted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("extracts email and messenger labels from bounded website pages", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === "https://example.com/") {
        return new Response("<html><a href='https://wa.me/79991112233'>WhatsApp</a></html>", {
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("<a href='mailto:sales@example.com'>sales@example.com</a>", {
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await enrichLeadFromWebsite(lead(), { maxPages: 2, timeoutMs: 100 });

    expect(result.lead.email).toBe("sales@example.com");
    expect(result.lead.messenger_links).toEqual(["WhatsApp"]);
    expect(result.telemetry).toMatchObject({
      attempted: true,
      succeeded: true,
      emailFound: true,
      messengersFound: 1,
      pagesVisited: 2
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
