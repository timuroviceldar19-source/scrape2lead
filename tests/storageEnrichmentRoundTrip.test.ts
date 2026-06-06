import { describe, it, expect } from "vitest";
import { Storage } from "../src/storage/storage.js";
import type { Lead } from "../src/types.js";

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    source: "kaspi",
    external_id: "test-1",
    company_name: "TestCompany",
    category: "Автозапчасти",
    city: "Алматы",
    address: "ул. Тестовая 1",
    phones: ["+77771234567"],
    email: null,
    website: null,
    social_links: [],
    messenger_links: [],
    parsed_at: new Date().toISOString(),
    incomplete: false,
    lead_id: "KASPI-test-1",
    ...overrides
  };
}

describe("Storage enrichment round-trip (real SQLite :memory:)", () => {
  it("updateLeadEnrichment writes found_name, found_category, phone_raw, address_raw and listLeads reads them back", async () => {
    const storage = new Storage(":memory:");

    const lead = makeLead();
    await storage.upsertLead(lead);

    await storage.updateLeadEnrichment("KASPI-test-1", {
      enrichment_source: "2gis",
      enrichment_url: "https://2gis.kz/test",
      confidence_score: 0.95,
      enrichment_status: "enriched",
      enrichment_attempted_at: new Date().toISOString(),
      phone_raw: "+7 777 123 4567",
      phone_normalized: "+77771234567",
      phone_status: "valid",
      address_raw: "г. Алматы, ул. Тестовая 1",
      address_clean: "Алматы, Тестовая 1",
      address_status: "valid",
      real_website: "https://testcompany.kz",
      website_status: "valid",
      crm_status: "Ready to contact",
      next_action: "Позвонить",
      found_name: "ТестКомпани",
      found_category: "Автозапчасти"
    });

    const leads = await storage.listLeads();
    expect(leads).toHaveLength(1);

    const updated = leads[0];
    expect(updated.found_name).toBe("ТестКомпани");
    expect(updated.found_category).toBe("Автозапчасти");
    expect(updated.phone_raw).toBe("+7 777 123 4567");
    expect(updated.address_raw).toBe("г. Алматы, ул. Тестовая 1");
    expect(updated.confidence_score).toBe(0.95);
    expect(updated.enrichment_status).toBe("enriched");
    expect(updated.crm_status).toBe("Ready to contact");

    storage.close();
  });

  it("successful retry clears previous enrichment_error", async () => {
    const storage = new Storage(":memory:");
    const lead = makeLead({ external_id: "test-3", lead_id: "KASPI-test-3" });
    await storage.upsertLead(lead);

    await storage.updateLeadEnrichment("KASPI-test-3", {
      enrichment_status: "failed",
      enrichment_error: "CAPTCHA detected",
      enrichment_attempted_at: new Date().toISOString()
    });

    let leads = await storage.listLeads();
    expect(leads[0].enrichment_error).toBe("CAPTCHA detected");
    expect(leads[0].enrichment_status).toBe("failed");

    await storage.updateLeadEnrichment("KASPI-test-3", {
      enrichment_status: "enriched",
      enrichment_error: null,
      enrichment_attempted_at: new Date().toISOString(),
      confidence_score: 0.95,
      crm_status: "Ready to contact",
      found_name: "TestCompany"
    });

    leads = await storage.listLeads();
    expect(leads[0].enrichment_error).toBeNull();
    expect(leads[0].enrichment_status).toBe("enriched");
    expect(leads[0].crm_status).toBe("Ready to contact");

    storage.close();
  });

  it("fresh :memory: DB does not crash on updateLeadEnrichment (schema migration creates all columns)", async () => {
    const storage = new Storage(":memory:");
    const lead = makeLead({ external_id: "test-2", lead_id: "KASPI-test-2" });
    await storage.upsertLead(lead);

    await expect(
      storage.updateLeadEnrichment("KASPI-test-2", {
        found_name: "Found",
        found_category: "Cat",
        phone_raw: "+77770000000",
        address_raw: "addr",
        enrichment_status: "enriched",
        crm_status: "Ready to contact"
      })
    ).resolves.toBeUndefined();

    storage.close();
  });
});
