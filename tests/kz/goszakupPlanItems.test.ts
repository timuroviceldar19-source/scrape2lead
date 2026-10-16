import { describe, expect, it } from "vitest";
import { fetchCurrentPlanItems } from "../../src/kz/goszakupPlanItems.js";

const OPTIONS = { token: "t", retryDelayMs: 0, maxRetries: 0 };

function plan(over: Record<string, unknown>) {
  return { id: 88294659, rootrecordId: 88137237, subjectBiin: "990240002999", isActive: 1, isDeleted: 0, plnPointYear: 2026, dateCreate: "2026-10-15 13:30:14", refEnstruCode: "279020.100.000002", nameRu: "Панель жидкокристаллическая", ...over };
}

/** Отвечает по списку корней из запроса: `rows` — записи реестра, `failFor` — корни, на которых запрос падает. */
function fakeRegistry(rows: Array<Record<string, unknown>>, failFor: number[] = []) {
  const calls: Array<{ v: number[]; after: number }> = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { variables: { v: number[]; after: number } };
    calls.push(body.variables);
    if (body.variables.v.some((root) => failFor.includes(root))) throw new Error("ECONNRESET");
    const found = rows.filter((row) => body.variables.v.includes(Number(row.rootrecordId ?? row.id)));
    return new Response(JSON.stringify({ data: { Plans: found.length ? found : null }, extensions: { pageInfo: { hasNextPage: false, lastId: 1 } } }), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("fetchCurrentPlanItems", () => {
  it("returns the current version of each point by the number the portal shows: the newest active one, not the deleted or old ones", async () => {
    const { fn } = fakeRegistry([
      plan({ id: 88137237, isActive: 0, nameRu: "Доска специальная", refEnstruCode: "262030.100.000043", dateCreate: "2026-10-05 09:00:00" }),
      plan({}),
      plan({ id: 88300000, isDeleted: 1, refEnstruCode: "111111.111.111111" })
    ]);

    const result = await fetchCurrentPlanItems([88137237], { ...OPTIONS, fetchFn: fn });

    expect(result.items.get(88137237)).toEqual({ id: 88294659, rootId: 88137237, code: "279020.100.000002", name: "Панель жидкокристаллическая", bin: "990240002999", year: 2026, createdAt: "2026-10-15 13:30:14" });
    expect(result.failed).toEqual([]);
  });

  it("asks for the numbers in batches of 100 and leaves out the ones the registry does not know", async () => {
    const roots = Array.from({ length: 250 }, (_, index) => 1000 + index);
    const { fn, calls } = fakeRegistry([plan({ id: 1005, rootrecordId: 1005 })]);

    const result = await fetchCurrentPlanItems(roots, { ...OPTIONS, fetchFn: fn });

    expect(calls.map((call) => call.v.length)).toEqual([100, 100, 50]);
    expect([...result.items.keys()]).toEqual([1005]);
  });

  it("reports the numbers of a batch it could not read and still returns the other batches", async () => {
    const roots = Array.from({ length: 150 }, (_, index) => 2000 + index);
    const { fn } = fakeRegistry([plan({ id: 2000, rootrecordId: 2000 }), plan({ id: 2120, rootrecordId: 2120 })], [2120]);

    const result = await fetchCurrentPlanItems(roots, { ...OPTIONS, fetchFn: fn });

    expect([...result.items.keys()]).toEqual([2000]);
    expect(result.failed).toHaveLength(50);
    expect(result.failed).toContain(2120);
  });
});
