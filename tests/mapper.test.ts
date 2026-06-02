import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { extractCardsFromPayload, mapContacts, mapDetail, toLead } from "../src/adapters/2gis/mapper.js";

describe("2GIS mapper", () => {
  it("maps captured JSON to normalized leads", () => {
    const payload = JSON.parse(fs.readFileSync("tests/fixtures/2gis-response.json", "utf8")) as unknown;
    const cards = extractCardsFromPayload(payload, "autoservice", "moscow");
    expect(cards).toHaveLength(2);

    const detail = mapDetail(cards[0], cards[0].payload as Record<string, unknown>);
    const contacts = mapContacts(detail, detail.payload);
    const lead = toLead(detail, contacts);

    expect(lead.external_id).toBe("70000001000000123");
    expect(lead.company_name).toBe("Demo Autoservice");
    expect(lead.phones).toEqual(["+77771234567"]);
    expect(lead.email).toBe("info@example.com");
    expect(lead.website).toBe("https://example.com");
    expect(lead.incomplete).toBe(false);
  });
});
