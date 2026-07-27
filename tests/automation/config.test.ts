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

  it("loads the F3 config as an f3-b2b workflow over the external procurement collector", () => {
    const config = loadAutomationConfig("config/automation.f3.json");
    expect(config.workflow).toBe("f3-b2b");
    expect(config.procurementConfig).toBe("config/procurement-sources.f3.json");
    expect(config.runsDir).toBe("runs/f3");
    // «Текущий месяц плюс следующие шесть» — это семь месяцев, а не шесть.
    expect(config.periodMonths).toBe(7);
  });

  it("enables F3 delivery after the cutover gates are proven", () => {
    expect(loadAutomationConfig("config/automation.f3.json").deliveryMode).toBe("push");
    expect(loadAutomationConfig("config/automation.pk.json").deliveryMode).toBe("push");
  });

  it("gives F3 its own lock so a stuck GZ collection cannot block it", () => {
    const f3 = loadAutomationConfig("config/automation.f3.json").lockPath;
    expect(f3).not.toBe(loadAutomationConfig("config/automation.json").lockPath);
    expect(f3).not.toBe(loadAutomationConfig("config/automation.pk.json").lockPath);
  });

  it("does not demand the GZ collector configs for an F3 run", () => {
    const config = loadAutomationConfig("config/automation.f3.json");
    expect(config.plansConfig).toBe("config/gz-plans.json");
    expect(() => loadAutomationConfig("config/automation.f3.json")).not.toThrow();
  });
});
