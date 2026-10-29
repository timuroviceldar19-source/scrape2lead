import { describe, it, expect } from "vitest";
import { loadConfig } from "../../scripts/sales-pult.mjs";

describe("sales-pult.mts script import", () => {
  it("imports scripts/sales-pult.mts and loads config without errors", () => {
    expect(typeof loadConfig).toBe("function");
    const cfg = loadConfig();
    expect(cfg.portal).toBeDefined();
    expect(cfg.chatDialogId).toBeDefined();
  });
});
