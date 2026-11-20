import { describe, expect, it, vi } from "vitest";
import { findZakupRevisionDeal, isZakupPlanUrl } from "../../src/bitrix/gzZakupRevisionLink.js";

const deal = (id: number, planNumber: string, planPointId = planNumber) => ({
  ID: String(id), ORIGINATOR_ID: "scrape2lead-gz-plans", ORIGIN_ID: `gz-plan:${planPointId}`,
  UF_CRM_PLAN_ID: planNumber, UF_CRM_6A436D5A3614C: planPointId
});

describe("isZakupPlanUrl", () => {
  it("recognises plan item pages of zakup.gov.kz only", () => {
    expect(isZakupPlanUrl("https://zakup.gov.kz/plan-items/318897016")).toBe(true);
    expect(isZakupPlanUrl("https://procurement.gov.kz/ru/registry/show_plan/88552758/4946559")).toBe(false);
    expect(isZakupPlanUrl("https://zakup.gov.kz.example.com/plan-items/1")).toBe(false);
    expect(isZakupPlanUrl("")).toBe(false);
  });
});

describe("findZakupRevisionDeal", () => {
  it("links a new zakup point to the deal whose plan number leads to it", async () => {
    const chain = vi.fn(async (number: string) => (number === "88461537" ? ["88461537", "88720946"] : []));

    const result = await findZakupRevisionDeal("88720946", [deal(56155, "88461537")], chain);

    expect(result).toEqual({ duplicate: { deal: deal(56155, "88461537"), reason: "plan revision", blocking: true }, unverified: [] });
  });

  it("tries the deal's plan point when zakup does not know the plan number", async () => {
    const chain = vi.fn(async (number: string) => (number === "88552758" ? ["88552758", "88760001"] : []));

    const result = await findZakupRevisionDeal("88760001", [deal(57001, "88519423", "88552758")], chain);

    expect(result.duplicate?.deal.ID).toBe("57001");
    expect(chain.mock.calls.map(([number]) => number)).toEqual(["88519423", "88552758"]);
  });

  it("does not link a point to unrelated deals of the same customer and item", async () => {
    const chain = vi.fn(async (number: string) => (number === "87724944" ? ["87724944", "87725000"] : ["88519511", "88709238"]));

    const result = await findZakupRevisionDeal("88709238", [deal(45377, "87724944"), deal(56323, "88519511")], chain);

    expect(result.duplicate?.deal.ID).toBe("56323");
  });

  it("reports deals it could not check when zakup knows none of their numbers", async () => {
    const result = await findZakupRevisionDeal("88705374", [deal(47083, "85645905")], async () => []);

    expect(result).toEqual({ duplicate: null, unverified: ["47083"] });
  });

  it("treats an unconfirmable point with the deal's exact plan amount as that deal's revision", async () => {
    // 88182883: 9 ноутбуков на 4 230 000 ₸ — та же закупка, что сделка 42927, но zakup не знает её номеров.
    const known = { ...deal(42927, "82360341", "87293259"), UF_CRM_1715597423325: "4230000.00", OPPORTUNITY: "4230000.00" };

    const result = await findZakupRevisionDeal("88182883", [known], async () => [], { amount: 4230000 });

    expect(result).toEqual({ duplicate: { deal: known, reason: "plan revision (same amount)", blocking: true }, unverified: [] });
  });

  it("keeps an unconfirmable point with a different amount as a new deal with a warning", async () => {
    const other = { ...deal(49141, "88269801"), UF_CRM_1715597423325: "2240000.00", OPPORTUNITY: "2240000.00" };

    const result = await findZakupRevisionDeal("88594776", [other], async () => [], { amount: 1483047.9 });

    expect(result).toEqual({ duplicate: null, unverified: ["49141"] });
  });

  it("trusts zakup over the amount when zakup knows the deal and shows other versions", async () => {
    const same = { ...deal(48493, "88148729"), UF_CRM_1715597423325: "850000.00" };

    const result = await findZakupRevisionDeal("88721827", [same], async () => ["88148729"], { amount: 850000 });

    expect(result).toEqual({ duplicate: null, unverified: [] });
  });

  it("leaves a point alone when zakup shows other versions only", async () => {
    const result = await findZakupRevisionDeal("88721827", [deal(48493, "88148729")], async () => ["88148729"]);

    expect(result).toEqual({ duplicate: null, unverified: [] });
  });

  it("ignores the row's own deal and asks zakup once per number", async () => {
    const chain = vi.fn(async () => ["88700001"]);

    const result = await findZakupRevisionDeal("88700001", [deal(1, "88700001"), deal(2, "88700001")], chain);

    expect(result).toEqual({ duplicate: null, unverified: [] });
    expect(chain).not.toHaveBeenCalled();
  });

  it("caches chain lookups across rows through the shared lookup", async () => {
    const chain = vi.fn(async (_number: string) => ["88461537", "88720946"]);
    const cached = new Map<string, Promise<string[]>>();
    const lookup = (number: string) => {
      if (!cached.has(number)) cached.set(number, chain(number));
      return cached.get(number)!;
    };

    await findZakupRevisionDeal("88720946", [deal(56155, "88461537")], lookup);
    await findZakupRevisionDeal("88720999", [deal(56155, "88461537")], lookup);

    expect(chain).toHaveBeenCalledTimes(1);
  });
});
