import { describe, expect, it, vi } from "vitest";
import { collectGzPlansFromZakup } from "../../src/kz/zakupGzPlanCollector.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const page = (results: unknown[]) => ({ count: results.length, next: null, results });

function listRow(id: number, externalId: string, overrides: Record<string, unknown> = {}) {
  return {
    id, external_id: externalId, system_id: 1, plan_year_id: [12], month_id: 11, month_name: "Ноябрь",
    status_id: 2, status_name: "Утвержден", count: 2, unit_price: 750000, total_price: 1500000,
    purchase_method_name: "Электронный магазин", organization_name: "КГУ «Школа № 1»",
    enstru: { name_ru: "Панель интерактивная" }, extra_description: "Интерактивная панель 75\"",
    ...overrides
  };
}

function detail(id: number, externalId: number, overrides: Record<string, unknown> = {}) {
  return {
    id, external_id: externalId, name_ru: "Панель интерактивная",
    description_ru: "LCD поверхность", extra_description_ru: "Интерактивная панель 75\"",
    organization: { iin_bin: "990140001628", name_ru: "КГУ «Школа № 1»" },
    enstru: { code: "262030.100.000021", name_ru: "Панель интерактивная" },
    measure: { name: "Штука" }, status: { name: "Утвержден" },
    plan: { act_date: "2026-11-16", act_number: "1-1-9/26П" },
    delivery_address: null,
    deliveries: [{ kato_full_name_ru: "Карагандинская область, г.Сарань" }],
    budget_planning_admin: null,
    ...overrides
  };
}

interface Fake {
  years?: unknown;
  lists: Record<string, unknown[] | (() => Response)>;
  details?: Record<number, unknown | (() => Response)>;
}

