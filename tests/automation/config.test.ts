import { describe, expect, it } from "vitest";
import { loadAutomationConfig, validateCollectorText } from "../../src/automation/config.js";

describe("automation config validation", () => {
  it("accepts valid Cyrillic collector values", () => {
    expect(() => validateCollectorText("lots", ["компьютер", "Опубликован"])).not.toThrow();
  });

  it("rejects mojibake before a network collector starts", () => {
    expect(() => validateCollectorText("lots", ["РєРѕРјРїСЊСЋС‚РµСЂ"])).toThrow(/encoding/i);
  });

  it("rejects blank collector values", () => {
    expect(() => validateCollectorText("plans", ["панель", " "])).toThrow(/blank/i);
  });
});

describe("automation workflow config", () => {
  it("loads the daily config as a full plans-and-lots workflow", () => {
    const config = loadAutomationConfig("config/automation.json");
    expect(config.workflow).toBe("plans-and-lots");
    expect(config.runsDir).toBe("runs");
  });

  it("loads the PK config as a plans-only workflow over the PK plans collector", () => {
    const config = loadAutomationConfig("config/automation.pk.json");
    expect(config.workflow).toBe("plans-only");
    expect(config.plansConfig).toBe("config/gz-plans.pk.json");
    expect(config.runsDir).toBe("runs/pk");
  });

  it("shares one prepare lock so the daily and PK tasks never collect at once", () => {
    expect(loadAutomationConfig("config/automation.pk.json").lockPath)
      .toBe(loadAutomationConfig("config/automation.json").lockPath);
  });
});
