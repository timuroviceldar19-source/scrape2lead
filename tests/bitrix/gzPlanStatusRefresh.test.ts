import { describe, expect, it, vi } from "vitest";
import {
  decideRefresh,
  formatReportLines,
  getStatusRank,
  runPlanStatusRefresh,
  type PlanStatusRefreshDeps,
  type RefreshDeal
} from "../../src/bitrix/gzPlanStatusRefresh.js";
import { buildDealUpdateCommands, createBatchDealUpdater } from "../../src/bitrix/gzPlanStatusWriter.js";

const NOW = new Date("2026-10-28T10:00:00.000Z");

function deal(id: number, planNumber: string, status = "Утвержден", extra: Partial<RefreshDeal> = {}): RefreshDeal {
  return {
    ID: id, TITLE: `Сделка ${id}`, UF_CRM_PLAN_ID: planNumber,
    UF_CRM_PLAN_STATUS: status, UF_CRM_6627AEBD85B4D: status, UF_CRM_S2L_GZ_PUBLISHED_AT: "", ...extra
  };
}

function makeDeps(deals: RefreshDeal[], api: Record<string, string>): PlanStatusRefreshDeps & {
  fetchStatuses: ReturnType<typeof vi.fn>;
  writeUpdates: ReturnType<typeof vi.fn>;
} {
  return {
    listDeals: async () => deals,
    fetchStatuses: vi.fn(async (numbers: string[]) =>
      new Map(numbers.filter((n) => n in api).map((n) => [n, api[n]] as const))),
    writeUpdates: vi.fn(async (updates: Array<{ dealId: string }>) =>
      updates.map((update) => ({ dealId: update.dealId, error: null }))),
    now: () => NOW
  } as never;
}

describe("decideRefresh", () => {
  it("updates both fields with the same text", () => {
    const decision = decideRefresh(deal(1, "100"), "Проект договора", NOW.toISOString());
    expect(decision).toMatchObject({
      kind: "update", from: "Утвержден", to: "Проект договора",
      fields: { UF_CRM_PLAN_STATUS: "Проект договора", UF_CRM_6627AEBD85B4D: "Проект договора" }
    });
  });

  it("writes only the changed field", () => {
    const stale = deal(1, "100", "Утвержден", { UF_CRM_6627AEBD85B4D: "Опубликован", UF_CRM_S2L_GZ_PUBLISHED_AT: "x" });
    const decision = decideRefresh(stale, "Опубликован", NOW.toISOString());
    expect(decision).toMatchObject({ kind: "update", fields: { UF_CRM_PLAN_STATUS: "Опубликован" } });
    if (decision.kind === "update") expect(Object.keys(decision.fields)).toEqual(["UF_CRM_PLAN_STATUS"]);
  });

  it("fills published-at when the new status is «Опубликован» and the date is empty", () => {
    const decision = decideRefresh(deal(1, "100"), "Опубликован", NOW.toISOString());
    expect(decision).toMatchObject({ kind: "update", fields: { UF_CRM_S2L_GZ_PUBLISHED_AT: NOW.toISOString() } });
  });

  it("does not touch published-at for other statuses", () => {
    const decision = decideRefresh(deal(1, "100"), "Договор действует", NOW.toISOString());
    expect(decision.kind === "update" && "UF_CRM_S2L_GZ_PUBLISHED_AT" in decision.fields).toBe(false);
  });

  it("keeps an existing published-at date", () => {
    const withDate = deal(1, "100", "Утвержден", { UF_CRM_S2L_GZ_PUBLISHED_AT: "2026-10-01T00:00:00Z" });
    const decision = decideRefresh(withDate, "Опубликован", NOW.toISOString());
    expect(decision.kind === "update" && "UF_CRM_S2L_GZ_PUBLISHED_AT" in decision.fields).toBe(false);
  });

  it("reports unchanged when both fields already hold the API text; differing case is normalised", () => {
    expect(decideRefresh(deal(1, "100", "опубликован", { UF_CRM_S2L_GZ_PUBLISHED_AT: "x" }), "Опубликован", "t"))
      .toMatchObject({ kind: "update" });
    expect(decideRefresh(deal(1, "100", "Заявка"), "Заявка", "t")).toEqual({ kind: "unchanged" });
  });

  it("never downgrades: CRM «Проект договора» vs API «Опубликован»", () => {
    expect(decideRefresh(deal(1, "100", "Проект договора"), "Опубликован", "t")).toEqual({
      kind: "downgrade", crmStatus: "Проект договора", apiStatus: "Опубликован"
    });
  });

  it("skips when a non-empty status is not in the rank table", () => {
    expect(decideRefresh(deal(1, "100", "Что-то новое"), "Опубликован", "t").kind).toBe("unknown-status");
  });

  it("updates an empty CRM status", () => {
    const empty = deal(1, "100", "", { UF_CRM_6627AEBD85B4D: "" });
    expect(decideRefresh(empty, "Утвержден", "t").kind).toBe("update");
  });

  it("ranks the lifecycle in order", () => {
    const order = ["Утвержден", "Опубликован", "Заявка", "Закупка состоялась", "Проект договора", "Договор действует", "Исполнен"];
    const ranks = order.map((status) => getStatusRank(status) as number);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(getStatusRank("ДОГОВОР ДЕЙСТВУЕТ")).toBe(getStatusRank("Договор действует"));
  });
});