function fakeZakup(fake: Fake) {
  const calls: URL[] = [];
  const fetchFn = (async (input: string) => {
    const url = new URL(input); calls.push(url);
    if (url.pathname.endsWith("/dicts/years/")) return json(fake.years ?? [{ id: 10, year: 2025 }, { id: 12, year: 2026 }]);
    if (url.pathname.endsWith("/public/plan-items/")) {
      const listed = fake.lists[url.searchParams.get("q") ?? ""];
      if (typeof listed === "function") return listed();
      return json(page(listed ?? []));
    }
    const match = url.pathname.match(/\/public\/plan-items\/(\d+)\/$/);
    if (match) {
      const body = fake.details?.[Number(match[1])];
      if (typeof body === "function") return (body as () => Response)();
      return body ? json(body) : json({ detail: "Not found" }, 404);
    }
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const zakup = (fetchFn: typeof fetch) => ({ fetchFn, pauseMs: 0, maxRetries: 0, retryDelayMs: 0 });

describe("collectGzPlansFromZakup", () => {
  it("reads GZ plan items from zakup.gov.kz in the shape of the portal collector", async () => {
    const { fetchFn, calls } = fakeZakup({
      lists: {
        "Панель интерактивная": [listRow(1001, "88700001")],
        "Панель жидкокристаллическая": [listRow(1006, "88700006", { month_id: 12, month_name: "Декабрь", count: 1, unit_price: 1750000.5, total_price: 1750000.5 })]
      },
      details: { 1001: detail(1001, 88700001), 1006: detail(1006, 88700006, { deliveries: [], delivery_address: "г. Риддер, ул. Ленина, 1" }) }
    });

    const result = await collectGzPlansFromZakup({
      keywords: ["Панель интерактивная", "Панель жидкокристаллическая"], year: 2026, months: [11, 12],
      statuses: ["Утвержден", "На проверке камерального контроля"], zakup: zakup(fetchFn)
    });

    const search = calls.find((url) => url.pathname.endsWith("/public/plan-items/"))!;
    expect(Object.fromEntries(search.searchParams)).toMatchObject({
      q: "Панель интерактивная", system_id__in: "1", plan_year_id: "12", month_id__in: "11__12"
    });
    expect(result).toMatchObject({ successfulQueries: 2, skippedQueries: [] });
    expect(result.cacheStats).toEqual({ cacheHit: 0, cacheMiss: 2, fetched: 2, fetchFailed: 0 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      plan_point_id: "88700001", plan_list_number: "88700001", customer_name: "КГУ «Школа № 1»", customer_url: null,
      item_name: "Панель интерактивная", method: "Электронный магазин", unit: "Штука", quantity: "2",
      unit_price: "750 000.00", planned_amount: "1 500 000.00", planned_month: "Ноябрь", status: "Утвержден",
      detail_url: "https://zakup.gov.kz/plan-items/1001", keyword: "Панель интерактивная",
      detail: {
        plan_point_id: "88700001", customer_bin: "990140001628", customer_name: "КГУ «Школа № 1»",
        name_ru: "Панель интерактивная", ref_enstru_code: "262030.100.000021", desc_ru: "LCD поверхность",
        extra_desc_ru: "Интерактивная панель 75\"", date_approved: "2026-11-16", ref_abp_code: null, abp_name: null,
        delivery_address: "Карагандинская область, г.Сарань", plan_act_number: "1-1-9/26П"
      }
    });
    expect(result.items[1]).toMatchObject({
      plan_point_id: "88700006", planned_month: "Декабрь", quantity: "1",
      unit_price: "1 750 000.50", planned_amount: "1 750 000.50",
      detail: { delivery_address: "г. Риддер, ул. Ленина, 1" }
    });
  });

  it("keeps only the configured statuses and drops points whose zakup records disagree", async () => {
    const { fetchFn } = fakeZakup({
      lists: {
        "Панель интерактивная": [
          listRow(1001, "88700001"),
          listRow(1002, "88700002", { status_id: 5, status_name: "Опубликован" }),
          // Один номер пункта двумя записями: утверждён и уже в проекте договора. Сделку не заводим.
          listRow(1004, "88700004"),
          listRow(1005, "88700004", { status_id: 18, status_name: "Проект договора" })
        ]
      },
      details: { 1001: detail(1001, 88700001) }
    });

    const result = await collectGzPlansFromZakup({
      keywords: ["Панель интерактивная"], year: 2026, months: [11, 12], statuses: ["Утвержден"], zakup: zakup(fetchFn)
    });

    expect(result.items.map((item) => item.plan_point_id)).toEqual(["88700001"]);
  });

  it("keeps the last keyword for a point found by several searches, like the portal collector", async () => {
    const { fetchFn } = fakeZakup({
      lists: { "Компьютер": [listRow(2001, "88800001")], "Моноблок": [listRow(2001, "88800001")] },
      details: { 2001: detail(2001, 88800001) }
    });

    const result = await collectGzPlansFromZakup({
      keywords: ["Компьютер", "Моноблок"], year: 2026, months: [11, 12], statuses: [], zakup: zakup(fetchFn)
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].keyword).toBe("Моноблок");
  });

  it("skips detail requests for rows the exporter would drop anyway", async () => {
    const { fetchFn, calls } = fakeZakup({
      lists: {
        "Панель интерактивная": [
          listRow(1001, "88700001"),
          listRow(1003, "88700003", { total_price: 300000, unit_price: 300000, count: 1 }),
          listRow(1007, "88700007", { enstru: { name_ru: "Услуги по ремонту" } })
        ]
      },
      details: { 1001: detail(1001, 88700001) }
    });

    const result = await collectGzPlansFromZakup({
      keywords: ["Панель интерактивная"], year: 2026, months: [11, 12], statuses: [],
      minAmount: 500000, excludeKeywords: ["Услуги"], prefilterDetails: true, zakup: zakup(fetchFn)
    });

    expect(result.items.map((item) => item.plan_point_id)).toEqual(["88700001"]);
    expect(calls.filter((url) => /\/plan-items\/\d+\/$/.test(url.pathname)).map((url) => url.pathname))
      .toEqual(["/api/core/api/public/plan-items/1001/"]);
  });

  it("takes only points newer than the frozen portal registry when a lower bound is set", async () => {
    const { fetchFn, calls } = fakeZakup({
      lists: { "Панель интерактивная": [listRow(1001, "88654473"), listRow(1002, "88654474")] },
      details: { 1002: detail(1002, 88654474) }
    });

    const result = await collectGzPlansFromZakup({
      keywords: ["Панель интерактивная"], year: 2026, months: [11], statuses: [], minPlanPointId: 88654474, zakup: zakup(fetchFn)
    });

    expect(result.items.map((item) => item.plan_point_id)).toEqual(["88654474"]);
    expect(calls.some((url) => url.pathname.endsWith("/plan-items/1001/"))).toBe(false);
  });

  it("drops a point that zakup already shows a later version of", async () => {
    // 18.11.2026: 80758527 (47 шт на 14,1 млн) ещё «Утвержден», хотя заказчик заменил его пунктом 88607772 (42 шт).
    const { fetchFn } = fakeZakup({
      lists: {
        "Компьютер": [listRow(5001, "80758527", { organization_id: 77 }), listRow(5002, "88607772", { organization_id: 77 }), listRow(5003, "88700100", { organization_id: 78 })],
        "80758527": [listRow(5002, "88607772", { organization_id: 77 })],
        "88607772": [listRow(5002, "88607772", { organization_id: 77 })],
        // Чужой пункт с тем же номером в тексте не делает пункт устаревшим.
        "88700100": [listRow(5003, "88700100", { organization_id: 78 }), listRow(6001, "88799999", { organization_id: 99 })]
      },
      details: { 5002: detail(5002, 88607772), 5003: detail(5003, 88700100) }
    });

    const result = await collectGzPlansFromZakup({
      keywords: ["Компьютер"], year: 2026, months: [11], statuses: [], zakup: zakup(fetchFn)
    });

    expect(result.items.map((item) => item.plan_point_id).sort()).toEqual(["88607772", "88700100"]);
  });

  it("returns an empty successful search for a year zakup does not know yet", async () => {
    const { fetchFn, calls } = fakeZakup({ lists: {} });

    const result = await collectGzPlansFromZakup({
      keywords: ["Ноутбук", "Моноблок"], year: 2027, months: [1, 2, 3, 4], partialCollection: true, zakup: zakup(fetchFn)
    });

    expect(result).toMatchObject({ items: [], successfulQueries: 2, skippedQueries: [] });
    expect(calls.some((url) => url.pathname.endsWith("/public/plan-items/"))).toBe(false);
  });

  it("records a failed search as a skipped query in partial mode and keeps the others", async () => {
    const { fetchFn } = fakeZakup({
      lists: { "Ноутбук": () => json({ detail: "busy" }, 503), "Моноблок": [listRow(3001, "88900001")] },
      details: { 3001: detail(3001, 88900001) }
    });

    const result = await collectGzPlansFromZakup({
      keywords: ["Ноутбук", "Моноблок"], year: 2026, months: [11, 12], statuses: [], partialCollection: true, zakup: zakup(fetchFn)
    });

    expect(result.items.map((item) => item.plan_point_id)).toEqual(["88900001"]);
    expect(result.successfulQueries).toBe(1);
    expect(result.skippedQueries).toEqual([expect.objectContaining({
      stage: "plans", query: "Ноутбук", year: 2026, months: [11, 12], failedPage: 1, keptRows: 0,
      reason: expect.stringContaining("HTTP 503")
    })]);
  });

  it("throws on a failed search outside partial mode", async () => {
    const { fetchFn } = fakeZakup({ lists: { "Ноутбук": () => json({ detail: "busy" }, 503) } });

    await expect(collectGzPlansFromZakup({ keywords: ["Ноутбук"], year: 2026, months: [11], zakup: zakup(fetchFn) }))
      .rejects.toThrow(/HTTP 503/);
  });

  it("drops points whose detail cannot be trusted and reports failed reads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { fetchFn } = fakeZakup({
      lists: {
        "Компьютер": [
          listRow(4001, "88910001"), listRow(4002, "88910002"), listRow(4003, "88910003"), listRow(4004, "88910004")
        ]
      },
      details: {
        4001: detail(4001, 88910001),
        4002: () => json({ detail: "busy" }, 502),
        4003: detail(4003, 88910099),
        4004: detail(4004, 88910004, { organization: { iin_bin: "не БИН" } })
      }
    });

    const result = await collectGzPlansFromZakup({
      keywords: ["Компьютер"], year: 2026, months: [11], statuses: [], partialCollection: true, zakup: zakup(fetchFn)
    });

    expect(result.items.map((item) => item.plan_point_id)).toEqual(["88910001"]);
    expect(result.cacheStats).toEqual({ cacheHit: 0, cacheMiss: 4, fetched: 1, fetchFailed: 3 });
    expect(result.skippedQueries).toEqual([expect.objectContaining({
      stage: "plans", query: "Компьютер", failedPage: null, planPointIds: ["88910002"], reason: expect.stringMatching(/^detail: .*HTTP 502/)
    })]);
    warn.mockRestore();
  });
});
