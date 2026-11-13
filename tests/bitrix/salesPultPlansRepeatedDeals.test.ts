import { expect, it, vi } from "vitest";
import { collectPlansMonitor, normalizePlanDeal, dedupePlanDeals } from "../../src/bitrix/salesPult/plans/collect.js";
import { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import type { NormalizedPlanDeal } from "../../src/bitrix/salesPult/plans/types.js";

const options = { asOfDate: "2026-11-06" };
function raw(id: number, extra: Record<string, unknown> = {}) {
  return { ID: String(id), TITLE: "Тестовый товар", CATEGORY_ID: 41, ORIGINATOR_ID: "scrape2lead-gz-plans",
    UF_CRM_PLAN_ID: "7001", ORIGIN_ID: `gz-plan:${id}`, UF_CRM_ENSTRU_NAME: "Панель", ASSIGNED_BY_ID: "7",
    DATE_CREATE: "2026-11-01", UF_CRM_MONTH: "2026-11", OPPORTUNITY: 120, UF_CRM_COUNT: 3,
    UF_CRM_6627AEBD72587: "Тестовый заказчик", UF_CRM_6627AEBD7C2D2: "test-bin", ...extra };
}
function deal(id: number, extra: Partial<NormalizedPlanDeal> = {}): NormalizedPlanDeal {
  return { ...normalizePlanDeal(raw(id), options)!, ...extra };
}

it.each([
  ["выигранный исход выше открытой CRM и наличия кода", { outcomeCategory: "won", isOpen: false }, { isOpen: true, truCode: "262030.100.000021" }],
  ["открытая CRM выше наличия кода", { isOpen: true }, { isOpen: false, truCode: "262030.100.000021" }],
  ["наличие кода выше ID", { truCode: "262030.100.000021" }, {}],
] as const)("приоритет: %s", (_label, winnerFields, loserFields) => {
  const winner = deal(9, winnerFields), loser = deal(100, loserFields);
  expect(dedupePlanDeals([winner, loser])).toEqual([winner]);
  expect(dedupePlanDeals([loser, winner])).toEqual([winner]);
});
it("при равных признаках выбирает больший числовой ID, а не строковый порядок", () => {
  const winner = deal(100), loser = deal(9);
  expect(dedupePlanDeals([winner, loser])).toEqual([winner]);
  expect(dedupePlanDeals([loser, winner])).toEqual([winner]);
});
it("исход won имеет приоритет и среди закрытых сделок с разной группой", () => {
  const winner = deal(8, { outcomeCategory: "won", isOpen: false, group: "КТ" });
  expect(dedupePlanDeals([deal(100, { isOpen: false, truCode: "262030.100.000021" }), winner])).toEqual([winner]);
});
it("ключом служит номер пункта, повторы между ИП и КТ объединяются", () => {
  const ip = deal(9), kt = deal(10, { group: "КТ", truCode: "262013.000.000011" });
  expect(dedupePlanDeals([ip, kt])).toEqual([kt]);
  expect(dedupePlanDeals([ip, deal(10, { planNumber: "7002" })])).toHaveLength(2);
});
it("пустые номера не объединяет, прочие записи и входные данные не меняет", () => {
  const first = deal(9, { planNumber: "", truCode: "", qty: 0 });
  const second = deal(10, { planNumber: "", truCode: "", qty: 0 });
  const legacy = deal(11, { planNumber: "7003", truCode: "", qty: 0 });
  const original = Object.freeze([Object.freeze(first), Object.freeze(second), Object.freeze(legacy)]);
  const result = dedupePlanDeals(original);
  expect(result).toEqual(original);
  expect(result).not.toBe(original);
  result.forEach((d, i) => expect(d).toBe(original[i]));
  expect(dedupePlanDeals([])).toEqual([]);
});
it("сохраняет позицию пункта при замене победителем и не меняет исходный массив", () => {
  const old = deal(9), unrelated = deal(10, { planNumber: "7002" }), winner = deal(11);
  const input = Object.freeze([Object.freeze(old), Object.freeze(unrelated), Object.freeze(winner)]);
  expect(dedupePlanDeals(input)).toEqual([winner, unrelated]);
  expect(input).toEqual([old, unrelated, winner]);
});
it.each(["C41:DUPLICATE", "C9:DOUBLE", "c29:double", "DUPLICATE"])("отдельно исключает стадию %s до дедупликации", async stage => {
  const reader = new ReadOnlyBitrixClient({ async call() { return { name: "Тестовый менеджер" }; } });
  vi.spyOn(reader, "listAllBatched").mockResolvedValue([
    raw(9), raw(100, { STAGE_ID: stage, STAGE_SEMANTIC_ID: "S", UF_CRM_S2L_GZ_OUTCOME: "won:test", ASSIGNED_BY_ID: "8" })
  ]);
  const calls = vi.spyOn(reader, "call");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    // Принадлежность к планам не зависит от стадии; исключение выполняет сборщик.
    expect(normalizePlanDeal(raw(100, { STAGE_ID: stage }), options)).not.toBeNull();
    const view = await collectPlansMonitor({ ...options, reader });
    expect(view.ip!.total).toMatchObject({ count: 1, sum: 120, wonCount: 0, openCount: 1 });
    expect(view.ip!.openPlans.map(d => d.id)).toEqual(["9"]);
    expect(calls.mock.calls).toEqual([["im.user.get", { ID: 7 }]]);
    expect(log).toHaveBeenCalledWith("[Планы] на стадии «Дубль»: 1");
    expect(log).toHaveBeenCalledWith("[Планы] повторов: 0");
  } finally { log.mockRestore(); }
});
it("все срезы и openPlans используют один список после исключений и повторов", async () => {
  const reader = new ReadOnlyBitrixClient({ async call() { return { name: "Тестовый менеджер" }; } });
  vi.spyOn(reader, "listAllBatched").mockResolvedValue([
    raw(9, { UF_CRM_MONTH: "2026-10", ASSIGNED_BY_ID: "8", UF_CRM_6627AEBD7C2D2: "old-bin" }),
    raw(10, { UF_CRM_REF_ENSTRU_CODE: "262013.000.000011", UF_CRM_ENSTRU_NAME: "Компьютер" }),
    raw(11, { UF_CRM_PLAN_ID: "7002", UF_CRM_REF_ENSTRU_CODE: "262030.100.000021", STAGE_SEMANTIC_ID: "S", CLOSED: "Y", UF_CRM_S2L_GZ_OUTCOME: "partner:test" }),
    raw(12, { UF_CRM_PLAN_ID: "7002", UF_CRM_MONTH: "2026-10", ASSIGNED_BY_ID: "8" }),
    raw(13, { UF_CRM_PLAN_ID: "7003", UF_CRM_COUNT: "", UF_CRM_ENSTRU_NAME: "Панель" }),
    raw(14, { UF_CRM_PLAN_ID: "", UF_CRM_COUNT: "", UF_CRM_ENSTRU_NAME: "Панель" }),
    raw(15, { UF_CRM_PLAN_ID: "", UF_CRM_COUNT: "", UF_CRM_ENSTRU_NAME: "Панель" }),
    raw(16, { UF_CRM_PLAN_ID: "7004", STAGE_ID: "C41:DUPLICATE" })
  ]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const calls = vi.spyOn(reader, "call");
  try {
    const view = await collectPlansMonitor({ ...options, reader });
    expect(view.ip!.total).toMatchObject({ count: 4, sum: 480, qty: 3, openCount: 3, wonCount: 1 });
    expect(view.kt!.total).toMatchObject({ count: 1, sum: 120, openCount: 1 });
    expect(view.ip!.openPlans.map(d => d.id)).toEqual(["13", "14", "15"]);
    expect(view.kt!.openPlans.map(d => d.id)).toEqual(["10"]);
    for (const group of [view.ip!, view.kt!]) {
      expect(group.months.map(m => m.m)).toEqual(["2026-11"]);
      expect(group.monthViews.all.total).toEqual(group.total);
      expect(group.monthViews["2026-11"].total).toEqual(group.total);
      expect(group.managers.map(m => m.id)).toEqual(["7"]);
      expect(group.managers[0].count).toBe(group.total.count);
      expect(group.customers.map(c => c.bin)).toEqual(["test-bin"]);
      expect(group.customers[0].count).toBe(group.total.count);
      expect(group.methods[0].count).toBe(group.total.count);
    }
    expect(view.ip!.openPlans[0]).toMatchObject({ truCode: "", qty: 0 });
    expect(calls.mock.calls).toEqual([["im.user.get", { ID: 7 }]]);
    expect(log).toHaveBeenCalledWith("[Планы] на стадии «Дубль»: 1");
    expect(log).toHaveBeenCalledWith("[Планы] повторов: 2");
    expect(log.mock.calls.every(args => args.length === 1 && !/сумм|₸/.test(String(args[0])))).toBe(true);
  } finally { log.mockRestore(); }
});

it("ссылка на план со старого домена портала ведёт на procurement.gov.kz", () => {
  const old = normalizePlanDeal(raw(1, { UF_CRM_PLAN_LINK: "https://goszakup.gov.kz/ru/registry/show_plan/84671831/4573761" }), options)!;
  expect(old.planUrl).toBe("https://procurement.gov.kz/ru/registry/show_plan/84671831/4573761");
  const fresh = normalizePlanDeal(raw(2, { UF_CRM_PLAN_LINK: "https://procurement.gov.kz/ru/registry/show_plan/1/2" }), options)!;
  expect(fresh.planUrl).toBe("https://procurement.gov.kz/ru/registry/show_plan/1/2");
});
