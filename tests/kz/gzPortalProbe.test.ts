import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { probeGzPortal } from "../../src/kz/gzPortalProbe.js";
import { buildPlanSearchUrl } from "../../src/kz/goszakupPlanHtmlParser.js";

const pattern = new RegExp(fs.readFileSync("scripts/run-automation-with-retry.sh", "utf8").match(/NETWORK_PATTERN='([^']+)'/)![1]);
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const sleep = vi.fn(async (_ms: number) => {});
  return { fetch, sleep, now: () => 0 };
}
describe("GZ portal probe (no network)", () => {
  it.each([200, 403, 404])("accepts HTTP %i", async status => {
    const deps = setup();
    deps.fetch.mockResolvedValue(new Response("search", { status }));
    const result = await probeGzPortal(deps);
    expect(result.ok).toBe(true);
    expect(result.line).toBe(`portal probe: ok (HTTP ${status}, 0 s)`);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch.mock.calls[0][0]).toBe(buildPlanSearchUrl({ keyword: "", year: new Date().getFullYear(), months: [] }));
    expect(deps.sleep).not.toHaveBeenCalled();
  });
  it.each(["ENOTFOUND", "ETIMEDOUT", "TimeoutError", "503", "429", "maintenance"])("rejects %s and retains network classification", async reason => {
    const deps = setup();
    if (reason === "503" || reason === "429") deps.fetch.mockImplementation(async () => new Response("", { status: Number(reason) }));
    else if (reason === "maintenance") deps.fetch.mockImplementation(async () => new Response("Технические работы"));
    else deps.fetch.mockRejectedValue(reason === "TimeoutError" ? new DOMException("deadline", "TimeoutError") : new TypeError("fetch failed", { cause: Object.assign(new Error(reason), { code: reason }) }));
    const result = await probeGzPortal(deps);
    expect(result.ok).toBe(false);
    expect(result.line).toContain("portal probe: unreachable:");
    expect(result.line).toMatch(pattern);
    if (["ENOTFOUND", "ETIMEDOUT", "TimeoutError"].includes(reason)) expect(result.line).toContain(reason);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(deps.sleep.mock.calls).toEqual([[10_000], [10_000]]);
  });
  it.each([
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"
  ])("treats TLS/certificate failure %s as inconclusive without retries", async code => {
    const deps = setup();
    deps.fetch.mockRejectedValue(new TypeError("fetch failed", {
      cause: Object.assign(new Error("certificate verification failed"), { code })
    }));
    const result = await probeGzPortal(deps);
    expect(result.status).toBe("inconclusive");
    expect(result.line).toContain("portal probe: inconclusive:");
    expect(result.line).toContain(code);
    expect(result.line).not.toContain("unreachable");
    expect(result.line).not.toMatch(pattern);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });
  it("propagates unexpected errors without retries", async () => {
    const deps = setup();
    deps.fetch.mockRejectedValue(new TypeError("invalid URL"));
    await expect(probeGzPortal(deps)).rejects.toThrow("invalid URL");
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });
  it("stops at the first success", async () => {
    const deps = setup();
    deps.fetch.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue(new Response("ok"));
    expect((await probeGzPortal(deps)).ok).toBe(true);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
  it("bounds a hung fetch and a hung body by the same deadline", async () => {
    vi.useFakeTimers();
    try {
      for (const body of [false, true]) {
        const deps = setup();
        deps.fetch.mockImplementation(async () => body ? { status: 200, text: () => new Promise<string>(() => {}) } as Response : await new Promise<Response>(() => {}));
        const pending = probeGzPortal(deps);
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await pending).line).toContain("TimeoutError");
        expect(deps.fetch).toHaveBeenCalledTimes(3);
      }
    } finally { vi.useRealTimers(); }
  });
});
