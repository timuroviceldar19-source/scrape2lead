import type { Page } from "playwright";

export interface CaptchaOutcome {
  kind: "success" | "invalid";
  payload?: unknown;
}

export interface AutomaticCaptchaAttemptOptions {
  attempts: number;
  solveToken(): Promise<string>;
  applyToken(token: string): Promise<boolean>;
  submit(): Promise<void>;
  waitForOutcome(): Promise<CaptchaOutcome>;
  reset(): Promise<void>;
  onAttemptError?: (error: Error, attempt: number) => void;
}

export async function discoverRecaptchaSiteKey(page: Page): Promise<string> {
  const frame = page.locator('iframe[src*="recaptcha/api2/"]').first();
  await frame.waitFor({ state: "attached", timeout: 20_000 });
  const src = await frame.getAttribute("src");
  const key = src ? new URL(src, page.url()).searchParams.get("k") : null;
  if (!key) throw new Error("reCAPTCHA site key not found");
  return key;
}

export async function injectRecaptchaToken(page: Page, token: string, siteKey: string): Promise<boolean> {
  /* v8 ignore start -- executed and asserted inside the Playwright browser process */
  return page.evaluate(({ solution, expectedSiteKey }) => {
    const textareas = document.querySelectorAll<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]');
    for (const textarea of textareas) {
      textarea.value = solution;
      textarea.innerHTML = solution;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const root = (globalThis as typeof globalThis & { ___grecaptcha_cfg?: { clients?: unknown } }).___grecaptcha_cfg?.clients;
    const seen = new WeakSet<object>();
    let invoked = false;
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    while (stack.length > 0 && !invoked) {
      const next = stack.pop()!; const value = next.value;
      if (!value || typeof value !== "object" || next.depth > 10 || seen.has(value)) continue;
      seen.add(value);
      const record = value as Record<string, unknown>;
      if (record.sitekey === expectedSiteKey && typeof record.callback === "function") {
        (record.callback as (token: string) => void).call(value, solution);
        invoked = true;
        break;
      }
      for (const child of Object.values(record)) stack.push({ value: child, depth: next.depth + 1 });
    }
    return invoked;
  }, { solution: token, expectedSiteKey: siteKey });
  /* v8 ignore stop */
}

export async function runAutomaticCaptchaAttempts(options: AutomaticCaptchaAttemptOptions): Promise<unknown> {
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    let outcomePromise: Promise<CaptchaOutcome> | undefined;
    try {
      const token = await options.solveToken();
      if (!await options.applyToken(token)) throw new Error("reCAPTCHA callback not found");
      outcomePromise = options.waitForOutcome();
      void outcomePromise.catch(() => undefined);
      await options.submit();
      const outcome = await outcomePromise;
      if (outcome.kind === "success") return outcome.payload;
    } catch (error) {
      void outcomePromise?.catch(() => undefined);
      options.onAttemptError?.(asError(error), attempt);
    }
    await options.reset();
  }
  throw new Error(`Automatic CAPTCHA failed after ${options.attempts} attempts`);
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
