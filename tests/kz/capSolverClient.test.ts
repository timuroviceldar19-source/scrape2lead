import { describe, expect, it, vi } from "vitest";
import { CapSolverClient } from "../../src/kz/capSolverClient.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("CapSolverClient", () => {
  it("creates a proxyless reCAPTCHA v2 task and returns a ready token", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ errorId: 0, taskId: "task-1" }))
      .mockResolvedValueOnce(json({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "token-1" } }));
    const client = new CapSolverClient({ apiKey: "top-secret", fetcher, sleep: async () => undefined });
    await expect(client.solveRecaptchaV2({ websiteURL: "https://portal.kgd.gov.kz/x", websiteKey: "site-key" })).resolves.toBe("token-1");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ clientKey: "top-secret", task: { type: "ReCaptchaV2TaskProxyLess", websiteKey: "site-key" } });
  });

  it("polls while the task is processing", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ errorId: 0, taskId: "task-1" }))
      .mockResolvedValueOnce(json({ errorId: 0, status: "processing" }))
      .mockResolvedValueOnce(json({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "token-2" } }));
    const sleep = vi.fn(async () => undefined);
    await expect(new CapSolverClient({ apiKey: "key", fetcher, sleep }).solveRecaptchaV2({ websiteURL: "https://x", websiteKey: "s" })).resolves.toBe("token-2");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ errorId: 1, errorCode: "ERROR_ZERO_BALANCE", errorDescription: "Not enough balance" }, /ERROR_ZERO_BALANCE/],
    [{ errorId: 0, status: "failed", errorCode: "ERROR_CAPTCHA_UNSOLVABLE" }, /ERROR_CAPTCHA_UNSOLVABLE/]
  ])("reports API failures without leaking the key", async (failure, expected) => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(failure.errorId ? failure : { errorId: 0, taskId: "t" })).mockResolvedValueOnce(json(failure));
    const error = await new CapSolverClient({ apiKey: "top-secret", fetcher, sleep: async () => undefined }).solveRecaptchaV2({ websiteURL: "https://x", websiteKey: "s" }).catch((value) => value as Error);
    expect(error.message).toMatch(expected);
    expect(error.message).not.toContain("top-secret");
  });

  it("times out polling without exposing credentials", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ errorId: 0, taskId: "t" })).mockResolvedValue(json({ errorId: 0, status: "processing" }));
    let now = 0;
    const client = new CapSolverClient({ apiKey: "top-secret", fetcher, timeoutMs: 2, now: () => now, sleep: async () => { now += 2; } });
    const error = await client.solveRecaptchaV2({ websiteURL: "https://x", websiteKey: "s" }).catch((value) => value as Error);
    expect(error.message).toMatch(/timeout/i);
    expect(error.message).not.toContain("top-secret");
  });

  it("reports HTTP errors without echoing response bodies or keys", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("top-secret internal", { status: 503 }));
    const error = await new CapSolverClient({ apiKey: "top-secret", fetcher }).solveRecaptchaV2({ websiteURL: "https://x", websiteKey: "s" }).catch((value) => value as Error);
    expect(error.message).toBe("CapSolver HTTP 503");
  });
});
