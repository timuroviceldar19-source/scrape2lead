import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Lead } from "../../src/types.js";
import { EnrichmentProcessor } from "../../src/enrichment/enrichmentProcessor.js";
import type { IEnrichmentAdapter, EnrichmentRawResult } from "../../src/enrichment/adapters/EnrichmentAdapter.js";
import type { Storage } from "../../src/storage/storage.js";

describe("EnrichmentProcessor", () => {
  let processor: EnrichmentProcessor;
  let mockAdapter: IEnrichmentAdapter;
  let mockStorage: Partial<Storage>;

  const baseLead: Lead = {
    source: "kaspi",
    external_id: "123",
    company_name: "СтройМир",
    category: "Стройматериалы",
    city: "Алматы",
    address: "",
    phones: [],
    email: null,
    website: null,
    social_links: [],
    messenger_links: [],
    parsed_at: new Date().toISOString(),
    incomplete: true,
    lead_id: "KASPI-123"
  };

  beforeEach(() => {
    mockAdapter = {
      enrich: vi.fn(),
      close: vi.fn()
    };
    mockStorage = {
      updateLeadEnrichment: vi.fn()
    };
    processor = new EnrichmentProcessor(mockAdapter, mockStorage as Storage);
  });

  it("should process lead with HIGH confidence and update DB correctly", async () => {
    const rawResult: EnrichmentRawResult = {
      status: "found",
      source: "2gis",
      found_name: "СтройМир",
      phone_raw: "+77771234567",
      address_raw: "г. Алматы, пр. Абая 100",
      website_raw: "https://stroymir.kz",
      raw_match_metadata: { category: "Стройматериалы", city: "Алматы" }
    };
    vi.mocked(mockAdapter.enrich).mockResolvedValue(rawResult);

    const decision = await processor.processLead(baseLead);

    expect(decision.confidence_level).toBe("high");
    expect(decision.crm_status).toBe("Ready to contact");
    expect(decision.next_action).toBe("Позвонить");
    expect(decision.enrichment_status).toBe("enriched");

    expect(mockStorage.updateLeadEnrichment).toHaveBeenCalledWith("KASPI-123", expect.objectContaining({
      enrichment_status: "enriched",
      crm_status: "Ready to contact",
      next_action: "Позвонить",
      phone_status: "valid",
      address_status: "valid",
      website_status: "valid"
    }));
  });

  it("should process lead with MEDIUM confidence and set manual review", async () => {
    const rawResult: EnrichmentRawResult = {
      status: "found",
      source: "2gis",
      // "СтройМастер" shares the "строй" prefix with the lead's
      // "СтройМир" but is a clearly different brand. After name
      // normalisation the similarity is ~0.64, which keeps the score
      // inside the 0.65-0.85 medium band even with all 3 channels
      // valid.
      found_name: "СтройМастер",
      phone_raw: "+77771234567",
      address_raw: "г. Алматы, пр. Абая 100",
      website_raw: "https://stroymaster.kz",
      raw_match_metadata: { category: "Стройматериалы", city: "Алматы" }
    };
    vi.mocked(mockAdapter.enrich).mockResolvedValue(rawResult);

    const decision = await processor.processLead(baseLead);

    expect(decision.confidence_level).toBe("medium");
    expect(decision.crm_status).toBe("Needs manual review");
    expect(decision.next_action).toBe("Проверить совпадение компании вручную");
    expect(decision.enrichment_status).toBe("manual_review");

    expect(mockStorage.updateLeadEnrichment).toHaveBeenCalledWith("KASPI-123", expect.objectContaining({
      enrichment_status: "manual_review",
      crm_status: "Needs manual review"
    }));
  });

  it("should process lead with LOW confidence and mark as not enough data", async () => {
    const rawResult: EnrichmentRawResult = {
      status: "found",
      source: "2gis",
      found_name: "Продукты 24", // Completely different name
      phone_raw: "",
      address_raw: "г. Алматы",
      website_raw: "",
      raw_match_metadata: { category: "Продукты", city: "Алматы" }
    };
    vi.mocked(mockAdapter.enrich).mockResolvedValue(rawResult);

    const decision = await processor.processLead(baseLead);

    expect(decision.confidence_level).toBe("low");
    expect(decision.crm_status).toBe("Not enough data");
    expect(decision.next_action).toBe("Поиск через Google или Instagram");
    expect(decision.enrichment_status).toBe("not_found");

    expect(mockStorage.updateLeadEnrichment).toHaveBeenCalledWith("KASPI-123", expect.objectContaining({
      enrichment_status: "not_found",
      crm_status: "Not enough data"
    }));
  });

  it("should handle 'not_found' status from adapter", async () => {
    const rawResult: EnrichmentRawResult = {
      status: "not_found",
      source: "2gis"
    };
    vi.mocked(mockAdapter.enrich).mockResolvedValue(rawResult);

    const decision = await processor.processLead(baseLead);

    expect(decision.enrichment_status).toBe("not_found");
    expect(decision.crm_status).toBe("Not enough data");
    expect(decision.next_action).toBe("Поиск через Google или Instagram");
  });

  it("should handle 'captcha_or_blocked' status from adapter", async () => {
    const rawResult: EnrichmentRawResult = {
      status: "captcha_or_blocked",
      source: "2gis",
      error_message: "CAPTCHA detected"
    };
    vi.mocked(mockAdapter.enrich).mockResolvedValue(rawResult);

    const decision = await processor.processLead(baseLead);

    expect(decision.enrichment_status).toBe("failed");
    expect(decision.crm_status).toBeUndefined(); // crm_status preserved, not overwritten on failure
    expect(decision.next_action).toBe("Повторить попытку позже или использовать другой источник");
  });

  it("should apply channel boost when 2+ channels valid even with low name similarity", async () => {
    const rawResult: EnrichmentRawResult = {
      status: "found",
      source: "2gis",
      found_name: "Аквилон",
      phone_raw: "+77771234567",
      address_raw: "г. Астана, ул. Куйши Дина 32",
      website_raw: "https://akvilon.kz",
      raw_match_metadata: { category: "Стройматериалы", city: "Астана" }
    };
    const akvilonLead: Lead = { ...baseLead, company_name: "Akvilon.kz", city: "Астана" };
    vi.mocked(mockAdapter.enrich).mockResolvedValue(rawResult);

    const decision = await processor.processLead(akvilonLead);

    expect(decision.confidence_level).toBe("high");
    expect(decision.crm_status).toBe("Ready to contact");
    expect(decision.enrichment_status).toBe("enriched");

    expect(mockStorage.updateLeadEnrichment).toHaveBeenCalledWith("KASPI-123", expect.objectContaining({
      enrichment_status: "enriched",
      crm_status: "Ready to contact",
      phone_status: "valid",
      address_status: "valid",
      website_status: "valid"
    }));
  });
});
