import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Lead, RuntimeConfig, RawCompanyCard, RawCardDetail, RawContacts } from "../../../src/types.js";
import { TwoGisEnrichmentAdapter } from "../../../src/enrichment/adapters/TwoGisEnrichmentAdapter.js";
import { TwoGisAdapter } from "../../../src/adapters/2gis/TwoGisAdapter.js";

vi.mock("../../../src/adapters/2gis/TwoGisAdapter.js");

describe("TwoGisEnrichmentAdapter", () => {
  let adapter: TwoGisEnrichmentAdapter;
  let mockTwoGisAdapter: any;

  const mockConfig: RuntimeConfig = {
    source: "2gis",
    geo: "Алматы",
    category: "test",
    limit: 10,
    databasePath: ":memory:",
    exportDir: "./data",
    delayRangeMs: [100, 200],
    rotateEveryN: 5,
    maxRetries: 3,
    concurrency: 1,
    headless: true,
    rawSnapshotDir: "./data/snapshots",
    storageBackend: "sqlite"
  };

  beforeEach(() => {
    mockTwoGisAdapter = {
      searchCompanies: vi.fn(),
      getCardDetail: vi.fn(),
      getContacts: vi.fn(),
      close: vi.fn()
    };
    vi.mocked(TwoGisAdapter).mockImplementation(() => mockTwoGisAdapter);
    adapter = new TwoGisEnrichmentAdapter(mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should return raw 'found' data when company is found", async () => {
    const lead: Lead = {
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
      incomplete: true
    };

    const mockCard: RawCompanyCard = {
      source: "2gis",
      externalId: "70000001000000123",
      name: "СтройМир",
      category: "Стройматериалы",
      city: "Алматы",
      url: "https://2gis.kz/almaty/firm/70000001000000123",
      payload: {}
    };

    const mockDetail: RawCardDetail = {
      ...mockCard,
      name: "СтройМир",
      address: "г. Алматы, пр. Абая 100"
    };

    const mockContacts: RawContacts = {
      externalId: "70000001000000123",
      phones: ["+77771234567"],
      website: "https://stroymir.kz",
      socialLinks: [],
      messengerLinks: [],
      payload: {}
    };

    mockTwoGisAdapter.searchCompanies.mockResolvedValue([mockCard]);
    mockTwoGisAdapter.getCardDetail.mockResolvedValue(mockDetail);
    mockTwoGisAdapter.getContacts.mockResolvedValue(mockContacts);

    const result = await adapter.enrich(lead);

    expect(result.status).toBe("found");
    expect(result.source).toBe("2gis");
    expect(result.found_name).toBe("СтройМир");
    expect(result.phone_raw).toBe("+77771234567");
    expect(result.address_raw).toBe("г. Алматы, пр. Абая 100");
    expect(result.website_raw).toBe("https://stroymir.kz");
  });

  it("should return 'not_found' when no firms are returned", async () => {
    const lead: Lead = {
      source: "kaspi",
      external_id: "123",
      company_name: "Несуществующая Компания",
      category: "IT",
      city: "Астана",
      address: "",
      phones: [],
      email: null,
      website: null,
      social_links: [],
      messenger_links: [],
      parsed_at: new Date().toISOString(),
      incomplete: true
    };

    mockTwoGisAdapter.searchCompanies.mockResolvedValue([]);

    const result = await adapter.enrich(lead);

    expect(result.status).toBe("not_found");
  });

  it("should return 'unsupported_city' when company_name or city is missing", async () => {
    const lead: Lead = {
      source: "kaspi",
      external_id: "123",
      company_name: "Тест",
      category: "IT",
      city: "",
      address: "",
      phones: [],
      email: null,
      website: null,
      social_links: [],
      messenger_links: [],
      parsed_at: new Date().toISOString(),
      incomplete: true
    };

    const result = await adapter.enrich(lead);

    expect(result.status).toBe("unsupported_city");
    expect(result.error_message).toBe("Missing company_name or city");
  });

  it("should return 'captcha_or_blocked' when 2GIS blocks the request", async () => {
    const lead: Lead = {
      source: "kaspi",
      external_id: "123",
      company_name: "Тест",
      category: "IT",
      city: "Алматы",
      address: "",
      phones: [],
      email: null,
      website: null,
      social_links: [],
      messenger_links: [],
      parsed_at: new Date().toISOString(),
      incomplete: true
    };

    mockTwoGisAdapter.searchCompanies.mockRejectedValue(new Error("CAPTCHA detected"));

    const result = await adapter.enrich(lead);

    expect(result.status).toBe("captcha_or_blocked");
    expect(result.error_message).toContain("CAPTCHA");
  });
});
