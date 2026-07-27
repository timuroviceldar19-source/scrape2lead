import { describe, expect, it, vi } from "vitest";
import { resolveEpzPlanYearIds } from "../../src/kz/procurement/planYears.js";
import { ProcurementHttpError } from "../../src/kz/procurement/http.js";

/** Реальный срез справочника EPZ: id 11 не используется, 2027 ещё не открыт. */
const DICTIONARY: Record<number, number> = { 9: 2024, 10: 2025, 12: 2026 };

describe("resolveEpzPlanYearIds", () => {
  it("maps a calendar year to its plan_year_id from the plan item, not by arithmetic", async () => {
    const fetchJson = dictionaryFetcher();
    const result = await resolveEpzPlanYearIds([2026], { fetchJson, overrides: { "2026": 12 } });

    expect(result.resolved).toEqual([{ year: 2026, planYearId: 12 }]);
    expect(result).toMatchObject({ conflicts: [], probeErrors: [], unresolvedFutureYears: [] });
  });

  it("checks the config override instead of trusting it", async () => {
    const fetchJson = dictionaryFetcher();
    // Конфиг утверждает, что 2026 — это id 9, но источник говорит, что 9 это 2024.
    const result = await resolveEpzPlanYearIds([2026], { fetchJson, overrides: { "2026": 9 } });

    expect(result.resolved).toEqual([{ year: 2026, planYearId: 12 }]);
    expect(result.conflicts).toEqual(["plan-year:2026:override_9_resolved_12"]);
  });

  it("skips unused dictionary ids without reporting an error", async () => {
    const fetchJson = dictionaryFetcher();
    const result = await resolveEpzPlanYearIds([2024, 2025, 2026], { fetchJson });

    expect(result.resolved).toEqual([
      { year: 2024, planYearId: 9 }, { year: 2025, planYearId: 10 }, { year: 2026, planYearId: 12 }
    ]);
    expect(result.probeErrors).toEqual([]);
  });

  it("reports a not-yet-opened future year as unresolved rather than as a failure", async () => {
    const fetchJson = dictionaryFetcher();
    const result = await resolveEpzPlanYearIds([2026, 2027], { fetchJson, overrides: { "2026": 12 } });

    expect(result.resolved).toEqual([{ year: 2026, planYearId: 12 }]);
    expect(result.unresolvedFutureYears).toEqual([2027]);
    expect(result.probeErrors).toEqual([]);
  });

  it("records a transport failure as a probe error — a 5xx is not evidence the year is absent", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("plan_year_id=12")) throw new ProcurementHttpError(503, url);
      return dictionaryFetcher()(url);
    });
    const result = await resolveEpzPlanYearIds([2026], { fetchJson, overrides: { "2026": 12 }, probeRange: [12, 12] });

    expect(result.resolved).toEqual([]);
    expect(result.probeErrors).toEqual(["plan-year:12:procurement request failed: HTTP 503 for " +
      "https://zakup.gov.kz/api/core/api/public/plan-items/?limit=5&offset=0&system_id__in=2__3&status_id__in=2&plan_year_id=12"]);
  });

  it("walks past records whose detail is missing instead of giving up on the id", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("plan_year_id=12")) return { results: [{ id: 900 }, { id: 901 }] };
      if (url.endsWith("/900/")) throw new ProcurementHttpError(404, url);
      if (url.endsWith("/901/")) return { id: 901, year: { id: 12, year: 2026 } };
      return { results: [] };
    });
    const result = await resolveEpzPlanYearIds([2026], { fetchJson, overrides: { "2026": 12 }, probeRange: [12, 12] });

    expect(result.resolved).toEqual([{ year: 2026, planYearId: 12 }]);
    expect(result.probeErrors).toEqual([]);
  });

  it("stops probing once every requested year is resolved", async () => {
    const fetchJson = dictionaryFetcher();
    await resolveEpzPlanYearIds([2026], { fetchJson, overrides: { "2026": 12 } });

    // Подсказка проверяется первой, поэтому весь диапазон 1..32 перебирать не приходится.
    const listCalls = fetchJson.mock.calls.filter(([url]) => (url as string).includes("plan_year_id="));
    expect(listCalls).toHaveLength(1);
  });
});

function dictionaryFetcher() {
  return vi.fn(async (url: string) => {
    const listMatch = /plan_year_id=(\d+)/.exec(url);
    if (listMatch) {
      const year = DICTIONARY[Number(listMatch[1])];
      return year === undefined ? { results: [] } : { results: [{ id: Number(listMatch[1]) * 1000 }] };
    }
    const detailMatch = /plan-items\/(\d+)\//.exec(url);
    if (detailMatch) {
      const planYearId = Number(detailMatch[1]) / 1000;
      return { id: detailMatch[1], year: { id: planYearId, year: DICTIONARY[planYearId] } };
    }
    return {};
  });
}
