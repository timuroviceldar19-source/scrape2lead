import { describe, expect, it } from "vitest";
import {
  buildGzPlanOriginId,
  extractLegacyGzPlanIdFromUrl,
  extractGzPlanPointIdFromUrl,
  parseGzPlanLinkIdentity,
  resolveGzPlanPointId
} from "../../src/kz/gzPlanIdentity.js";

describe("extractGzPlanPointIdFromUrl", () => {
  it("uses the first show_plan segment even when the second segment collides", () => {
    const panel = "https://goszakup.gov.kz/ru/registry/show_plan/87018653/4775438";
    const monitor = "https://goszakup.gov.kz/ru/registry/show_plan/87018811/4775438";

    expect(extractGzPlanPointIdFromUrl(panel)).toBe("87018653");
    expect(extractGzPlanPointIdFromUrl(monitor)).toBe("87018811");
  });

  it("supports legacy one-segment show_plan links", () => {
    expect(extractGzPlanPointIdFromUrl("https://goszakup.gov.kz/ru/registry/show_plan/87018653"))
      .toBe("87018653");
  });

  it("exposes the old second segment only for compatibility lookups", () => {
    expect(parseGzPlanLinkIdentity(
      "https://www.goszakup.gov.kz/ru/registry/show_plan/87018653/4775438?tab=x"
    )).toEqual({ planPointId: "87018653", legacyPlanId: "4775438" });
    expect(extractLegacyGzPlanIdFromUrl(
      "https://goszakup.gov.kz/ru/registry/show_plan/87018653"
    )).toBeNull();
  });

  it("rejects foreign and malformed links", () => {
    expect(extractGzPlanPointIdFromUrl("https://goszakup.gov.kz/ru/registry/show_supplier/87018653"))
      .toBeNull();
    expect(extractGzPlanPointIdFromUrl("not a url")).toBeNull();
    expect(extractGzPlanPointIdFromUrl("https://example.test/ru/registry/show_plan/1/2")).toBeNull();
  });
});

describe("resolveGzPlanPointId", () => {
  it("prefers the canonical id from the link over the legacy spreadsheet id", () => {
    expect(resolveGzPlanPointId(
      "https://goszakup.gov.kz/ru/registry/show_plan/87018653/4775438",
      "4775438"
    )).toBe("87018653");
  });

  it("falls back to a numeric spreadsheet id for old exports", () => {
    expect(resolveGzPlanPointId("", "4775438")).toBe("4775438");
    expect(buildGzPlanOriginId("4775438")).toBe("gz-plan:4775438");
    expect(resolveGzPlanPointId("", "not numeric")).toBeNull();
  });
});
