import type { Locator, Page } from "playwright";

export const ZAKUP_LOTS_URL = "https://zakup.sk.kz/#/lots";

export const ZAKUP_SEARCH_SELECTORS = [
  'input[placeholder*="Слово"]',
  'input[placeholder*="поиска"]',
  'input[placeholder*="Поиск"]',
  'input[type="search"]',
  'input[aria-label*="поиск" i]',
  'input[aria-label*="search" i]',
  '.search input',
  'form input[type="text"]'
] as const;

const PER_SELECTOR_TIMEOUT_MS = 3000;

export async function waitForZakupSearchInput(
  page: Page,
  options?: { timeoutMs?: number }
): Promise<Locator | null> {
  const totalCap = options?.timeoutMs ?? 15000;
  const deadline = Date.now() + totalCap;

  for (const selector of ZAKUP_SEARCH_SELECTORS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = Math.min(PER_SELECTOR_TIMEOUT_MS, remaining);
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout });
      const isEnabled = await locator.isEnabled().catch(() => false);
      if (isEnabled) return locator;
    } catch {
      // selector not found within timeout, try next
    }
  }
  return null;
}

const OVERLAY_DISMISS_SELECTORS = [
  'button:has-text("Принять")',
  'button:has-text("Закрыть")',
  'button:has-text("Accept")',
  'button:has-text("Close")',
  '[aria-label="Close"]',
  '[aria-label="Закрыть"]',
  '.cookie-banner button',
  '.modal .close'
];

export async function dismissZakupOverlays(page: Page): Promise<void> {
  for (const selector of OVERLAY_DISMISS_SELECTORS) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
        await locator.click({ timeout: 2000 }).catch(() => {});
      }
    } catch {
      // best-effort, swallow errors
    }
  }
}

export function isRetriableZakupError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes("search input not found")
    || msg.includes("timeout")
    || msg.includes("net::")
    || msg.includes("navigation");
}
