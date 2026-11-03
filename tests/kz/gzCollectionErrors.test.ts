import { describe, expect, it } from "vitest";
import { assertPortalResponse, isTransientNetworkError, GzCollectionState } from "../../src/kz/gzCollection.js";

describe("transient portal error classification", () => {
  it.each(["net::ERR_CONNECTION_TIMED_OUT", "ERR_CONNECTION_RESET", "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT",
    "page.goto: Timeout 90000ms exceeded", "fetch failed", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "socket hang up"])("recognizes %s", message => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
  });
  it("recognizes native TimeoutError and nested network causes", () => {
    const error = new Error("navigation expired"); error.name = "TimeoutError";
    expect(isTransientNetworkError(error)).toBe(true);
    expect(isTransientNetworkError(new Error("request failed", { cause: Object.assign(new Error("dns"), { code: "EAI_AGAIN" }) }))).toBe(true);
  });
  it.each([new TypeError("invalid schema"), new Error("invalid parameter"), new Error("ENOENT"), null, undefined, 42])("does not classify %s as transient", error => {
    expect(isTransientNetworkError(error)).toBe(false);
  });
  it("validates breaker configuration", () => {
    expect(() => new GzCollectionState(0)).toThrow(/positive integer/);
    expect(() => new GzCollectionState(1.5)).toThrow(/positive integer/);
  });
  it("classifies HTTP 429/503 as transient but rejects HTTP 400 as a fatal request error", () => {
    for (const status of [429, 503]) {
      try { assertPortalResponse({ status: () => status }); expect.unreachable(); }
      catch (error) { expect(isTransientNetworkError(error)).toBe(true); }
    }
    try { assertPortalResponse({ status: () => 400 }); expect.unreachable(); }
    catch (error) { expect(isTransientNetworkError(error)).toBe(false); }
    expect(() => assertPortalResponse({ status: () => 200 })).not.toThrow();
  });
});
