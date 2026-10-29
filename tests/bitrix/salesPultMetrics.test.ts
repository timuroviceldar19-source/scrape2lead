import { describe, expect, it } from "vitest";
import {
  toAlmatyDate,
  calculateDailyMetrics,
  calculateRollups,
  getMetricStatus,
  getPultCollectionStartDate,
  getDateRange,
  type CallRecord,
  type StageTransition,
  type DealInfo
} from "../../src/bitrix/salesPult/metrics.js";

describe("salesPultMetrics", () => {
  it("determines date boundary strictly by UTC+5", () => {
    // 2026-10-27 18:59:59Z is 23:59:59 in UTC+5 -> 2026-10-27
    expect(toAlmatyDate("2026-10-27T18:59:59Z")).toBe("2026-10-27");
    // 2026-10-27 19:00:00Z is 00:00:00 in UTC+5 -> 2026-10-28
    expect(toAlmatyDate("2026-10-27T19:00:00Z")).toBe("2026-10-28");
    // Bitrix format +03:00: 2026-10-28T01:30:00+03:00 -> 2026-10-27T22:30:00Z -> 2026-10-28T03:30:00+05:00
    expect(toAlmatyDate("2026-10-28T01:30:00+03:00")).toBe("2026-10-28");
  });

  it("computes start date as min(1st of month, Monday of current week) when as-of is Wednesday 1st", () => {
    // 2026-07-01 is Wednesday.
    // The workweek Monday is 2026-06-29, Tuesday is 2026-06-30.
    const startDate = getPultCollectionStartDate("2026-07-01");
    expect(startDate).toBe("2026-06-29");

    const range = getDateRange(startDate, "2026-07-01");
    expect(range).toEqual(["2026-06-29", "2026-06-30", "2026-07-01"]);
  });

  it("computes start date as 1st of month when Monday is inside current month", () => {
    // 2026-10-28 is Wednesday. Month start is 2026-10-01. Monday is 2026-10-26.
    const startDate = getPultCollectionStartDate("2026-10-28");
    expect(startDate).toBe("2026-10-01");
  });

  it("deduplicates deals and sums amounts accurately without double-counting", () => {
    const deals = new Map<string, DealInfo>([
      ["101", { id: "101", title: "Deal 101", amount: 1_000_000, assignedById: "147", planNumber: "88001" }],
      ["102", { id: "102", title: "Deal 102", amount: 2_500_000, assignedById: "147", planNumber: "88002" }]
    ]);

    const transitions: StageTransition[] = [
      { id: "1", dealId: "101", stageId: "C9:WON", createdTime: "2026-10-28T10:00:00+05:00" },
      // Duplicate transition of the same deal on the same day
      { id: "2", dealId: "101", stageId: "C9:WON", createdTime: "2026-10-28T11:00:00+05:00" },
      { id: "3", dealId: "102", stageId: "C41:WON", createdTime: "2026-10-28T12:00:00+05:00" }
    ];

    const metrics = calculateDailyMetrics({
      managerId: "147",
      date: "2026-10-28",
      calls: [],
      kpTransitions: [],
      contractTransitions: transitions,
      deals
    });

    expect(metrics.contracts.uniqueDealsCount).toBe(2);
    expect(metrics.contracts.totalAmount).toBe(3_500_000);
    expect(metrics.contracts.dealIds).toEqual(["101", "102"]);
  });

  it("filters out unsuccessful calls and calculates durations", () => {
    const calls: CallRecord[] = [
      { id: "c1", userId: "147", statusCode: "200", durationSeconds: 65, startDate: "2026-10-28T10:00:00+05:00" },
      { id: "c2", userId: "147", statusCode: "304", durationSeconds: 0, startDate: "2026-10-28T10:15:00+05:00" },
      { id: "c3", userId: "147", statusCode: "200", durationSeconds: 120, startDate: "2026-10-28T11:00:00+05:00" },
      { id: "c4", userId: "147", statusCode: "603", durationSeconds: 5, startDate: "2026-10-28T11:30:00+05:00" }
    ];

    const metrics = calculateDailyMetrics({
      managerId: "147",
      date: "2026-10-28",
      calls,
      kpTransitions: [],
      contractTransitions: [],
      deals: new Map()
    });

    expect(metrics.calls.successful).toBe(2);
    expect(metrics.calls.totalAttempts).toBe(4);
    expect(metrics.calls.durationSeconds).toBe(185);
    expect(metrics.calls.durationMinutes).toBe(3); // 185s = 3m
    expect(metrics.calls.hasBitrixCalls).toBe(true);
  });

  it("calculates weekly and monthly rollups with target thresholds", () => {
    const targets = {
      daily: { calls: 15, proposals: 3, contracts: 1 },
      weekly: { calls: 75, proposals: 15, contracts: 5 },
      monthly: { calls: 300, proposals: 60, contracts: 20 }
    };

    const deals = new Map<string, DealInfo>([
      ["d1", { id: "d1", title: "Deal 1", amount: 1_000_000, assignedById: "147", planNumber: "1" }],
      ["d2", { id: "d2", title: "Deal 2", amount: 2_000_000, assignedById: "147", planNumber: "2" }]
    ]);

    const dailyMetrics = [
      {
        managerId: "147",
        date: "2026-10-26", // Monday
        calls: { successful: 15, totalAttempts: 20, durationSeconds: 900, durationMinutes: 15, hasBitrixCalls: true },
        proposals: { uniqueDealsCount: 3, dealIds: ["p1", "p2", "p3"] },
        contracts: { uniqueDealsCount: 1, totalAmount: 1_000_000, dealIds: ["d1"] }
      },
      {
        managerId: "147",
        date: "2026-10-27", // Tuesday
        calls: { successful: 10, totalAttempts: 15, durationSeconds: 600, durationMinutes: 10, hasBitrixCalls: true },
        proposals: { uniqueDealsCount: 2, dealIds: ["p4", "p5"] },
        contracts: { uniqueDealsCount: 1, totalAmount: 2_000_000, dealIds: ["d2"] }
      }
    ];

    const rollups = calculateRollups({
      managerId: "147",
      asOfDate: "2026-10-27",
      dailyMetrics,
      deals,
      targets
    });

    // Week rollup
    expect(rollups.week.calls.successful).toBe(25);
    expect(rollups.week.proposals.uniqueDealsCount).toBe(5);
    expect(rollups.week.contracts.uniqueDealsCount).toBe(2);
    expect(rollups.week.contracts.totalAmount).toBe(3_000_000);

    // Status colors
    expect(getMetricStatus(15, 15)).toBe("green");
    expect(getMetricStatus(10, 15)).toBe("yellow"); // ~67%
    expect(getMetricStatus(2, 15)).toBe("red");
  });
  it("counts portal won and partner deals as contracts on their portal sign date", () => {
    const deals = new Map<string, DealInfo>([
      [
        "w1",
        {
          id: "w1",
          title: "Deal W1 (won on portal)",
          amount: 5_000_000,
          assignedById: "147",
          outcome: "won:123/456",
          portalSignDate: "2026-10-14",
          stageSemanticId: "P"
        }
      ],
      [
        "w2",
        {
          id: "w2",
          title: "Deal W2 (partner won on portal)",
          amount: 3_000_000,
          assignedById: "147",
          outcome: "partner:789/101",
          portalSignDate: "2026-10-14",
          stageSemanticId: "S"
        }
      ],
      [
        "w3",
        {
          id: "w3",
          title: "Deal W3 (won on portal, closed as lost in CRM - error)",
          amount: 4_000_000,
          assignedById: "147",
          outcome: "won:111/222",
          portalSignDate: "2026-10-14",
          stageSemanticId: "F"
        }
      ],
      [
        "w4",
        {
          id: "w4",
          title: "Deal W4 (signed on portal 2026-10-14, but moved to won in CRM on 2026-10-20)",
          amount: 2_000_000,
          assignedById: "147",
          outcome: "won:333/444",
          portalSignDate: "2026-10-14",
          stageSemanticId: "S"
        }
      ],
      [
        "c1",
        {
          id: "c1",
          title: "Deal C1 (regular CRM won deal, no portal outcome)",
          amount: 1_500_000,
          assignedById: "147",
          stageSemanticId: "S"
        }
      ]
    ]);

    const transitions: StageTransition[] = [
      { id: "t1", dealId: "w4", stageId: "C9:WON", createdTime: "2026-10-20T10:00:00+05:00" },
      { id: "t2", dealId: "c1", stageId: "C9:WON", createdTime: "2026-10-20T11:00:00+05:00" }
    ];

    const metricsOct14 = calculateDailyMetrics({
      managerId: "147",
      date: "2026-10-14",
      calls: [],
      kpTransitions: [],
      contractTransitions: transitions,
      deals
    });

    expect(metricsOct14.contracts.uniqueDealsCount).toBe(3);
    expect(metricsOct14.contracts.totalAmount).toBe(10_000_000);
    expect(metricsOct14.contracts.dealIds.sort()).toEqual(["w1", "w2", "w4"].sort());

    const metricsOct20 = calculateDailyMetrics({
      managerId: "147",
      date: "2026-10-20",
      calls: [],
      kpTransitions: [],
      contractTransitions: transitions,
      deals
    });

    expect(metricsOct20.contracts.uniqueDealsCount).toBe(1);
    expect(metricsOct20.contracts.totalAmount).toBe(1_500_000);
    expect(metricsOct20.contracts.dealIds).toEqual(["c1"]);
  });

});
