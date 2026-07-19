import { describe, expect, it } from "vitest";
import { evaluateCounterpartyRisk } from "../../src/kz/kgdTrafficLight.js";
import type { CounterpartyCheck } from "../../src/kz/kgdCounterpartyTypes.js";

const base = (overrides: Partial<CounterpartyCheck> = {}): CounterpartyCheck => ({
  bin: "000240001420", name: "Test", validBin: true, vat: { status: "registered" }, bankruptcy: false,
  liquidation: { active: false }, esfRestricted: false, unreliable: false, unreliableReasons: [],
  bulkChecks: [{ source: "insolvent", status: "complete", matched: false, cacheAgeHours: 1, sourceUrl: "https://kgd.gov.kz", listDate: "2026-07-10" }],
  stages: { counterparty: "complete", liquidation: "complete", bulk: "complete" }, checkedAt: "2026-07-19T00:00:00.000Z", links: [],
  ...overrides
});

describe("KGD traffic light", () => {
  it.each([
    ["bankruptcy", { bankruptcy: true }], ["liquidation", { liquidation: { active: true, startDate: "2026-01-01" } }],
    ["ESF", { esfRestricted: true }], ["unreliable", { unreliable: true, unreliableReasons: ["бездействие"] }],
    ["VAT removal", { vat: { status: "removed", removedAt: "2026-01-01" } }]
  ])("makes %s red", (_name, overrides) => expect(evaluateCounterpartyRisk(base(overrides as Partial<CounterpartyCheck>)).color).toBe("red"));

  it("keeps never-registered VAT green with an explanation", () => {
    const result = evaluateCounterpartyRisk(base({ vat: { status: "never_registered" } }));
    expect(result.color).toBe("green");
    expect(result.explanations).toContain("не плательщик НДС");
  });

  it("makes incomplete bulk override yellow while retaining both explanations", () => {
    const result = evaluateCounterpartyRisk(base({ vat: { status: "removed" }, bulkChecks: [{ source: "insolvent", status: "stale_negative", matched: false, cacheAgeHours: 48, sourceUrl: "x", listDate: "2026-07-10" }] }));
    expect(result.color).toBe("gray");
    expect(result.explanations.join(" ")).toMatch(/НДС.*дат/i);
    expect(result.explanations.join(" ")).toMatch(/устар/i);
  });

  it("keeps a <=7 day cached match red and includes list date", () => {
    const result = evaluateCounterpartyRisk(base({ bulkChecks: [{ source: "insolvent", status: "fallback", matched: true, cacheAgeHours: 72, sourceUrl: "x", listDate: "2026-07-10" }] }));
    expect(result.color).toBe("red");
    expect(result.explanations.join(" ")).toContain("10.07.2026");
  });
});
