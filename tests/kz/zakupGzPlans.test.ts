import { describe, expect, it } from "vitest";
import { fetchGzPlans } from "../../src/kz/zakupGzPlans.js";

const options = { pauseMs: 0, maxRetries: 0, retryDelayMs: 0 };
const json = (body: unknown) => new Response(JSON.stringify(body));
const html = (root: number, point: number) => `<table id="search-result"><tbody><tr><td>${root}</td><td>Заказчик</td><td><a href="/ru/registry/show_plan/${point}/999">Экран</a></td><td>Способ</td><td>шт</td><td>1</td><td>1</td><td>1</td><td>Октябрь</td><td>Утвержден</td></tr></tbody></table>`;
const detail = { id: 500, external_id: 200, organization: { iin_bin: "990000000001" }, name_ru: "Экран", enstru: { code: "279020.100.000002" }, status: { name: "Утвержден", egz_code: "2" }, year: { year: 2026 }, timestamp: 1792042214 };

describe("пункты плана zakup", () => {
  it("подтверждает текущую версию корня по реестру и сохраняет БИН, дату и год", async () => {
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (u.hostname === "procurement.gov.kz") return new Response(html(100, 200));
      if (u.pathname.endsWith("/plan-items/")) { expect(u.searchParams.get("external_id")).toBe("200"); return json({ count: 1, results: [{ id: 500, external_id: "200" }] }); }
      return json(detail);
    }) as typeof fetch;
    expect(await fetchGzPlans([100], "root", { ...options, fetchFn })).toEqual([{ id: 200, rootrecordId: 100, subjectBiin: "990000000001", isActive: 1, isDeleted: 0, plnPointYear: 2026, refEnstruCode: "279020.100.000002", nameRu: "Экран", dateCreate: "2026-10-15 13:30:14", RefPlnPointStatus: { nameRu: "Утвержден" } }]);
  });
  it("не подставляет старый товар, если текущей версии нет в zakup", async () => {
    const fetchFn = (async (url: string) => new URL(url).hostname === "procurement.gov.kz" ? new Response(html(100, 200)) : json({ count: 0, results: [] })) as typeof fetch;
    await expect(fetchGzPlans([100], "root", { ...options, fetchFn })).rejects.toThrow(/200/);
  });
  it("не принимает страницу ограничения или чужой результат поиска за исчезнувший план", async () => {
    const fetchFn = (async () => new Response("Технические работы")) as typeof fetch;
    await expect(fetchGzPlans([100], "root", { ...options, fetchFn })).rejects.toThrow();
  });
  it("для точного id не выдумывает rootrecordId и не подставляет timestamp синхронизации как дату версии", async () => {
    const fetchFn = (async (url: string) => new URL(url).pathname.endsWith("/plan-items/") ? json({ count: 1, results: [{ id: 500, external_id: 200 }] }) : json({ ...detail, timestamp: null })) as typeof fetch;
    const [plan] = await fetchGzPlans([200], "id", { ...options, fetchFn });
    expect(plan.rootrecordId).toBeNull();
    expect(plan.dateCreate).toBe("");
  });
});
