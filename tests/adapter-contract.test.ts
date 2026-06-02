import { describe, expect, it } from "vitest";
import { TwoGisAdapter } from "../src/adapters/2gis/index.js";
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
    const cards = await adapter.searchCompanies(config);
    const detail = await adapter.getCardDetail(cards[0]);
    const contacts = await adapter.getContacts(detail);
    const lead = adapter.normalize(detail, contacts);

    expect(lead.source).toBe("2gis");
    expect(lead.external_id).toBe(cards[0].externalId);
  });
});
