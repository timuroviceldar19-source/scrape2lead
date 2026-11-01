import { describe, it, expect } from "vitest";
import { getPultMonths, loadClosedMonths } from "../../src/bitrix/salesPult/months.js";
import { buildPultView } from "../../src/bitrix/salesPult/view.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const payload: SalesPultPayload = {
  asOfDate: "2026-10-31", generatedAt: "2026-10-31 23:59 (UTC+5)", portal: "https://example.invalid",
  closedMonth: true, callsAvailable: true, groups: [], dynamics: [],
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
    expect(view.signals).toEqual([]);
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
