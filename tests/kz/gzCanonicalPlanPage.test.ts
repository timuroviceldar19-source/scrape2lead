import { describe, expect, it } from "vitest";
import {
  canonicalPlanPageFileName,
  extractGzPlanNumberFromHeading,
  hashGzPlanPage,
  verifyCanonicalPlanPageUrl
} from "../../src/kz/gzCanonicalPlanPage.js";

// Deals 41719 and 38807: two distinct plan points behind one legacy segment.
const POINT_A = "87018811";
const POINT_B = "87018653";
const SHARED_LEGACY = "4775438";

const ANNOUNCEMENT_H3 = "<h3>Всем участникам государственных закупок в сфере строительства!</h3>";
const REAL_PAGE = `<div>${ANNOUNCEMENT_H3}<h3>86795650: Доска специальная</h3></div>`;

describe("canonicalPlanPageFileName", () => {
  it("names the file after the canonical point, so a shared legacy segment cannot collide", () => {
    const a = canonicalPlanPageFileName(POINT_A);
    const b = canonicalPlanPageFileName(POINT_B);

    expect(a).not.toBe(b);
    expect(a).toContain(POINT_A);
    expect(b).toContain(POINT_B);
  });

  it("never derives the file name from the legacy segment", () => {
    expect(canonicalPlanPageFileName(POINT_A)).not.toContain(SHARED_LEGACY);
  });

  it("stays inside the canonical namespace instead of overwriting the old cache", () => {
    // data/debug/goszakup-plan-detail-*.html is the untrusted legacy cache.
    expect(canonicalPlanPageFileName(POINT_A)).not.toContain("goszakup-plan-detail");
  });
});

describe("verifyCanonicalPlanPageUrl", () => {
  it("accepts a page that ended on the requested canonical point", () => {
    const verdict = verifyCanonicalPlanPageUrl(
      `https://goszakup.gov.kz/ru/registry/show_plan/${POINT_A}/${SHARED_LEGACY}`,
      POINT_A
    );

    expect(verdict.ok).toBe(true);
  });

  it("rejects a redirect that landed on the sibling point sharing the legacy segment", () => {
    const verdict = verifyCanonicalPlanPageUrl(
      `https://goszakup.gov.kz/ru/registry/show_plan/${POINT_B}/${SHARED_LEGACY}`,
      POINT_A
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(POINT_B);
  });

  it("rejects a page that left the registry entirely", () => {
    expect(verifyCanonicalPlanPageUrl("https://goszakup.gov.kz/ru/user/login", POINT_A).ok).toBe(false);
    expect(verifyCanonicalPlanPageUrl("https://example.test/ru/registry/show_plan/87018811", POINT_A).ok).toBe(false);
    expect(verifyCanonicalPlanPageUrl("", POINT_A).ok).toBe(false);
  });
});

describe("extractGzPlanNumberFromHeading", () => {
  it("reads the number from the real heading", () => {
    expect(extractGzPlanNumberFromHeading(REAL_PAGE)).toBe("86795650");
  });

  it("ignores the site announcement heading that carries no number", () => {
    expect(extractGzPlanNumberFromHeading(`<div>${ANNOUNCEMENT_H3}</div>`)).toBeNull();
  });

  it("rejects an empty or non-numeric heading", () => {
    expect(extractGzPlanNumberFromHeading("")).toBeNull();
    expect(extractGzPlanNumberFromHeading("<h3></h3>")).toBeNull();
    expect(extractGzPlanNumberFromHeading("<h3>: Доска специальная</h3>")).toBeNull();
    expect(extractGzPlanNumberFromHeading("<h3>ABC123: Доска специальная</h3>")).toBeNull();
  });

  it("rejects an ambiguous page carrying two different numbered headings", () => {
    const ambiguous = "<h3>86795650: Доска специальная</h3><h3>82425225: Панель интерактивная</h3>";

    expect(extractGzPlanNumberFromHeading(ambiguous)).toBeNull();
  });

  it("accepts a page repeating the same numbered heading", () => {
    const repeated = "<h3>86795650: Доска специальная</h3><h3>86795650: Доска специальная</h3>";

    expect(extractGzPlanNumberFromHeading(repeated)).toBe("86795650");
  });

  it("yields nothing for a maintenance page that answers 200 with no plan on it", () => {
    const maintenance = "<html><body><h1>Ведутся технические работы</h1><p>Попробуйте позже</p></body></html>";

    expect(extractGzPlanNumberFromHeading(maintenance)).toBeNull();
  });
});

describe("hashGzPlanPage", () => {
  it("is stable for identical content and different for changed content", () => {
    expect(hashGzPlanPage(REAL_PAGE)).toBe(hashGzPlanPage(REAL_PAGE));
    expect(hashGzPlanPage(REAL_PAGE)).not.toBe(hashGzPlanPage(`${REAL_PAGE} `));
    expect(hashGzPlanPage(REAL_PAGE)).toMatch(/^[0-9a-f]{64}$/);
  });
});
