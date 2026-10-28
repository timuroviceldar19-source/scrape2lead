import { describe, expect, it } from "vitest";
import {
  toAlmatyDate,
  calculateDailyMetrics,
  calculateRollups,
  getMetricStatus,
  rankTopTasks,
  getPultCollectionStartDate,
  getDateRange,
  type CallRecord,
  type StageTransition,
  type RawTask,
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

  it("ranks top 5 tasks: overdue first, then today, sorted by deal amount descending", () => {
    const now = "2026-10-28T12:00:00+05:00";
    const tasks: RawTask[] = [
      { id: "t1", dealId: "d1", title: "Activity 1", deadline: "2026-10-28T16:00:00+05:00", amount: 1_000_000, categoryId: 9, stageId: "C9:EXECUTING" },
      { id: "t2", dealId: "d2", title: "Activity 2", deadline: "2026-10-27T18:00:00+05:00", amount: 500_000, categoryId: 41, stageId: "C41:EXECUTING" }, // Overdue
      { id: "t3", dealId: "d3", title: "Activity 3", deadline: "2026-10-28T14:00:00+05:00", amount: 5_000_000, categoryId: 43, stageId: "C43:EXECUTING" }, // Today, high amount
      { id: "t4", dealId: "d4", title: "Activity 4", deadline: "2026-10-27T10:00:00+05:00", amount: 3_000_000, categoryId: 9, stageId: "C9:EXECUTING" }, // Overdue, high amount
      { id: "t5", dealId: "d5", title: "Activity 5", deadline: "2026-10-28T17:00:00+05:00", amount: 2_000_000, categoryId: 9, stageId: "C9:EXECUTING" },
      { id: "t6", dealId: "d6", title: "Activity 6", deadline: "2026-10-28T15:00:00+05:00", amount: 100_000, categoryId: 9, stageId: "C9:EXECUTING" }
    ];

    const top5 = rankTopTasks(tasks, now);
    expect(top5).toHaveLength(5);
    // Overdue tasks first, sorted by amount desc: t4 (3M), then t2 (500k)
    expect(top5[0].id).toBe("t4");
    expect(top5[0].isOverdue).toBe(true);
    expect(top5[1].id).toBe("t2");
    expect(top5[1].isOverdue).toBe(true);
    // Then today tasks, sorted by amount desc: t3 (5M), t5 (2M), t1 (1M)
    expect(top5[2].id).toBe("t3");
    expect(top5[2].isOverdue).toBe(false);
    expect(top5[3].id).toBe("t5");
    expect(top5[4].id).toBe("t1");
  });

  it("deduplicates tasks by dealId taking the highest priority task per deal", () => {
    const now = "2026-10-28T12:00:00+05:00";
    const tasks: RawTask[] = [
      { id: "t1_overdue", dealId: "deal_1", title: "Overdue call", deadline: "2026-10-27T12:00:00+05:00", amount: 1_000_000, categoryId: 9, stageId: "C9:EXECUTING" },
      { id: "t1_upcoming", dealId: "deal_1", title: "Upcoming meeting", deadline: "2026-10-28T16:00:00+05:00", amount: 1_000_000, categoryId: 9, stageId: "C9:EXECUTING" },
      { id: "t2", dealId: "deal_2", title: "Task 2", deadline: "2026-10-28T15:00:00+05:00", amount: 2_000_000, categoryId: 9, stageId: "C9:EXECUTING" }
    ];

    const top = rankTopTasks(tasks, now);
    expect(top).toHaveLength(2);
    expect(top.map((t) => t.id)).toEqual(["t1_overdue", "t2"]);
  });

  it("filters out closed deals and funnels other than 9, 41, 43", () => {
    const now = "2026-10-28T12:00:00+05:00";
    const tasks: RawTask[] = [
      { id: "t_valid", dealId: "d1", title: "Valid deal", deadline: "2026-10-28T15:00:00+05:00", amount: 1_000_000, categoryId: 9, stageId: "C9:EXECUTING" },
      { id: "t_won", dealId: "d2", title: "Won deal", deadline: "2026-10-28T15:00:00+05:00", amount: 5_000_000, categoryId: 9, stageId: "C9:WON" },
      { id: "t_lose", dealId: "d3", title: "Lost deal", deadline: "2026-10-28T15:00:00+05:00", amount: 3_000_000, categoryId: 41, stageId: "C41:LOSE" },
      { id: "t_wrong_funnel", dealId: "d4", title: "Funnel 1", deadline: "2026-10-28T15:00:00+05:00", amount: 10_000_000, categoryId: 1, stageId: "NEW" }
    ];

    const top = rankTopTasks(tasks, now);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe("t_valid");
  });

  it("filters out tasks that are overdue by more than maxOverdueDays (30 days)", () => {
    const now = "2026-10-28T12:00:00+05:00";
    const tasks: RawTask[] = [
      // 5 days overdue -> keep
      { id: "t_recent_overdue", dealId: "d1", title: "Recent overdue", deadline: "2026-10-23T12:00:00+05:00", amount: 1_000_000, categoryId: 9, stageId: "C9:EXECUTING" },
      // 35 days overdue -> reject
      { id: "t_ancient_overdue", dealId: "d2", title: "Ancient overdue", deadline: "2026-09-20T12:00:00+05:00", amount: 9_000_000, categoryId: 9, stageId: "C9:EXECUTING" }
    ];

    const top = rankTopTasks(tasks, now, { maxOverdueDays: 30 });
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe("t_recent_overdue");
  });
  it("filters funnels according to custom topTaskCategories when specified", () => {
    const now = "2026-10-28T12:00:00+05:00";
    const tasks: RawTask[] = [
      { id: "t_9", dealId: "d1", title: "Funnel 9", deadline: "2026-10-28T15:00:00+05:00", amount: 1_000_000, categoryId: 9, stageId: "C9:EXECUTING" },
      { id: "t_41", dealId: "d2", title: "Funnel 41", deadline: "2026-10-28T15:00:00+05:00", amount: 2_000_000, categoryId: 41, stageId: "C41:EXECUTING" },
      { id: "t_43", dealId: "d3", title: "Funnel 43", deadline: "2026-10-28T15:00:00+05:00", amount: 3_000_000, categoryId: 43, stageId: "C43:EXECUTING" }
    ];

    // Only allow funnel 41
    const top = rankTopTasks(tasks, now, { topTaskCategories: [41] });
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe("t_41");
  });
});
