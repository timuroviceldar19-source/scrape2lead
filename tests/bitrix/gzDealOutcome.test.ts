import { describe, expect, it } from "vitest";
import {
  buildGzDealOutcomeComment,
  buildGzDealPlanRef,
  contractBaseNumber,
  dealBin,
  decideGzDealOutcome,
  findPlanContracts,
  gzDealOutcomeKey,
  isSameGzItem,
  readGzPlanSignal,
  shouldReplaceGzOutcomeKey,
  type GzDealOutcome,
  type GzDealPlanRef,
  type GzItemFamilies,
  type GzOutcomeConfig,
  type GzOutcomeContract,
  type GzPlanSignal
} from "../../src/bitrix/gzDealOutcome.js";

const F3 = "061140003942";
// Same families as config/gz-deal-outcomes.json.
const FAMILIES: GzItemFamilies = {
  groups: [
    ["262030.100.000021", "279020"],
    ["262011", "262013", "262040.000.000267", "265152.790.000067"]
  ],
  wildcards: ["329959.900.000019", "329953.000"]
};
const CONFIG: GzOutcomeConfig = { ourBins: [F3], partnerBins: ["555555555555"], itemFamilies: FAMILIES };
const NO_PLAN: GzPlanSignal = { status: null, repurposedTo: null };
const status = (value: string | null): GzPlanSignal => ({ status: value, repurposedTo: null });

const REF: GzDealPlanRef = {
  planNumber: 87777759,
  pointIds: [88029694],
  enstruCode: "262013.000.000011",
  itemName: "Компьютер"
};

function contract(overrides: Partial<GzOutcomeContract> & { units?: GzOutcomeContract["ContractUnits"] }): GzOutcomeContract {
  const { units, ...rest } = overrides;
  return {
    contractNumberSys: "990340007507/260547/00",
    signDate: "2026-09-15 10:00:00",
    supplierBiin: F3,
    Supplier: { nameRu: "ТОО \"F3.kz\"" },
    RefContractStatus: { nameRu: "Действует" },
    deleted: 0,
    ContractUnits: units ?? [{ plnPointId: 88029694, totalSum: 1_100_000, refEnstruCode: "262013.000.000011", Plans: { rootrecordId: 87777759, nameRu: "Компьютер" } }],
    ...rest
  };
}

function revisionUnit(code: string, name: string, totalSum = 900_000) {
  return [{ plnPointId: 88111111, totalSum, refEnstruCode: code, Plans: { rootrecordId: 87777759, nameRu: name } }];
}

describe("findPlanContracts", () => {
  it("matches a contract unit by the deal's own plan point", () => {
    expect(findPlanContracts(REF, [contract({})], FAMILIES)).toHaveLength(1);
  });

  it("follows a revision of the point when the item class stays the same", () => {
    // Deal 44853: «Моноблок» revised into «Компьютер», both ENSTRU 262013.
    expect(findPlanContracts(REF, [contract({ units: revisionUnit("262013.000.000005", "Моноблок") })], FAMILIES)).toHaveLength(1);
  });

  it("refuses a revision rewritten into another item", () => {
    // Deal 44643: a panel point became «Плинтус» and was bought as skirting boards.
    expect(findPlanContracts(REF, [contract({ units: revisionUnit("279020.300.000001", "Плинтус") })], FAMILIES)).toEqual([]);
  });

  it("compares names when the deal has no ENSTRU code", () => {
    const june: GzDealPlanRef = { ...REF, enstruCode: null, itemName: "Панель интерактивная" };
    expect(findPlanContracts(june, [contract({ units: revisionUnit("", "Панель интерактивная 86\"") })], FAMILIES)).toHaveLength(1);
    // Deal 38743: June panel deal, the root record turned out to be a knife.
    expect(findPlanContracts(june, [contract({ units: revisionUnit("", "Нож") })], FAMILIES)).toEqual([]);
  });

  it("accepts a single unit object instead of an array", () => {
    const single = contract({ units: { plnPointId: 88029694, totalSum: 1, Plans: null } });
    expect(findPlanContracts(REF, [single], FAMILIES)).toHaveLength(1);
  });

  it("ignores other points of the same customer and deleted contracts", () => {
    const other = contract({ units: [{ plnPointId: 1, totalSum: 5, Plans: { rootrecordId: 2 } }] });
    expect(findPlanContracts(REF, [other, contract({ deleted: 1 })], FAMILIES)).toEqual([]);
  });
});

