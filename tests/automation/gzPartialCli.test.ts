import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), run: vi.fn() }));
vi.mock("../../src/automation/config.js", () => ({ loadAutomationConfig: mocks.config }));
vi.mock("../../src/automation/orchestrator.js", () => ({
  runScheduledAutomation: mocks.run, approveAutomationRun: vi.fn(), prepareAutomationRun: vi.fn(), pushAutomationRun: vi.fn()
}));
vi.mock("../../src/automation/realDependencies.js", () => ({ createRealAutomationDependencies: () => ({}) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("scheduled automation CLI exit codes", () => {
  it.each([
    ["prepare", "ready", 0], ["push", "pushed", 0], ["prepare", "failed", 1], ["push", "failed", 1]
  ] as const)("returns %s/%s as code %s without invoking real dependencies", async (deliveryMode, status, expected) => {
    const argv = process.argv; const previous = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("BITRIX24_WEBHOOK_URL", "https://example.test/mock-only");
    mocks.config.mockReturnValue({ deliveryMode, runsDir: "unused" });
    mocks.run.mockResolvedValue({ runId: "mock-run", status });
    try {
      process.argv = [process.execPath, "automation.mts", "run"]; process.exitCode = 0;
      await import("../../scripts/automation.mjs");
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(`automation run: run=mock-run status=${status}`));
      expect(process.exitCode).toBe(expected);
    } finally { process.argv = argv; process.exitCode = previous; }
  });
});
