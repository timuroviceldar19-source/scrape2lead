import { describe, expect, it } from "vitest";
import { assertPortalResponse, countCertificateErrors, isCertificateError, isTransientNetworkError, GzCollectionState } from "../../src/kz/gzCollection.js";

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
  it("accepts thrown network strings and safely terminates on cyclic causes", () => {
    expect(isTransientNetworkError("ECONNRESET")).toBe(true);
    const cyclic = new Error("unknown failure"); cyclic.cause = cyclic;
    expect(isTransientNetworkError(cyclic)).toBe(false);
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

describe("portal certificate errors", () => {
  it.each([
    "page.goto: net::ERR_CERT_DATE_INVALID at https://procurement.gov.kz/ru/search/lots",
    "page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://procurement.gov.kz/",
    "page.goto: net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN at https://procurement.gov.kz/",
    "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID"
  ])("recognizes %s", message => {
    expect(isCertificateError(new Error(message))).toBe(true);
  });
  it("finds a certificate code in the cause chain of Node fetch", () => {
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) });
    expect(isCertificateError(error)).toBe(true);
    // Сбор по-прежнему изолирует такую ошибку в своей ветке, но прогон её отметит.
    expect(isTransientNetworkError(error)).toBe(true);
  });
  it.each(["page.goto: net::ERR_CONNECTION_TIMED_OUT at https://procurement.gov.kz/", "circuit_breaker: portal unreachable",
    "page.goto: Timeout 60000ms exceeded", "fetch failed: portal HTTP 503", null, undefined])("does not treat %s as a certificate error", error => {
    expect(isCertificateError(error)).toBe(false);
  });
  it("counts skipped queries that failed on the certificate", () => {
    const base = { stage: "lots" as const, query: "q", year: 2026, months: [11], failedPage: 1, totalPages: null, keptRows: 0, attempts: 4 };
    expect(countCertificateErrors([
      { ...base, reason: "page.goto: net::ERR_CERT_DATE_INVALID at https://procurement.gov.kz/" },
      { ...base, reason: "page.goto: net::ERR_CONNECTION_TIMED_OUT at https://procurement.gov.kz/" },
      { ...base, reason: "circuit_breaker: portal unreachable" }
    ])).toBe(1);
    expect(countCertificateErrors(undefined)).toBe(0);
  });
});
