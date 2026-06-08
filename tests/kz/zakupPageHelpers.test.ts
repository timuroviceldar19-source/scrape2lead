import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRetriableZakupError, waitForZakupSearchInput } from "../../src/kz/zakupPageHelpers.js";

const FIXTURES = path.resolve("tests/fixtures");

describe("isRetriableZakupError", () => {
  it("returns true for search input not found", () => {
    expect(isRetriableZakupError(new Error("search input not found; not saving default lots"))).toBe(true);
  });
  it("returns true for timeout errors", () => {
    expect(isRetriableZakupError(new Error("Timeout 30000ms exceeded"))).toBe(true);
  });
  it("returns true for net:: errors", () => {
    expect(isRetriableZakupError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(true);
  });
  it("returns true for navigation errors", () => {
    expect(isRetriableZakupError(new Error("Navigation failed"))).toBe(true);
  });
  it("returns false for unrelated errors", () => {
    expect(isRetriableZakupError(new Error("company name missing"))).toBe(false);
  });
});

describe("waitForZakupSearchInput", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("finds search input on ready page", async () => {
    const html = fs.readFileSync(path.join(FIXTURES, "zakup-lots-ready.html"), "utf8");
    await page.setContent(html);
    const input = await waitForZakupSearchInput(page, { timeoutMs: 5000 });
    expect(input).not.toBeNull();
  });

  it("returns null on loading page with short timeout", async () => {
    const html = fs.readFileSync(path.join(FIXTURES, "zakup-lots-loading.html"), "utf8");
    await page.setContent(html);
    const input = await waitForZakupSearchInput(page, { timeoutMs: 2000 });
    expect(input).toBeNull();
  });
});