describe("runPlanStatusRefresh", () => {
  it("requests statuses in batches of 50 unique plan numbers", async () => {
    const deals = Array.from({ length: 120 }, (_, index) => deal(index + 1, String(1000 + index)));
    deals.push(deal(500, "1000")); // duplicate plan number must not be requested twice
    const deps = makeDeps(deals, {});
    await runPlanStatusRefresh(deps, { execute: false });
    expect(deps.fetchStatuses.mock.calls.map(([numbers]) => (numbers as string[]).length)).toEqual([50, 50, 20]);
  });

  it("leaves deals missing in the API untouched and counts them as not found", async () => {
    const deps = makeDeps([deal(1, "100"), deal(2, "200")], { "100": "Опубликован" });
    const report = await runPlanStatusRefresh(deps, { execute: true });
    expect(report).toMatchObject({ totalDeals: 2, foundInApi: 1, notFound: 1, toUpdate: 1 });
    expect(deps.writeUpdates).toHaveBeenCalledTimes(1);
    expect(deps.writeUpdates.mock.calls[0][0].map((u: { dealId: string }) => u.dealId)).toEqual(["1"]);
  });

  it("skips downgrades and lists them separately", async () => {
    const deps = makeDeps([deal(1, "100", "Договор действует")], { "100": "Опубликован" });
    const report = await runPlanStatusRefresh(deps, { execute: true });
    expect(report.toUpdate).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.skippedDowngrade).toEqual([
      { dealId: "1", title: "Сделка 1", planNumber: "100", crmStatus: "Договор действует", apiStatus: "Опубликован" }
    ]);
    expect(deps.writeUpdates).not.toHaveBeenCalled();
    expect(formatReportLines(report).some((line) => line.includes("пропуск (понижение): сделка 1"))).toBe(true);
  });

  it("writes both fields in execute mode and counts pairs", async () => {
    const deps = makeDeps([deal(1, "100"), deal(2, "200")], { "100": "Проект договора", "200": "Проект договора" });
    const report = await runPlanStatusRefresh(deps, { execute: true });
    const [updates] = deps.writeUpdates.mock.calls[0];
    expect(updates[0].fields).toEqual({
      UF_CRM_PLAN_STATUS: "Проект договора", UF_CRM_6627AEBD85B4D: "Проект договора"
    });
    expect(report.updated).toBe(2);
    expect(report.updatePairs).toEqual([{ from: "Утвержден", to: "Проект договора", count: 2 }]);
  });

  it("dry-run never calls the writer", async () => {
    const deps = makeDeps([deal(1, "100")], { "100": "Опубликован" });
    const report = await runPlanStatusRefresh(deps, { execute: false });
    expect(report).toMatchObject({ mode: "dry-run", toUpdate: 1, updated: 0 });
    expect(deps.writeUpdates).not.toHaveBeenCalled();
  });

  it("prints at most 20 preview rows in dry-run", async () => {
    const deals = Array.from({ length: 30 }, (_, index) => deal(index + 1, String(100 + index)));
    const api = Object.fromEntries(deals.map((d) => [String(d.UF_CRM_PLAN_ID), "Опубликован"]));
    const report = await runPlanStatusRefresh(makeDeps(deals, api), { execute: false });
    const lines = formatReportLines(report);
    const start = lines.findIndex((line) => line.startsWith("первые 20"));
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start + 1)).toHaveLength(20);
    expect(lines[start + 1]).toBe("  1, 100, Утвержден → Опубликован");
  });

  it("records a failed batch as an error and does not touch its deals", async () => {
    const deps = makeDeps([deal(1, "100")], {});
    deps.fetchStatuses.mockRejectedValueOnce(new Error("HTTP 500"));
    const report = await runPlanStatusRefresh(deps, { execute: true });
    expect(report.errors).toHaveLength(1);
    expect(report).toMatchObject({ notFound: 0, foundInApi: 0 });
    expect(deps.writeUpdates).not.toHaveBeenCalled();
  });

  it("aborts the run on an auth error", async () => {
    const deps = makeDeps([deal(1, "100")], {});
    const authError = Object.assign(new Error("401"), { name: "GoszakupAuthError" });
    deps.fetchStatuses.mockRejectedValueOnce(authError);
    await expect(runPlanStatusRefresh(deps, { execute: true })).rejects.toThrow("401");
  });

  it("reports per-deal write errors", async () => {
    const deps = makeDeps([deal(1, "100"), deal(2, "200")], { "100": "Опубликован", "200": "Опубликован" });
    deps.writeUpdates.mockResolvedValueOnce([
      { dealId: "1", error: null }, { dealId: "2", error: "ACCESS_DENIED" }
    ]);
    const report = await runPlanStatusRefresh(deps, { execute: true });
    expect(report.updated).toBe(1);
    expect(report.errors).toEqual([{ dealId: "2", planNumber: "200", message: "ACCESS_DENIED" }]);
  });

  it("skips deals with a non-numeric plan number", async () => {
    const deps = makeDeps([deal(1, "ABC-1")], {});
    const report = await runPlanStatusRefresh(deps, { execute: false });
    expect(report.skippedInvalidPlanNumber).toHaveLength(1);
    expect(deps.fetchStatuses).not.toHaveBeenCalled();
  });
});

describe("batch deal updater", () => {
  it("builds crm.deal.update commands with REGISTER_SONET_EVENT=N", () => {
    const [command] = buildDealUpdateCommands([{ dealId: "7", fields: { UF_CRM_PLAN_STATUS: "Заявка" } }]);
    expect(command).toEqual({
      key: "deal_7",
      method: "crm.deal.update",
      params: { id: "7", fields: { UF_CRM_PLAN_STATUS: "Заявка" }, params: { REGISTER_SONET_EVENT: "N" } }
    });
  });

  it("maps batch errors back to deals", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { result: { deal_7: true }, result_error: { deal_8: { error: "ACCESS_DENIED", error_description: "nope" } } }
    })));
    const update = createBatchDealUpdater("https://example.bitrix24.kz/rest/1/x/", fetchImpl as never);
    const results = await update([
      { dealId: "7", fields: { a: "1" } }, { dealId: "8", fields: { a: "1" } }
    ]);
    expect(results).toEqual([
      { dealId: "7", error: null }, { dealId: "8", error: "ACCESS_DENIED: nope" }
    ]);
  });
});
