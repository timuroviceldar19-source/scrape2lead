import { describe, expect, it } from "vitest";
import { parseCounterpartyPayload, parseLiquidationPayload } from "../../src/kz/kgdResponseParser.js";

describe("KGD payload parser", () => {
  it("supports the real misspelled ESF field and accumulates unreliable reasons", () => {
    const parsed = parseCounterpartyPayload({ bin: "000240001420", name: "ТОО Тест", vatPayer: true, esfRestrinctions: true, invalidRegistration: true, inactivity: true });
    expect(parsed.esfRestricted).toBe(true);
    expect(parsed.unreliable).toBe(true);
    expect(parsed.unreliableReasons).toHaveLength(2);
  });

  it("accepts the corrected ESF alias and detects contradictory VAT", () => {
    const parsed = parseCounterpartyPayload({ bin: "000240001420", esfRestrictions: true, vatPayer: true, vatRemoved: true });
    expect(parsed.esfRestricted).toBe(true);
    expect(parsed.vat.status).toBe("contradictory");
  });

  it("parses liquidation flag and date", () => expect(parseLiquidationPayload({ isLiquidated: true, liquidationStartDate: "10.07.2026" })).toEqual({ active: true, startDate: "2026-07-10" }));
});
