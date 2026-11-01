import { describe, it, expect, vi } from "vitest";
import { getPultMonths, loadClosedMonths } from "../../src/bitrix/salesPult/months.js";
import { buildPultView } from "../../src/bitrix/salesPult/view.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import { collectPultData } from "../../src/bitrix/salesPult/collect.js";
import { calculateRollups } from "../../src/bitrix/salesPult/metrics.js";
import type { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const payload: SalesPultPayload = {
  asOfDate: "2026-10-31", generatedAt: "2026-10-31 23:59 (UTC+5)", portal: "https://example.invalid",
  closedMonth: true, callsAvailable: true, groups: [{ id: "sales", name: "Продажи", managers: [] }], dynamics: [],
  targets: { daily: { calls: 1, proposals: 1, contracts: 1 }, weekly: { calls: 5, proposals: 5, contracts: 5 }, monthly: { calls: 20, proposals: 20, contracts: 20 } }
};

describe("pult closed months", () => {
  it("includes two previous months across year boundary", () => {
    expect(getPultMonths("2026-01-01")).toEqual([
      { key: "2026-01", from: "2026-01-01", to: "2026-01-31" },
      { key: "2025-12", from: "2025-12-01", to: "2025-12-31" },
      { key: "2025-11", from: "2025-11-01", to: "2025-11-30" }
    ]);
  });
  it("shows completed month without forecast and with every chart day", () => {
    const view = buildPultView(payload);
    expect(view.month.hasForecast).toBe(false);
    expect(view.month.verdict).toContain("Выполнено");
    expect(view.month.points).toHaveLength(32);
    expect(view.month.nowXDay).toBe(31);
    expect(view.month.dayFrac).toBe(1);
    expect(view.signals).toEqual([]);
  });
  it("uses final totals against the configured plan and current team size", () => {
    const rollups = calculateRollups({ managerId: "demo", asOfDate: payload.asOfDate,
      dailyMetrics: [], deals: new Map(), targets: payload.targets });
    rollups.month.contracts.uniqueDealsCount = 14;
    rollups.month.contracts.totalAmount = 140;
    const view = buildPultView({ ...payload, groups: [{ id: "sales", name: "Продажи",
      managers: [{ id: "demo", name: "Тестовый менеджер", active: true, rollups, topTasks: [] }] }] });
    expect(view.month).toMatchObject({ plan: 20, fact: 14, amount: 140, pct: 70, hasForecast: false });
    expect(view.month.verdict).toContain("текущему составу");
    expect(view.periods.month.sales.totals.contracts.fact).toBe(14);
  });
  it("bounds historical requests to the month and skips current tasks and profiles", async () => {
    const list = vi.fn(async () => []);
    const call = vi.fn(async () => []);
    const history = await collectPultData({ client: { listAllBatched: list, call } as unknown as ReadOnlyBitrixClient,
      fromDate: "2026-09-01", toDate: "2026-09-30", managerIds: ["demo"],
      proposalStages: ["PROPOSAL"], contractStages: ["CONTRACT"], historyOnly: true });
    expect(history.tasksByManager.size).toBe(0);
    expect(call).not.toHaveBeenCalled();
    expect(list.mock.calls.map((args) => (args as unknown[])[0])).not.toContain("crm.activity.list");
    const requests = list.mock.calls as unknown as Array<[string, { filter?: Record<string, string>; FILTER?: Record<string, string> }]>;
    expect(requests[0][1].filter).toMatchObject({ ">=CREATED_TIME": "2026-09-01T00:00:00+05:00", "<=CREATED_TIME": "2026-09-30T23:59:59+05:00" });
    expect(requests.find(([method]) => method === "voximplant.statistic.get")![1].FILTER)
      .toHaveProperty("<=CALL_START_DATE", "2026-09-30T23:59:59+05:00");
  });
  it("invalidates the cache when targets or team configuration changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-config-"));
    const collect = vi.fn(async () => payload);
    try {
      await loadClosedMonths("2026-11-01", dir, "v1", collect);
      await loadClosedMonths("2026-11-01", dir, "v2", collect);
      expect(collect).toHaveBeenCalledTimes(4);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("caches successful months daily and isolates a failed month", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-months-"));
    let calls = 0;
    const collect = async (month: { key: string }) => {
      calls++;
      if (month.key === "2026-09") throw new Error("unavailable");
      return payload;
    };
    try {
      const first = await loadClosedMonths("2026-11-01", dir, "fixture", collect);
      expect(first["2026-10"]).toEqual(payload);
      expect(first["2026-09"]).toBeNull();
      await loadClosedMonths("2026-11-01", dir, "fixture", collect);
      expect(calls).toBe(3);
      await loadClosedMonths("2026-11-02", dir, "fixture", collect);
      expect(calls).toBe(5);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