describe("decideGzDealOutcome from contracts", () => {
  it("counts a supplementary agreement once and keeps the original signing date", () => {
    // Deal 46313: /00 became «Изменен» when /01 was signed on 02.10.
    const outcome = decideGzDealOutcome(REF, [
      contract({ contractNumberSys: "990340007507/260547/00", signDate: "2026-09-15 10:00:00", RefContractStatus: { nameRu: "Изменен" } }),
      contract({ contractNumberSys: "990340007507/260547/01", signDate: "2026-10-02 11:00:00" })
    ], NO_PLAN, CONFIG);

    expect(outcome).toEqual({
      kind: "won",
      contractNumber: "990340007507/260547",
      signDate: "2026-09-15",
      supplierBin: F3,
      supplierName: "ТОО \"F3.kz\"",
      unitSum: 1_100_000,
      otherContracts: 0
    });
  });

  it("reports a competitor's contract as lost", () => {
    const outcome = decideGzDealOutcome(REF, [
      contract({ supplierBiin: "190540009117", Supplier: { nameRu: "ТОО \"QTrade Company\"" } })
    ], status("Договор действует"), CONFIG);
    expect(outcome?.kind).toBe("lost");
  });

  it("tells partners apart from competitors", () => {
    expect(decideGzDealOutcome(REF, [contract({ supplierBiin: "555555555555" })], NO_PLAN, CONFIG)?.kind).toBe("partner");
  });

  it("names the largest supplier of a point bought in parts and counts the rest", () => {
    const outcome = decideGzDealOutcome(REF, [
      contract({ contractNumberSys: "1/10/00", supplierBiin: "111111111111", units: [{ plnPointId: 88029694, totalSum: 200_000 }] }),
      contract({ contractNumberSys: "1/11/00", supplierBiin: "222222222222", units: [{ plnPointId: 88029694, totalSum: 700_000 }] })
    ], NO_PLAN, CONFIG);

    expect(outcome).toMatchObject({ kind: "lost", supplierBin: "222222222222", unitSum: 700_000, otherContracts: 1 });
  });

  it("calls it a win when we hold any part of a split point", () => {
    const outcome = decideGzDealOutcome(REF, [
      contract({ contractNumberSys: "1/10/00", supplierBiin: "111111111111", units: [{ plnPointId: 88029694, totalSum: 700_000 }] }),
      contract({ contractNumberSys: "1/11/00", units: [{ plnPointId: 88029694, totalSum: 200_000 }] })
    ], NO_PLAN, CONFIG);

    expect(outcome).toMatchObject({ kind: "won", unitSum: 200_000, otherContracts: 1 });
  });

  it("follows the purchase to the new supplier after a termination", () => {
    // Deal 46063: the first contract was terminated, a second one went to another supplier.
    const outcome = decideGzDealOutcome(REF, [
      contract({ contractNumberSys: "170740006384/260029/01", signDate: "2026-08-01 10:00:00", supplierBiin: "260540011095", RefContractStatus: { nameRu: "Расторгнут по соглашению сторон" } }),
      contract({ contractNumberSys: "170740006384/260047/00", signDate: "2026-09-10 10:00:00", supplierBiin: "190540009117" })
    ], NO_PLAN, CONFIG);

    expect(outcome).toMatchObject({ kind: "lost", contractNumber: "170740006384/260047", otherContracts: 0 });
  });

  it("flags a terminated contract with no replacement: the purchase may come back", () => {
    // Deal 44649.
    const outcome = decideGzDealOutcome(REF, [
      contract({ contractNumberSys: "990440002956/260003/00", RefContractStatus: { nameRu: "Изменен" }, supplierBiin: "890429401122" }),
      contract({ contractNumberSys: "990440002956/260003/01", RefContractStatus: { nameRu: "Расторгнут по соглашению сторон" }, supplierBiin: "890429401122" })
    ], status("Договор действует"), CONFIG);

    expect(outcome?.kind).toBe("terminated");
  });

  it("prefers the contract over the plan status", () => {
    expect(decideGzDealOutcome(REF, [contract({})], status("Опубликован"), CONFIG)?.kind).toBe("won");
  });

  it("reports a point rewritten into another item from its contract", () => {
    const outcome = decideGzDealOutcome(REF, [
      contract({ supplierBiin: "190540009117", units: revisionUnit("279020.300.000001", "Плинтус", 504_000) })
    ], status("Договор действует"), CONFIG);

    expect(outcome).toEqual({ kind: "repurposed", newItem: "Плинтус" });
  });

  it("stays silent on a mismatching revision when the deal has no code to be sure", () => {
    const june: GzDealPlanRef = { ...REF, enstruCode: null, itemName: "Панель интерактивная" };
    expect(decideGzDealOutcome(june, [contract({ units: revisionUnit("", "Нож") })], NO_PLAN, CONFIG)).toBeNull();
  });
});

