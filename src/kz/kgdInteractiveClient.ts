import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import type { CounterpartyPayloadResult } from "./kgdCounterpartyTypes.js";
import { parseCounterpartyPayload, parseLiquidationPayload } from "./kgdResponseParser.js";

const COUNTERPARTY_URL = "https://portal.kgd.gov.kz/pages/info-services/find-information-for-ip-ul";
const LIQUIDATION_URL = "https://portal.kgd.gov.kz/pages/info-services/find-liquidated-taxpayer";

export class KgdInteractiveClient {
  private browser?: Browser;
  private context?: BrowserContext;
  constructor(private readonly timeoutMs = 10 * 60_000, private readonly onProgress: (message: string) => void = console.log) {}
  async checkCounterparty(bin: string): Promise<CounterpartyPayloadResult> { const payload = await this.query(COUNTERPARTY_URL, bin, "Сведения по контрагенту"); return parseCounterpartyPayload(payload); }
  async checkLiquidation(bin: string): Promise<{ active: boolean; startDate?: string }> { const payload = await this.query(LIQUIDATION_URL, bin, "Стадия ликвидации"); return parseLiquidationPayload(payload); }
  async close(): Promise<void> { await this.context?.close(); await this.browser?.close(); this.context = undefined; this.browser = undefined; }

  private async query(url: string, bin: string, label: string): Promise<unknown> {
    const page = await this.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); await fillBin(page, bin); const responsePromise = waitForPayload(page, bin, this.timeoutMs);
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
