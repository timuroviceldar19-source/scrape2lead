import { describe, expect, it } from "vitest";
import {
  buildGzPlanRevisionComment,
  buildGzPlanRevisionFields,
  detectGzPlanRevision,
  findAmbiguousRevisionDealIds,
  type GzPlanRevisionDeal,
  type GzPlanRevisionRow
} from "../../src/bitrix/gzPlanRevision.js";

const ORIGINATOR = "scrape2lead-gz-plans";

// Real case from run 20261005-084059: plan 87568873 (ясли-сад «Булбул») was
// re-issued as point 88072082 at 1 000 000 ₸, deal 44245 still says 900 000 ₸.
function bulbulDeal(overrides: Partial<GzPlanRevisionDeal> = {}): GzPlanRevisionDeal {
  return {
    ID: "44245",
    ORIGINATOR_ID: ORIGINATOR,
    CLOSED: "N",
    OPPORTUNITY: "900000.00000000",
    UF_CRM_1715597423325: "900000.00",
    UF_CRM_6627AEBD67FFF: "2",
    ...overrides
  };
}

function bulbulRow(overrides: Partial<GzPlanRevisionRow> = {}): GzPlanRevisionRow {
  return {
    amount: 1_000_000,
    quantity: "2",
    price: "500 000.00",
    pricePerUnit: 500_000,
    status: "Утвержден",
    planUrl: "https://procurement.gov.kz/ru/registry/show_plan/88072082/4900001",
    ...overrides
  };
}

describe("detectGzPlanRevision", () => {
  it("detects a changed plan amount on an open integration deal", () => {
    expect(detectGzPlanRevision(bulbulRow(), bulbulDeal(), ORIGINATOR)).toEqual({
      dealId: "44245",
      previousAmount: 900_000,
      amount: 1_000_000,
      previousQuantity: "2",
      quantity: "2",
      updatesOpportunity: true
    });
  });

  it("detects a changed quantity even when the amount is the same", () => {
    const revision = detectGzPlanRevision(bulbulRow({ amount: 900_000, quantity: "3" }), bulbulDeal(), ORIGINATOR);
    expect(revision?.previousQuantity).toBe("2");
    expect(revision?.quantity).toBe("3");
  });

  it("ignores rounding noise below one tenge and quantity formatting", () => {
    const row = bulbulRow({ amount: 900_000.4, quantity: "2,000" });
    expect(detectGzPlanRevision(row, bulbulDeal(), ORIGINATOR)).toBeNull();
  });

  it("leaves closed deals alone: their amount is history now", () => {
    expect(detectGzPlanRevision(bulbulRow(), bulbulDeal({ CLOSED: "Y" }), ORIGINATOR)).toBeNull();
  });

  it("never touches deals created by hand or by another integration", () => {
    expect(detectGzPlanRevision(bulbulRow(), bulbulDeal({ ORIGINATOR_ID: null }), ORIGINATOR)).toBeNull();
    expect(detectGzPlanRevision(bulbulRow(), bulbulDeal({ ORIGINATOR_ID: "scrape2lead-gz-lots" }), ORIGINATOR)).toBeNull();
  });

  it("keeps a deal amount the manager changed by hand", () => {
    const revision = detectGzPlanRevision(bulbulRow(), bulbulDeal({ OPPORTUNITY: "850000" }), ORIGINATOR);
    expect(revision?.previousAmount).toBe(900_000);
    expect(revision?.updatesOpportunity).toBe(false);
  });

  it("falls back to the deal amount when the stored plan amount is empty", () => {
    const revision = detectGzPlanRevision(bulbulRow(), bulbulDeal({ UF_CRM_1715597423325: "" }), ORIGINATOR);
    expect(revision?.previousAmount).toBe(900_000);
    expect(revision?.updatesOpportunity).toBe(true);
  });

  it("does not compare quantities it cannot read", () => {
    const row = bulbulRow({ amount: 900_000, quantity: "" });
    expect(detectGzPlanRevision(row, bulbulDeal(), ORIGINATOR)).toBeNull();
  });
});

describe("buildGzPlanRevisionFields", () => {
  it("rewrites only the plan money, quantity and status fields", () => {
    const row = bulbulRow();
    const revision = detectGzPlanRevision(row, bulbulDeal(), ORIGINATOR)!;

    expect(buildGzPlanRevisionFields(row, revision)).toEqual({
      OPPORTUNITY: 1_000_000,
      UF_CRM_1715597423325: "1000000.00",
      UF_CRM_6627AEBD5E68B: "500 000.00",
      UF_CRM_6627AEBD67FFF: "2",
      UF_CRM_COUNT: "2",
      UF_CRM_PRICE_PER_UNIT: "500000|KZT",
      UF_CRM_6627AEBD85B4D: "Утвержден",
      UF_CRM_PLAN_STATUS: "Утвержден"
    });
  });

  it("omits OPPORTUNITY when the manager set the deal amount by hand", () => {
    const row = bulbulRow();
    const revision = detectGzPlanRevision(row, bulbulDeal({ OPPORTUNITY: "850000" }), ORIGINATOR)!;

    expect(buildGzPlanRevisionFields(row, revision)).not.toHaveProperty("OPPORTUNITY");
  });
});

describe("buildGzPlanRevisionComment", () => {
  it("tells the manager what changed and where the new version lives", () => {
    const row = bulbulRow({ quantity: "3" });
    const revision = detectGzPlanRevision(row, bulbulDeal(), ORIGINATOR)!;
    const comment = buildGzPlanRevisionComment(row, revision);

    expect(comment).toContain("План изменён");
    expect(comment).toMatch(/Сумма: 900\s000 → 1\s000\s000 ₸/);
    expect(comment).toContain("Количество: 2 → 3");
    expect(comment).toContain(row.planUrl);
    expect(comment).not.toContain("вручную");
  });

  it("skips the quantity line when only the amount moved", () => {
    const row = bulbulRow();
    const comment = buildGzPlanRevisionComment(row, detectGzPlanRevision(row, bulbulDeal(), ORIGINATOR)!);
    expect(comment).not.toContain("Количество");
  });

  it("explains why the deal amount stayed put", () => {
    const row = bulbulRow();
    const revision = detectGzPlanRevision(row, bulbulDeal({ OPPORTUNITY: "850000" }), ORIGINATOR)!;
    expect(buildGzPlanRevisionComment(row, revision)).toContain("вручную");
  });
});

describe("findAmbiguousRevisionDealIds", () => {
  it("flags a deal that two rows of one run want to rewrite", () => {
    expect(findAmbiguousRevisionDealIds(["44245", "42793", "44245", "43119"])).toEqual(new Set(["44245"]));
  });

  it("returns nothing when every deal is revised once", () => {
    expect(findAmbiguousRevisionDealIds(["44245", "42793"]).size).toBe(0);
  });
});