describe("decideGzDealOutcome from the plan register", () => {
  it.each([
    ["Опубликован", "published"],
    ["Закупка не состоялась", "failed"],
    ["Отменен", "cancelled"],
    ["Отказ от закупки", "cancelled"],
    ["Договор действует", "signed-unknown"],
    ["Исполнен", "signed-unknown"],
    ["Проект договора", "signed-unknown"]
  ])("maps «%s» to %s", (value, kind) => {
    expect(decideGzDealOutcome(REF, [], status(value), CONFIG)?.kind).toBe(kind);
  });

  it.each(["Утвержден", "На проверке камерального контроля", "Изменен", null])(
    "stays silent while the plan is still «%s»",
    (value) => {
      expect(decideGzDealOutcome(REF, [], status(value), CONFIG)).toBeNull();
    }
  );

  it("reports a rewrite the plan register revealed", () => {
    expect(decideGzDealOutcome(REF, [], { status: null, repurposedTo: "Кондиционер" }, CONFIG))
      .toEqual({ kind: "repurposed", newItem: "Кондиционер" });
  });
});

describe("readGzPlanSignal", () => {
  it("trusts the status of the deal's own point", () => {
    expect(readGzPlanSignal(REF, { status: "Опубликован", enstruCode: "279020.300.000001", name: "Плинтус", exactPoint: true }, FAMILIES))
      .toEqual({ status: "Опубликован", repurposedTo: null });
  });

  it("trusts a revision of the same item class", () => {
    expect(readGzPlanSignal(REF, { status: "Опубликован", enstruCode: "262013.000.000005", name: "Моноблок", exactPoint: false }, FAMILIES))
      .toEqual({ status: "Опубликован", repurposedTo: null });
  });

  it("turns a revision into another item into a rewrite instead of its status", () => {
    // Deal 41469: «Компьютер» point, the live revision is an air conditioner.
    expect(readGzPlanSignal(REF, { status: "Опубликован", enstruCode: "282515.000.000001", name: "Кондиционер", exactPoint: false }, FAMILIES))
      .toEqual({ status: null, repurposedTo: "Кондиционер" });
  });

  it("drops a mismatching revision without claiming a rewrite when only names differ", () => {
    // Registry search rows carry no code; «Моноблок» vs «Компьютер» proves nothing.
    expect(readGzPlanSignal(REF, { status: "Опубликован", enstruCode: null, name: "Моноблок", exactPoint: false }, FAMILIES))
      .toEqual({ status: null, repurposedTo: null });
  });

  it("returns nothing for an unknown plan", () => {
    expect(readGzPlanSignal(REF, null, FAMILIES)).toEqual(NO_PLAN);
  });
});

