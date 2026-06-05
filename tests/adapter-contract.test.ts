import { describe, expect, it } from "vitest";
import { TwoGisAdapter } from "../src/adapters/2gis/index.js";
import { KaspiAdapter } from "../src/adapters/kaspi/index.js";
import type { RuntimeConfig } from "../src/types.js";

describe("ISourceAdapter contract", () => {
  it("2GIS adapter implements required methods and fixture flow", async () => {
    const config: RuntimeConfig = {
      source: "2gis",
      geo: "moscow",
      category: "autoservice",
      limit: 1,
      databasePath: "data/test.db",
      exportDir: "exports",
      delayRangeMs: [0, 1],
      rotateEveryN: 50,
      maxRetries: 0,
      concurrency: 1,
      headless: true,
      rawSnapshotDir: "raw_snapshots",
      fixturePath: "tests/fixtures/2gis-response.json"
    };
    const adapter = new TwoGisAdapter(config);

    expect(adapter.capabilities().needsBrowser).toBe(true);
    const cards = await adapter.searchCompanies({ ...config, category: config.category ?? "" });
    const detail = await adapter.getCardDetail(cards[0]);
    const contacts = await adapter.getContacts(detail);
    const lead = adapter.normalize(detail, contacts);

    expect(lead.source).toBe("2gis");
    expect(lead.external_id).toBe(cards[0].externalId);
  });

  it("Kaspi adapter implements required methods and fixture flow", async () => {
    const config: RuntimeConfig = {
      source: "kaspi",
      geo: "Астана",
      category: "Стройматериалы и товары для ремонта",
      limit: 1,
      databasePath: "data/test-kaspi.db",
      exportDir: "exports",
      delayRangeMs: [0, 1],
      rotateEveryN: 30,
      maxRetries: 0,
      concurrency: 1,
      headless: true,
      rawSnapshotDir: "raw_snapshots",
      fixturePath: "tests/fixtures/kaspi-response.json"
    };
    const adapter = new KaspiAdapter(config);

    expect(adapter.capabilities().needsBrowser).toBe(true);
    expect(adapter.capabilities().supportsApiCapture).toBe(true);
    
    const cards = await adapter.searchCompanies({ ...config, category: config.category ?? "" });
    expect(cards.length).toBeGreaterThan(0);
    
    const detail = await adapter.getCardDetail(cards[0]);
    const contacts = await adapter.getContacts(detail);
    const lead = adapter.normalize(detail, contacts);

    expect(lead.source).toBe("kaspi");
    expect(lead.external_id).toBe(cards[0].externalId);
    expect(lead.company_name).toBe("Тестовый Стройматериалы");
    expect(lead.rating).toBe(4.8);
    expect(lead.review_count).toBe(150);
    expect(lead.product_count).toBe(1200);
    expect(lead.shop_categories).toEqual(["Стройматериалы", "Инструменты", "Сантехника"]);
    expect(lead.messenger_links).toContain("https://wa.me/77771234567");
  });
});
