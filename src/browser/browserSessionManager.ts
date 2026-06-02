import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { RuntimeConfig } from "../types.js";

export class BrowserSessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private currentProxy: RuntimeConfig["proxy"];

  constructor(private readonly config: RuntimeConfig) {
    this.currentProxy = config.proxy;
  }

  async newPage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.config.headless });
    }
    if (!this.context) {
      this.context = await this.browser.newContext({
        locale: "ru-RU",
        timezoneId: "Europe/Moscow",
        userAgent: deriveUserAgent(this.browser.version()),
        proxy: this.currentProxy,
        viewport: { width: 1366, height: 768 }
      });
      await this.context.addInitScript(fingerprintPatch);
    }
    return this.context.newPage();
  }

  async restartWithProxy(proxy: RuntimeConfig["proxy"]): Promise<void> {
    await this.close();
    this.currentProxy = proxy;
    this.browser = await chromium.launch({ headless: this.config.headless });
    this.context = null;
  }

  async restart(): Promise<void> {
    await this.restartWithProxy(this.currentProxy);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }
}

/**
 * Build a desktop-Chrome User-Agent from the actual bundled Chromium
 * version (`Browser.version()`), instead of a hardcoded string.
 *
 * Why derive it:
 *  - A hardcoded UA drifts stale as Playwright bumps its bundled Chromium.
 *    The previous `Chrome/124.0.0.0` tripped 2GIS's "обновите браузер"
 *    interstitial once the runtime moved on (bundled Chromium is 148+), so
 *    discovery silently returned 0 cards.
 *  - The UA major version must agree with the Client Hints (`Sec-CH-UA`,
 *    `navigator.userAgentData.brands`) that Chromium derives from its *real*
 *    version. A spoofed-but-mismatched UA is itself an automation tell.
 *
 * The format mirrors modern Chrome's "reduced" UA: only the major version is
 * surfaced (`Chrome/<major>.0.0.0`); the full version stays in the client
 * hints, exactly as a real Chrome build behaves. The "HeadlessChrome" token
 * Chromium emits in headless mode is dropped by construction.
 */
export function deriveUserAgent(browserVersion: string): string {
  const major = /^\d+/.exec(browserVersion)?.[0] ?? "0";
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  );
}

const fingerprintPatch = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["ru-RU", "ru"] });
  Object.defineProperty(navigator, "plugins", {
    get: () => [
      { name: "Chrome PDF Plugin" },
      { name: "Chrome PDF Viewer" },
      { name: "Native Client" }
    ]
  });
};
