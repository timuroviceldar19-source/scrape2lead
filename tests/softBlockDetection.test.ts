import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { extractCardsFromPayload } from "../src/adapters/2gis/mapper.js";
import { classifySoftBlock, findSoftBlockPayloadEvidence, findSoftBlockTextEvidence } from "../src/adapters/2gis/softBlock.js";

describe("2GIS soft-block detection", () => {
  it("classifies the empty-results/add-organization page text as soft blocked", () => {
    const bodyText = fs.readFileSync("tests/fixtures/2gis-soft-block-page.txt", "utf8");
    const evidence = findSoftBlockTextEvidence(bodyText);
    expect(evidence?.reason).toBe("empty_results_text");
    expect(classifySoftBlock(bodyText, [])?.reason).toBe("soft_blocked");
  });

  it("classifies markers/clustered throttling with zero firms as throttled", () => {
    const payload = JSON.parse(fs.readFileSync("tests/fixtures/2gis-markers-throttled.json", "utf8")) as unknown;
    const evidence = findSoftBlockPayloadEvidence(payload, "catalog.api.2gis/markers/clustered");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].reason).toBe("throttled");
    expect(classifySoftBlock("", evidence)?.reason).toBe("throttled");
  });

  it("does not classify a genuine empty result without throttling as blocked", () => {
    const payload = {
      result: {
        items: [],
        search_attributes: {
          is_throttled: false,
          is_partial: false
        }
      }
    };
    expect(findSoftBlockPayloadEvidence(payload)).toEqual([]);
    expect(classifySoftBlock("Ничего не нашлось", [])).toBeNull();
  });

  it("lets a real firm payload pass normally even when search_attributes are present", () => {
    const payload = JSON.parse(fs.readFileSync("tests/fixtures/2gis-firm-results.json", "utf8")) as unknown;
    expect(findSoftBlockPayloadEvidence(payload)).toEqual([]);
    expect(extractCardsFromPayload(payload, "Автосервисы", "Новосибирск")).toHaveLength(2);
  });

  it("keeps UI/map/promo junk rejected", () => {
    const payload = JSON.parse(fs.readFileSync("tests/fixtures/2gis-map-assets.json", "utf8")) as unknown;
    expect(extractCardsFromPayload(payload, "Автосервисы", "Новосибирск")).toEqual([]);
  });
});
