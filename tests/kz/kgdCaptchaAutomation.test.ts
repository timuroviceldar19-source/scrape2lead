import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { discoverRecaptchaSiteKey, injectRecaptchaToken, runAutomaticCaptchaAttempts } from "../../src/kz/kgdCaptchaAutomation.js";

describe("KGD CAPTCHA browser integration", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser.close(); });

  it("discovers the site key, fills response fields and invokes the matching callback", async () => {
    const page = await browser.newPage();
    await page.setContent('<iframe src="https://www.google.com/recaptcha/api2/anchor?k=site-key-1"></iframe><textarea name="g-recaptcha-response"></textarea>');
    await page.evaluate(() => { (globalThis as any).__callbackToken = ""; (globalThis as any).___grecaptcha_cfg = { clients: { 0: { a: { sitekey: "site-key-1", callback: (token: string) => (globalThis as any).__callbackToken = token } } } }; });
    expect(await discoverRecaptchaSiteKey(page)).toBe("site-key-1");
    expect(await injectRecaptchaToken(page, "solution-token", "site-key-1")).toBe(true);
    expect(await page.locator('textarea[name="g-recaptcha-response"]').inputValue()).toBe("solution-token");
    expect(await page.evaluate(() => (globalThis as any).__callbackToken)).toBe("solution-token");
    await page.close();
  });
});

describe("automatic CAPTCHA attempts", () => {
  it("retries once, then returns null for manual fallback", async () => {
    const solveToken = vi.fn().mockRejectedValueOnce(new Error("first failed")).mockResolvedValueOnce("token");
    const reset = vi.fn(async () => undefined);
    const result = await runAutomaticCaptchaAttempts({ attempts: 2, solveToken, applyToken: async () => true, submit: async () => undefined, waitForOutcome: async () => ({ kind: "invalid" }), reset });
    expect(result).toBeNull(); expect(solveToken).toHaveBeenCalledTimes(2); expect(reset).toHaveBeenCalledTimes(2);
  });

  it("returns the first successful payload without another paid attempt", async () => {
    const solveToken = vi.fn(async () => "token"); const payload = { bin: "160640003364" };
    await expect(runAutomaticCaptchaAttempts({ attempts: 2, solveToken, applyToken: async () => true, submit: async () => undefined, waitForOutcome: async () => ({ kind: "success", payload }), reset: async () => undefined })).resolves.toEqual(payload);
    expect(solveToken).toHaveBeenCalledTimes(1);
  });
});
