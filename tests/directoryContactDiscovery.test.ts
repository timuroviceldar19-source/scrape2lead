import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverDirectoryContacts } from "../src/enrichment/directoryContactDiscovery.js";
import type { Lead } from "../src/types.js";

describe("directoryContactDiscovery", () => {
  const mockLead: Lead = {
    source: "2gis",
    external_id: "123",
    company_name: "Test Car Service",
    city: "Novosibirsk",
    address: "Lenina 1",
    phones: ["79130000000"],
    category: "Autoservice",
    messenger_links: [],
    incomplete: true,
    emails: [],
    email: ""
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("should not run if disabled", async () => {
    const result = await discoverDirectoryContacts(mockLead, { enabled: false });
    expect(result.telemetry.attempted).toBe(false);
  });

  it("should not run if lead already has email", async () => {
    const leadWithEmail = { ...mockLead, email: "existing@test.com" };
    const result = await discoverDirectoryContacts(leadWithEmail, { enabled: true });
    expect(result.telemetry.attempted).toBe(false);
  });

  it("should extract email from allowlisted directory with valid page", async () => {
    // Mock search response
    (global.fetch as any).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve('<a href="https://zoon.ru/nsk/autoservice/test/">Test Card</a>')
      })
    );

    // Mock directory page response
    (global.fetch as any).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve('Contact us at support@zoon-test.ru or call 79130000000. WhatsApp: <a href="https://wa.me/79130000000">79130000000</a>')
      })
    );

    const result = await discoverDirectoryContacts(mockLead, {
      enabled: true,
      maxSearches: 1,
      allowlist: ["zoon.ru"]
    });

    expect(result.telemetry.emailFound).toBe(true);
    expect(result.lead.email).toBe("support@zoon-test.ru");
    expect(result.lead.messenger_links).toContain("WhatsApp");
    expect(result.lead.website).toBeUndefined(); // Should NOT set website
  });

  it("should reject non-allowlisted hosts", async () => {
    // Mock search response with unknown host
    (global.fetch as any).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve('<a href="https://unknown-directory.com/test/">Test Card</a>')
      })
    );

    const result = await discoverDirectoryContacts(mockLead, {
      enabled: true,
      maxSearches: 1,
      allowlist: ["zoon.ru"]
    });

    expect(result.telemetry.succeeded).toBe(false);
    expect(result.lead.email).toBe("");
  });

  it("should reject page if identity signals do not match", async () => {
     // Mock search response
     (global.fetch as any).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve('<a href="https://zoon.ru/nsk/autoservice/test/">Test Card</a>')
      })
    );

    // Mock directory page response with WRONG phone and address
    (global.fetch as any).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve('Some other service at Marksa 10. Email: other@test.ru')
      })
    );

    const result = await discoverDirectoryContacts(mockLead, {
      enabled: true,
      maxSearches: 1,
      allowlist: ["zoon.ru"]
    });

    expect(result.telemetry.candidatesRejected).toBe(1);
    expect(result.lead.email).toBe("");
  });

  it("should extract messengers correctly", async () => {
     // Mock search response
     (global.fetch as any).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve('<a href="https://zoon.ru/test/">Test</a>')
      })
    );

    // Mock directory page
    (global.fetch as any).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve('Phone 79130000000. <a href="https://t.me/test">Telegram</a> <a href="viber://chat?number=123">Viber</a>')
      })
    );

    const result = await discoverDirectoryContacts(mockLead, { enabled: true, maxSearches: 1 });

    expect(result.lead.messenger_links).toContain("Telegram");
    expect(result.lead.messenger_links).toContain("Viber");
  });
});
