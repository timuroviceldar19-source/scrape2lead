import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCounterpartyChecks } from "../../src/kz/kgdCounterpartyWorkflow.js";

describe("resumable counterparty workflow", () => {
  it("continues after CAPTCHA interruption without repeating completed stages", async () => {
    const progressPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kgd-flow-")), "progress.json");
    const counterparty = vi.fn(async () => ({ bin: "000240001420", name: "A", vat: { status: "registered" as const }, bankruptcy: false, esfRestricted: false, unreliable: false, unreliableReasons: [] }));
    const liquidation = vi.fn().mockRejectedValueOnce(new Error("CAPTCHA_REQUIRED")).mockResolvedValueOnce({ active: false });
    const bulk = vi.fn(async () => []);
    const first = await runCounterpartyChecks(["000240001420"], { progressPath, checkCounterparty: counterparty, checkLiquidation: liquidation, checkBulk: bulk });
    expect(first[0].color).toBe("gray");
    const second = await runCounterpartyChecks(["000240001420"], { progressPath, checkCounterparty: counterparty, checkLiquidation: liquidation, checkBulk: bulk });
    expect(second[0].color).toBe("green");
    expect(counterparty).toHaveBeenCalledTimes(1); expect(liquidation).toHaveBeenCalledTimes(2); expect(bulk).toHaveBeenCalledTimes(1);
  });
});
