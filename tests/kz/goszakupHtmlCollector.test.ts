import { describe, expect, it } from "vitest";
import { buildGoszakupHtmlPageUrl } from "../../src/kz/goszakupHtmlCollector.js";

describe("buildGoszakupHtmlPageUrl", () => {
  it("adds count_record on the first page", () => {
    expect(buildGoszakupHtmlPageUrl("https://goszakup.gov.kz/ru/registry/contract?filter[supplier]=123"))
      .toBe("https://goszakup.gov.kz/ru/registry/contract?filter[supplier]=123&count_record=50");
  });

  it("adds page index for subsequent pages", () => {
    expect(buildGoszakupHtmlPageUrl("https://goszakup.gov.kz/ru/registry/contract?filter[supplier]=123", 2))
      .toBe("https://goszakup.gov.kz/ru/registry/contract?filter[supplier]=123&count_record=50&page=2");
  });
});
