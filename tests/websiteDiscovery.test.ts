import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverLeadWebsite } from "../src/enrichment/websiteDiscovery.js";
import type { Lead } from "../src/types.js";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    source: "2gis",
    external_id: "ext-1",
    company_name: "Good Auto",
    category: "autoservice",
    city: "Novosibirsk",
    address: "Lenina 1",
    phones: ["+71234567890"],
    email: null,
    website: null,
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

describe("website discovery enrichment", () => {
  it("skips disabled policy and leads that already have website or email", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await discoverLeadWebsite(lead(), { enabled: false });
    await discoverLeadWebsite(lead({ website: "https://known.example" }), { enabled: true });
    await discoverLeadWebsite(lead({ email: "info@example.com" }), { enabled: true });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects aggregators and accepts a validated official website", async () => {
    const officialRedirect = `https://www.bing.com/ck/a?u=a1${
      Buffer.from("https://good-auto.example/contacts?utm=ad", "utf8").toString("base64url")
    }`;
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("duckduckgo.com/html")) {
        return new Response(
          [
            "<a href='https://2gis.ru/novosibirsk/firm/1'>Good Auto 2GIS</a>",
            "<a href='https://asktel.ru/novosibirsk/avtoservis/good_auto'>Good Auto directory page</a>",
            `<a href='${officialRedirect}'>Good Auto official site</a>`
          ].join("\n"),
          { headers: { "content-type": "text/html" } }
        );
      }
      if (url === "https://asktel.ru/novosibirsk/avtoservis/good_auto") {
        return new Response("Good Auto Novosibirsk Lenina 1 +7 123 456-78-90", {
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://good-auto.example/contacts") {
        return new Response("Good Auto Novosibirsk Lenina 1 +7 123 456-78-90", {
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await discoverLeadWebsite(lead(), {
      enabled: true,
      maxSearches: 1,
      maxCandidates: 2,
      timeoutMs: 100
    });

    expect(result.lead.website).toBe("https://good-auto.example/contacts");
    expect(result.telemetry).toMatchObject({
      attempted: true,
      succeeded: true,
      websiteFound: true,
      searchRequests: 1,
      candidatesValidated: 1
    });
    expect(result.telemetry.candidatesRejected).toBeGreaterThanOrEqual(1);
  });

  it("rejects candidates whose pages do not match the lead", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("duckduckgo.com/html")) {
        return new Response("<a href='https://wrong.example'>Good Auto official site</a>", {
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("Different company in another city", {
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await discoverLeadWebsite(lead(), {
      enabled: true,
      maxSearches: 1,
      maxCandidates: 1,
      timeoutMs: 100
    });

    expect(result.lead.website).toBeNull();
    expect(result.telemetry.websiteFound).toBe(false);
    expect(result.telemetry.candidatesRejected).toBeGreaterThanOrEqual(1);
  });

  it("rejects exact-name pages when they have no local signal", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("duckduckgo.com/html")) {
        return new Response("<a href='https://dictionary.example/good-auto'>Good Auto</a>", {
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("Good Auto definition and generic article", {
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await discoverLeadWebsite(lead(), {
      enabled: true,
      maxSearches: 1,
      maxCandidates: 1,
      timeoutMs: 100
    });

    expect(result.lead.website).toBeNull();
    expect(result.telemetry.websiteFound).toBe(false);
  });
});
