import { describe, expect, it } from "vitest";
import { validateCollectorText } from "../../src/automation/config.js";

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
