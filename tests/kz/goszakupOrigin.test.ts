import { describe, expect, it } from "vitest";
import { GZ_PORTAL_ORIGIN, isGzPortalHost, isGzPortalRootHost, toCurrentPortalUrl } from "../../src/kz/goszakupOrigin.js";

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

describe("toCurrentPortalUrl", () => {
  it("переносит ссылку со старого домена портала на новый, сохраняя путь", () => {
    expect(toCurrentPortalUrl("https://goszakup.gov.kz/ru/registry/show_plan/84671831/4573761"))
      .toBe("https://procurement.gov.kz/ru/registry/show_plan/84671831/4573761");
    expect(toCurrentPortalUrl("https://www.goszakup.gov.kz/ru/announce/index/123?tab=lots#x"))
      .toBe("https://procurement.gov.kz/ru/announce/index/123?tab=lots#x");
    expect(toCurrentPortalUrl("http://GOSZAKUP.GOV.KZ/ru/registry/lots/1")).toBe("https://procurement.gov.kz/ru/registry/lots/1");
  });

  it("не трогает новый домен, поддомены старого (ows, v3bl), чужие хосты и мусор", () => {
    expect(toCurrentPortalUrl("https://procurement.gov.kz/ru/registry/show_plan/1")).toBe("https://procurement.gov.kz/ru/registry/show_plan/1");
    expect(toCurrentPortalUrl("https://ows.goszakup.gov.kz/v3/plans/1")).toBe("https://ows.goszakup.gov.kz/v3/plans/1");
    expect(toCurrentPortalUrl("https://v3bl.goszakup.gov.kz/files/1")).toBe("https://v3bl.goszakup.gov.kz/files/1");
    expect(toCurrentPortalUrl("https://notgoszakup.gov.kz/ru")).toBe("https://notgoszakup.gov.kz/ru");
    expect(toCurrentPortalUrl("")).toBe("");
    expect(toCurrentPortalUrl("не ссылка")).toBe("не ссылка");
  });
});
