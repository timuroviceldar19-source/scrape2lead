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
        return payload;
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
async function waitForPayload(page: Page, bin: string, timeoutMs: number): Promise<unknown> {
  const outcome = await waitForKgdOutcome(page, bin, timeoutMs, false);
  return outcome.payload;
}

const NO_DATA_PATTERN = /\u0434\u0430\u043d\u043d\u044b\u0435\s+\u043d\u0435\s+\u043d\u0430\u0439\u0434\u0435\u043d\u044b/i;
const PORTAL_ERROR_PATTERN = /\u043e\u0448\u0438\u0431\u043a\u0430\s+\u043f\u0440\u0438\s+\u043f\u043e\u043b\u0443\u0447\u0435\u043d\u0438\u0438\s+\u0434\u0430\u043d\u043d\u044b\u0445/i;
const NO_DATA_PAYLOAD = { data: { isLiquidated: false } };

export function waitForKgdOutcome(page: Page, bin: string, timeoutMs: number, detectInvalid = true): Promise<CaptchaOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => { clearTimeout(timer); if (pollTimer) clearTimeout(pollTimer); page.off("response", listener); };
    const finish = (result: CaptchaOutcome): void => { if (settled) return; settled = true; cleanup(); resolve(result); };
    const fail = (error: Error): void => { if (settled) return; settled = true; cleanup(); reject(error); };
    const timer = setTimeout(() => fail(new Error("KGD response timeout")), timeoutMs);
    const listener = async (response: Response) => {
      if (!/json/i.test(response.headers()["content-type"] ?? "")) return;
      try {
        const value = await response.json(); const serialized = JSON.stringify(value);
        if (PORTAL_ERROR_PATTERN.test(serialized)) fail(new Error("KGD portal error: data retrieval failed"));
        else if (NO_DATA_PATTERN.test(serialized)) finish({ kind: "success", payload: NO_DATA_PAYLOAD });
        else if (detectInvalid && serialized.includes("error.invalid-recaptcha")) finish({ kind: "invalid" });
        else if (serialized.includes(bin)) finish({ kind: "success", payload: value });
      } catch { /* ignore unrelated responses */ }
    };
    page.on("response", listener);

    const pollForNoData = async (): Promise<void> => {
      if (settled) return;
      try {
        const bodyText = await page.locator("body").innerText({ timeout: 1_000 });
        if (PORTAL_ERROR_PATTERN.test(bodyText)) { fail(new Error("KGD portal error: data retrieval failed")); return; }
        if (NO_DATA_PATTERN.test(bodyText)) { finish({ kind: "success", payload: NO_DATA_PAYLOAD }); return; }
      } catch { /* page may be navigating while the result is rendered */ }
      if (!settled) pollTimer = setTimeout(() => void pollForNoData(), 200);
    };
    void pollForNoData();
  });
}

async function resetRecaptcha(page: Page): Promise<void> {
  await page.evaluate(() => { const api = (globalThis as typeof globalThis & { grecaptcha?: { reset(): void } }).grecaptcha; api?.reset(); });
}
