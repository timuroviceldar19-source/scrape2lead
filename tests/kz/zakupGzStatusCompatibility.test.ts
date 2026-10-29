import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchGzPlans } from "../../src/kz/zakupGzPlans.js";
import { decideGzDealOutcome, isSignedGzPlanStatus } from "../../src/bitrix/gzDealOutcome.js";
import { getStatusRank } from "../../src/bitrix/gzPlanStatusRefresh.js";

interface Status { id: number; egz_code: string; name: string }
const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/zakup-gz-statuses.json", import.meta.url), "utf8")) as { plans: Status[]; contracts: Status[] };
const ref = { planNumber: 100, pointIds: [200], revisionIds: [], planNumberVerified: true, enstruCode: "279020.100.000002", itemName: "Экран" };
const config = { ourBins: ["990000000002"], partnerBins: [], itemFamilies: { groups: [], wildcards: [] } };

describe("совместимость публичных статусов ЭГЗ с прежними решениями", () => {
  it.each([
    ["2", 0], ["444", 0], ["445", 0], ["6", 0], ["5", 1], ["25", 2],
    ["3", 3], ["26", 3], ["13", 3], ["27", 3], ["12", 3], ["22", 3], ["23", 3], ["550", 3], ["540", 3],
    ["9", 4], ["10", 4], ["11", 4], ["7", 4], ["21", 4],
    ["310", 5], ["18", 5], ["350", 5], ["400", 5], ["16", 6], ["320", 6],
    ["19", 7], ["410", 7], ["340", 7], ["20", 7], ["29", null]
  ] as const)("статус пункта с кодом ЭГЗ %s сохраняет ранг %s и решение об исходе", async (code, rank) => {
    const status = fixture.plans.find(row => row.egz_code === code)!;
    expect(status).toBeDefined();
    const fetchFn = (async (url: string) => new Response(JSON.stringify(new URL(url).pathname.endsWith("/plan-items/")
      ? { count: 1, results: [{ id: 500, external_id: 200 }] }
      : { id: 500, external_id: 200, organization: { iin_bin: "990000000001" }, year: { year: 2026 }, status }))) as typeof fetch;
    const [plan] = await fetchGzPlans([100], "root", { fetchFn, pauseMs: 0, contexts: new Map([[100, { bin: "990000000001", year: 2026 }]]) });
    const name = plan.RefPlnPointStatus!.nameRu!;
    expect(getStatusRank(name)).toBe(rank);
    expect(isSignedGzPlanStatus(name)).toBe(["310", "16", "19", "29"].includes(code));
    const outcomes: Record<string, string> = { "5": "published", "10": "failed", "7": "cancelled", "20": "cancelled", "310": "contract-draft" };
    expect(decideGzDealOutcome(ref, [], { status: name, repurposedTo: null }, config)?.kind ?? null).toBe(outcomes[code] ?? null);
  });

  it.each([
    ["190", "won"], ["390", "won"], ["460", "won"], ["450", "won"],
    ["340", "terminated"], ["350", "terminated"], ["455", null]
  ] as const)("договор с кодом ЭГЗ %s сохраняет исход %s", (code, expected) => {
    const status = fixture.contracts.find(row => row.egz_code === code)!;
    expect(status).toBeDefined();
    const contract = { contractNumberSys: "990000000001/260001/00", signDate: "2026-10-29", supplierBiin: "990000000002", RefContractStatus: { nameRu: status.name }, ContractUnits: [{ plnPointId: 200, totalSum: 100, Plans: { rootrecordId: 100 } }] };
    expect(decideGzDealOutcome(ref, [contract], { status: null, repurposedTo: null }, config)?.kind ?? null).toBe(expected);
  });
});
