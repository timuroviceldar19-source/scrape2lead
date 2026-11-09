import { buildPlanSearchUrl } from "./goszakupPlanHtmlParser.js";
import { assertPortalResponse, assertPortalHtmlAvailable, isTransientNetworkError } from "./gzCollection.js";

interface ProbeDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
export interface PortalProbeResult { ok: boolean; status: "ok" | "unreachable" | "inconclusive"; line: string }

/** Сохраняем code/name из цепочки cause: у Node fetch message часто только «fetch failed». */
function networkReason(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  while (error != null && !seen.has(error)) {
    seen.add(error);
    if (typeof error !== "object") { parts.push(String(error)); break; }
    const item = error as { name?: string; message?: string; code?: string; cause?: unknown };
    parts.push([item.name, item.code, item.message].filter(Boolean).join(" "));
    error = item.cause;
  }
  return parts.join(": ").replace(/\s+/g, " ").slice(0, 1000);
}

/** TLS доказывает лишь проблему Node/cert store, а не недоступность портала для браузера. */
function tlsFailureReason(error: unknown): string | null {
  const seen = new Set<unknown>();
  const codes: string[] = [];
  let tlsMessage = false;
  while (error != null && !seen.has(error)) {
    seen.add(error);
    const item = typeof error === "object" ? error as { code?: unknown; message?: unknown; cause?: unknown } : null;
    const code = typeof item?.code === "string" ? item.code : "";
    if (/^[A-Z0-9_]+$/.test(code) && /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(code)) codes.push(code);
    const message = typeof error === "string" ? error : typeof item?.message === "string" ? item.message : "";
    if (/certificate|self.signed|\bTLS\b|\bSSL\b|unable to verify.*signature/i.test(message)) tlsMessage = true;
    error = item?.cause;
  }
  // Не включаем внешнее «fetch failed»: inconclusive не должен совпадать с NETWORK_PATTERN.
  return codes.length ? codes.join(": ") : tlsMessage ? "TLS/certificate verification failed" : null;
}

/** До 3 GET по 20 с (включая тело), две паузы по 10 с: максимум около 80 с. */
export async function probeGzPortal(deps: ProbeDependencies = {}): Promise<PortalProbeResult> {
  const fetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const started = now();
  const url = buildPlanSearchUrl({ keyword: "", year: new Date().getFullYear(), months: [] });
  let reason = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new DOMException("portal GET exceeded 20000ms", "TimeoutError");
          reject(error);
          controller.abort(error);
        }, 20_000);
      });
      const status = await Promise.race([
        (async () => {
          const response = await fetch(url, { method: "GET", signal: controller.signal });
          // Общий guard строже probe: 4xx (кроме 429) подтверждает доступность машины.
          try { assertPortalResponse({ status: () => response.status }); }
          catch (error) { if (response.status === 429 || response.status >= 500) throw error; }
          assertPortalHtmlAvailable(await response.text());
          return response.status;
        })(),
        deadline
      ]);
      return { ok: true, status: "ok", line: `portal probe: ok (HTTP ${status}, ${((now() - started) / 1000).toFixed(1).replace(/\.0$/, "")} s)` };
    } catch (error) {
      const tlsReason = tlsFailureReason(error);
      if (tlsReason) return { ok: false, status: "inconclusive", line: `portal probe: inconclusive: ${tlsReason}` };
      if (!isTransientNetworkError(error)) throw error;
      reason = networkReason(error);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (attempt < 3) await sleep(10_000);
  }
  return { ok: false, status: "unreachable", line: `portal probe: unreachable: ${reason}` };
}