describe("isSameGzItem", () => {
  // False rewrites from the first dry run on 2026-10-05.
  it.each([
    ["LCD panel revised into an interactive one (deal 44217)", "279020.100.000004", "Панель жидкокристаллическая", "262030.100.000021", "Панель интерактивная"],
    ["computer re-coded under 265152 (deal 44739)", "262013.000.000011", "Компьютер", "265152.790.000067", "Компьютер"],
    ["panel moved into a training kit wrapper (deal 45259)", "329959.900.000019", "Комплект учебного оборудования", "262030.100.000021", "Панель интерактивная"],
    ["LCD panel re-coded as a screen (deal 40447)", "262030.100.000021", "Панель интерактивная", "279020.500.000012", "Экран"]
  ])("keeps %s", (_case, dealCode, dealName, code, name) => {
    expect(isSameGzItem({ ...REF, enstruCode: dealCode, itemName: dealName }, code, name, FAMILIES)).toBe(true);
  });

  it.each([
    ["a paper shredder sharing class 262030 with panels (deal 42809)", "262011.100.000002", "Ноутбук", "262030.100.000028", "Уничтожитель бумаги и дисков"],
    ["an air conditioner (deal 41469)", "262013.000.000011", "Компьютер", "282512.300.000000", "Кондиционер"],
    ["a leather «Планшет» folder (deal 45681)", "262011.100.000004", "Ноутбук", "151212.900.000087", "Планшет"],
    ["skirting boards (deal 44643)", "279020.100.000003", "Панель жидкокристаллическая", "161021.100.000001", "Плинтус"]
  ])("rejects %s", (_case, dealCode, dealName, code, name) => {
    expect(isSameGzItem({ ...REF, enstruCode: dealCode, itemName: dealName }, code, name, FAMILIES)).toBe(false);
  });

  it("lets the codes overrule a shared first word", () => {
    const lcd: GzDealPlanRef = { ...REF, enstruCode: "279020.100.000004", itemName: "Панель жидкокристаллическая" };
    expect(isSameGzItem(lcd, "222319.500.000001", "Панель стеновая", FAMILIES)).toBe(false);
  });

  it("compares code families, then first words when a code is missing, else gives up", () => {
    expect(isSameGzItem(REF, "262013.000.000012", "Моноблок", FAMILIES)).toBe(true);
    expect(isSameGzItem(REF, "262030.100.000021", "Панель интерактивная", FAMILIES)).toBe(false);
    expect(isSameGzItem({ ...REF, enstruCode: null }, null, "Компьютер персональный", FAMILIES)).toBe(true);
    expect(isSameGzItem({ ...REF, enstruCode: null, itemName: null }, null, "Нож", FAMILIES)).toBeNull();
  });
});

describe("shouldReplaceGzOutcomeKey", () => {
  it.each([
    [null, "published:опубликован", true, "first event"],
    ["published:опубликован", "published:опубликован", false, "same event"],
    ["published:опубликован", "lost:1/2", true, "a contract after the announcement"],
    ["lost:1/2", "won:1/3", true, "a new contract"],
    ["won:1/2", "signed-unknown:договор действует", false, "the contract fetch hiccuped"],
    ["lost:1/2", "published:опубликован", false, "stale plan status"],
    ["repurposed:плинтус", "cancelled:отменен", false, "rewrite already reported"],
    ["won:1/2", "terminated:1/2", true, "our contract was terminated"],
    ["terminated:1/2", "published:опубликован", true, "re-announced after termination"]
  ] as Array<[string | null, string, boolean, string]>)("%s → %s: %s (%s)", (stored, next, expected) => {
    expect(shouldReplaceGzOutcomeKey(stored, next)).toBe(expected);
  });
});

describe("gzDealOutcomeKey", () => {
  it("does not depend on the API order when split contracts tie", () => {
    const a = contract({ contractNumberSys: "1/10/00", signDate: "2026-09-01 10:00:00", supplierBiin: "111111111111", units: [{ plnPointId: 88029694, totalSum: null }] });
    const b = contract({ contractNumberSys: "1/11/00", signDate: "2026-09-05 10:00:00", supplierBiin: "222222222222", units: [{ plnPointId: 88029694, totalSum: null }] });
    const first = gzDealOutcomeKey(decideGzDealOutcome(REF, [a, b], NO_PLAN, CONFIG)!);
    const second = gzDealOutcomeKey(decideGzDealOutcome(REF, [b, a], NO_PLAN, CONFIG)!);
    expect(first).toBe(second);
    expect(first).toBe("lost:1/10");
  });

  it("is stable for the same contract across its supplementary agreements", () => {
    const a = decideGzDealOutcome(REF, [contract({ contractNumberSys: "1/2/00" })], NO_PLAN, CONFIG)!;
    const b = decideGzDealOutcome(REF, [
      contract({ contractNumberSys: "1/2/00", RefContractStatus: { nameRu: "Изменен" } }),
      contract({ contractNumberSys: "1/2/01" })
    ], NO_PLAN, CONFIG)!;
    expect(gzDealOutcomeKey(a)).toBe(gzDealOutcomeKey(b));
    expect(gzDealOutcomeKey(a)).toBe("won:1/2");
  });

  it("changes when the plan moves to a new status", () => {
    const published = decideGzDealOutcome(REF, [], status("Опубликован"), CONFIG)!;
    const failed = decideGzDealOutcome(REF, [], status("Закупка не состоялась"), CONFIG)!;
    expect(gzDealOutcomeKey(published)).not.toBe(gzDealOutcomeKey(failed));
  });

  it("keys a rewrite by the new item", () => {
    expect(gzDealOutcomeKey({ kind: "repurposed", newItem: "Плинтус" })).toBe("repurposed:плинтус");
  });
});

