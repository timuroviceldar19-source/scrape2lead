import { describe, expect, it } from "vitest";
import { deriveUserAgent } from "../src/browser/browserSessionManager.js";

/**
 * The adapter's User-Agent must track the actual bundled Chromium version so
 * 2GIS does not serve the "обновите браузер" interstitial and so the UA
 * agrees with the Client Hints Chromium derives from its real version.
 * (Root-caused by the no-proxy Novosibirsk smoke test, 2026-06-02.)
 */
describe("deriveUserAgent", () => {
  it("uses the bundled Chromium major version in reduced-UA form", () => {
    expect(deriveUserAgent("148.0.7778.96")).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    );
  });

  it("never emits the stale hardcoded 124 version", () => {
    expect(deriveUserAgent("148.0.7778.96")).not.toContain("124");
  });

  it("drops the HeadlessChrome token (derives Chrome/<major> regardless)", () => {
    const ua = deriveUserAgent("148.0.7778.96");
    expect(ua).not.toMatch(/headless/i);
    expect(ua).toContain("Chrome/148.0.0.0");
  });

  it("tracks future Chromium bumps without code changes", () => {
    expect(deriveUserAgent("151.0.1.2")).toContain("Chrome/151.0.0.0");
  });

  it("degrades safely on an unexpected version string", () => {
    expect(deriveUserAgent("")).toContain("Chrome/0.0.0.0");
  });
});
