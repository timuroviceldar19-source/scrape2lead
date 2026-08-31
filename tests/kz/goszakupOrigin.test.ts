import { describe, expect, it } from "vitest";
import { GZ_PORTAL_ORIGIN, isGzPortalHost, isGzPortalRootHost } from "../../src/kz/goszakupOrigin.js";

describe("GZ_PORTAL_ORIGIN", () => {
  it("points at the current portal domain without www and without a trailing slash", () => {
    expect(GZ_PORTAL_ORIGIN).toBe("https://procurement.gov.kz");
  });
});

describe("isGzPortalHost", () => {
  it("accepts the current domain and the historical one, including its subdomains", () => {
    expect(isGzPortalHost("procurement.gov.kz")).toBe(true);
    expect(isGzPortalHost("goszakup.gov.kz")).toBe(true);
    expect(isGzPortalHost("www.goszakup.gov.kz")).toBe(true);
    expect(isGzPortalHost("v3bl.goszakup.gov.kz")).toBe(true);
    expect(isGzPortalHost("PROCUREMENT.GOV.KZ")).toBe(true);
  });

  it("rejects foreign hosts and lookalikes", () => {
    expect(isGzPortalHost("example.test")).toBe(false);
    expect(isGzPortalHost("procurement.gov.kz.example.test")).toBe(false);
    expect(isGzPortalHost("notgoszakup.gov.kz")).toBe(false);
    expect(isGzPortalHost(null)).toBe(false);
    expect(isGzPortalHost("")).toBe(false);
  });
});

describe("isGzPortalRootHost", () => {
  it("accepts only the portal itself, not its subdomains", () => {
    expect(isGzPortalRootHost("procurement.gov.kz")).toBe(true);
    expect(isGzPortalRootHost("goszakup.gov.kz")).toBe(true);
    expect(isGzPortalRootHost("www.goszakup.gov.kz")).toBe(true);
    expect(isGzPortalRootHost("v3bl.goszakup.gov.kz")).toBe(false);
    expect(isGzPortalRootHost("ows.goszakup.gov.kz")).toBe(false);
  });
});