describe("buildGzDealOutcomeComment", () => {
  const won: GzDealOutcome = {
    kind: "won",
    contractNumber: "990340007507/260547",
    signDate: "2026-09-15",
    supplierBin: F3,
    supplierName: "ТОО \"F3.kz\"",
    unitSum: 1_100_000,
    otherContracts: 0
  };

  it("asks the manager to mark a win", () => {
    const text = buildGzDealOutcomeComment(won, "https://procurement.gov.kz/ru/registry/show_plan/1/2");
    expect(text).toContain("подписан с нами");
    expect(text).toMatch(/1\s100\s000 ₸/);
    expect(text).toContain("15.09.2026");
    expect(text).toContain("990340007507/260547");
  });

  it("names the competitor and its BIN", () => {
    const text = buildGzDealOutcomeComment({ ...won, kind: "lost", supplierBin: "190540009117", supplierName: "ТОО \"QTrade Company\"" }, null);
    expect(text).toContain("QTrade Company");
    expect(text).toContain("190540009117");
    expect(text).toContain("Закупка состоялась");
  });

  it("mentions the other contracts of a split point", () => {
    expect(buildGzDealOutcomeComment({ ...won, otherContracts: 2 }, null)).toContain("ещё договоров: 2");
  });

  it("adds the plan link to a publication notice", () => {
    const url = "https://procurement.gov.kz/ru/registry/show_plan/87921006/4881187";
    expect(buildGzDealOutcomeComment({ kind: "published", planStatus: "Опубликован" }, url)).toContain(url);
  });

  it("explains a rewritten point", () => {
    expect(buildGzDealOutcomeComment({ kind: "repurposed", newItem: "Плинтус" }, null)).toContain("«Плинтус»");
  });

  it("omits the amount when the contract unit carries none", () => {
    expect(buildGzDealOutcomeComment({ ...won, unitSum: null }, null)).not.toContain("₸");
  });
});

describe("buildGzDealPlanRef", () => {
  it("reads a current deal: plan number, point, link and ENSTRU code", () => {
    expect(buildGzDealPlanRef({
      TITLE: "[GZ 87777759] Департамент полиции - Компьютер",
      ORIGIN_ID: "gz-plan:88029694",
      UF_CRM_PLAN_ID: "87777759",
      UF_CRM_6A436D5A3614C: "88029694",
      UF_CRM_PLAN_LINK: "https://procurement.gov.kz/ru/registry/show_plan/88029694/4880113",
      UF_CRM_6A436D5A19612: "262013.000.000011",
      UF_CRM_6627AEBD54B8D: "Компьютер"
    })).toEqual({ planNumber: 87777759, pointIds: [88029694], enstruCode: "262013.000.000011", itemName: "Компьютер" });
  });

  it("ignores the plan list id a June deal keeps in ORIGIN_ID and reads the item from the title", () => {
    // Deal 36657: ORIGIN_ID holds plan list 4608960, the point lives in the link.
    expect(buildGzDealPlanRef({
      TITLE: "Панель интерактивная",
      ORIGIN_ID: "gz-plan:4608960",
      UF_CRM_PLAN_ID: "84954271",
      UF_CRM_PLAN_LINK: "https://www.goszakup.gov.kz/ru/registry/show_plan/85108971/4608960"
    })).toEqual({ planNumber: 84954271, pointIds: [85108971], enstruCode: null, itemName: "Панель интерактивная" });
  });

  it("falls back to the title number and ORIGIN_ID when the plan fields are empty", () => {
    expect(buildGzDealPlanRef({ TITLE: "[GZ 87568873] Ясли-сад - Ноутбук", ORIGIN_ID: "gz-plan:87568873" }))
      .toMatchObject({ planNumber: 87568873, pointIds: [87568873], itemName: null });
  });
});

describe("dealBin", () => {
  it("accepts only a 12-digit BIN", () => {
    expect(dealBin({ UF_CRM_6627AEBD7C2D2: " 180840026205 " })).toBe("180840026205");
    expect(dealBin({ UF_CRM_6627AEBD7C2D2: "18084" })).toBeNull();
    expect(dealBin({})).toBeNull();
  });
});

describe("contractBaseNumber", () => {
  it("drops the version suffix", () => {
    expect(contractBaseNumber("990340007507/260547/01")).toBe("990340007507/260547");
    expect(contractBaseNumber("990340007507/260547")).toBe("990340007507/260547");
  });
});
