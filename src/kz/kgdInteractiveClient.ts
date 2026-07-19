import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import type { CapSolverClient } from "./capSolverClient.js";
import { discoverRecaptchaSiteKey, injectRecaptchaToken, runAutomaticCaptchaAttempts, type CaptchaOutcome } from "./kgdCaptchaAutomation.js";
import type { CaptchaMode } from "./kgdCaptchaMode.js";
import type { CounterpartyPayloadResult } from "./kgdCounterpartyTypes.js";
import { parseCounterpartyPayload, parseLiquidationPayload } from "./kgdResponseParser.js";

const COUNTERPARTY_URL = "https://portal.kgd.gov.kz/pages/info-services/find-information-for-ip-ul";
const LIQUIDATION_URL = "https://portal.kgd.gov.kz/pages/info-services/find-liquidated-taxpayer";

export class KgdInteractiveClient {
  private browser?: Browser;
  private context?: BrowserContext;
  private readonly timeoutMs: number;
  private readonly onProgress: (message: string) => void;
  private readonly captchaMode: CaptchaMode;
  private readonly capSolver?: CapSolverClient;

  constructor(options: { timeoutMs?: number; onProgress?: (message: string) => void; captchaMode?: CaptchaMode; capSolver?: CapSolverClient } = {}) {
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.onProgress = options.onProgress ?? console.log;
    this.captchaMode = options.captchaMode ?? "manual";
    this.capSolver = options.capSolver;
    if (this.captchaMode === "auto" && !this.capSolver) throw new Error("Automatic CAPTCHA mode requires CapSolver client");
  }
  async checkCounterparty(bin: string): Promise<CounterpartyPayloadResult> { const payload = await this.query(COUNTERPARTY_URL, bin, "Сведения по контрагенту"); return parseCounterpartyPayload(payload); }
  async checkLiquidation(bin: string): Promise<{ active: boolean; startDate?: string }> { const payload = await this.query(LIQUIDATION_URL, bin, "Стадия ликвидации"); return parseLiquidationPayload(payload); }
  async close(): Promise<void> { await this.context?.close(); await this.browser?.close(); this.context = undefined; this.browser = undefined; }

  private async query(url: string, bin: string, label: string): Promise<unknown> {
    const page = await this.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); await fillBin(page, bin);
      if (this.captchaMode === "auto") {
        let siteKey = "";
        const payload = await runAutomaticCaptchaAttempts({
          attempts: 2,
          solveToken: async () => { siteKey = await discoverRecaptchaSiteKey(page); this.onProgress(`${label}: отправка CAPTCHA в CapSolver`); return this.capSolver!.solveRecaptchaV2({ websiteURL: page.url(), websiteKey: siteKey }); },
          applyToken: (token) => injectRecaptchaToken(page, token, siteKey),
          submit: () => page.getByRole("button", { name: /^Искать$/i }).click(),
          waitForOutcome: () => waitForKgdOutcome(page, bin, Math.min(this.timeoutMs, 60_000)),
          reset: () => resetRecaptcha(page),
          onAttemptError: (error, attempt) => this.onProgress(`${label}: автоматическая попытка ${attempt}/2 не удалась: ${error.message}`)
        });
        if (payload !== null) return payload;
        this.onProgress(`${label}: CapSolver не завершил проверку, переход к ручной CAPTCHA.`);
      }
      const responsePromise = waitForPayload(page, bin, this.timeoutMs);
      this.onProgress(`${label}: БИН заполнен. Решите CAPTCHA в открытом Chromium и запустите поиск.`);
      return await responsePromise;
    } catch (error) { if (/timeout/i.test(String(error))) throw new Error(`CAPTCHA_REQUIRED: ${label} не завершена за ${Math.round(this.timeoutMs / 60_000)} мин.`); throw error; }
    finally { await page.close(); }
  }
  private async newPage(): Promise<Page> { if (!this.browser) { this.browser = await chromium.launch({ headless: false }); this.context = await this.browser.newContext({ locale: "ru-RU" }); } return this.context!.newPage(); }
}

async function fillBin(page: Page, bin: string): Promise<void> {
  const candidates = [page.getByLabel(/БИН|ИИН/i), page.getByPlaceholder(/БИН|ИИН/i), page.locator('input[name*="bin" i], input[id*="bin" i], input[type="text"]').first()];
  for (const locator of candidates) try { await locator.first().waitFor({ state: "visible", timeout: 8_000 }); await locator.first().fill(bin); return; } catch { /* try next stable locator */ }
  throw new Error("Не найдено поле БИН на странице КГД");
}
function waitForPayload(page: Page, bin: string, timeoutMs: number): Promise<unknown> { return new Promise((resolve, reject) => { const timer = setTimeout(() => { page.off("response", listener); reject(new Error("CAPTCHA timeout")); }, timeoutMs); const listener = async (response: Response) => { if (!/json/i.test(response.headers()["content-type"] ?? "")) return; try { const value = await response.json(); if (!JSON.stringify(value).includes(bin)) return; clearTimeout(timer); page.off("response", listener); resolve(value); } catch { /* ignore unrelated responses */ } }; page.on("response", listener); }); }

function waitForKgdOutcome(page: Page, bin: string, timeoutMs: number): Promise<CaptchaOutcome> {
  return new Promise((resolve, reject) => {
    const finish = (result: CaptchaOutcome): void => { clearTimeout(timer); page.off("response", listener); resolve(result); };
    const timer = setTimeout(() => { page.off("response", listener); reject(new Error("KGD response timeout")); }, timeoutMs);
    const listener = async (response: Response) => {
      if (!/json/i.test(response.headers()["content-type"] ?? "")) return;
      try {
        const value = await response.json(); const serialized = JSON.stringify(value);
        if (serialized.includes("error.invalid-recaptcha")) finish({ kind: "invalid" });
        else if (serialized.includes(bin)) finish({ kind: "success", payload: value });
      } catch { /* ignore unrelated responses */ }
    };
    page.on("response", listener);
  });
}

async function resetRecaptcha(page: Page): Promise<void> {
  await page.evaluate(() => { const api = (globalThis as typeof globalThis & { grecaptcha?: { reset(): void } }).grecaptcha; api?.reset(); });
}
