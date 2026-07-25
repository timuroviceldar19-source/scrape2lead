import { describe, expect, it } from "vitest";
import {
  computeActivityMetrics,
  type ActivityDealInput,
  type ActivityMetricsConfig,
  type RawActivity
} from "../../src/bitrix/reporting/activityMetrics.js";

const config: ActivityMetricsConfig = {
  asOf: "2026-07-19T23:59:59+03:00",
  staleAfterDays: 14
};

function deal(overrides: Partial<ActivityDealInput> = {}): ActivityDealInput {
  return {
    id: "1",
    pipelineId: 9,
    createdAt: "2026-07-01T10:00:00+03:00",
    isOpen: true,
    managerId: "7",
    ...overrides
  };
}

function activity(overrides: Partial<RawActivity> = {}): RawActivity {
  return {
    ID: "100",
    OWNER_ID: "1",
    OWNER_TYPE_ID: "2",
    CREATED: "2026-07-01T12:00:00+03:00",
    COMPLETED: "Y",
    RESPONSIBLE_ID: "7",
    ...overrides
  };
}

describe("Bitrix activity metrics", () => {
  it("counts deals without a single activity, split by open and closed", () => {
    const metrics = computeActivityMetrics(
      [
        deal({ id: "1", isOpen: true }),
        deal({ id: "2", isOpen: true }),
        deal({ id: "3", isOpen: false })
      ],
      [activity({ OWNER_ID: "1" })],
      config
    );

    expect(metrics.dealsAnalyzed).toEqual({ open: 2, closed: 1 });
    expect(metrics.dealsWithoutActivity).toEqual({ open: 1, closed: 1 });
  });

  it("computes average activities per deal per pipeline", () => {
    const metrics = computeActivityMetrics(
      [deal({ id: "1", pipelineId: 9 }), deal({ id: "2", pipelineId: 41 })],
      [
        activity({ ID: "100", OWNER_ID: "1" }),
        activity({ ID: "101", OWNER_ID: "1" }),
        activity({ ID: "102", OWNER_ID: "2" })
      ],
      config
    );

    const p9 = metrics.byPipeline.find((row) => row.pipelineId === 9);
    const p41 = metrics.byPipeline.find((row) => row.pipelineId === 41);
    expect(p9).toMatchObject({ deals: 1, dealsWithoutActivity: 0, avgActivities: 2 });
    expect(p41).toMatchObject({ deals: 1, dealsWithoutActivity: 0, avgActivities: 1 });
  });

  it("computes first reaction time median and p90 in hours, clamping negatives to zero", () => {
    const metrics = computeActivityMetrics(
      [
        deal({ id: "1", createdAt: "2026-07-01T10:00:00+03:00" }),
        deal({ id: "2", createdAt: "2026-07-01T10:00:00+03:00" }),
        deal({ id: "3", createdAt: "2026-07-01T10:00:00+03:00" }),
        deal({ id: "4", createdAt: "2026-07-01T10:00:00+03:00" })
      ],
      [
        // 2h, 4h, 100h reactions; deal 4 has an activity created BEFORE the deal (import artifact) -> 0h
        activity({ ID: "1", OWNER_ID: "1", CREATED: "2026-07-01T12:00:00+03:00" }),
        activity({ ID: "2", OWNER_ID: "1", CREATED: "2026-07-05T12:00:00+03:00" }),
        activity({ ID: "3", OWNER_ID: "2", CREATED: "2026-07-01T14:00:00+03:00" }),
        activity({ ID: "4", OWNER_ID: "3", CREATED: "2026-07-05T14:00:00+03:00" }),
        activity({ ID: "5", OWNER_ID: "4", CREATED: "2026-06-30T10:00:00+03:00" })
      ],
      config
    );

    expect(metrics.firstReactionHours.sampleSize).toBe(4);
    expect(metrics.firstReactionHours.median).toBe(3);
    expect(metrics.firstReactionHours.p90).toBe(100);
  });

  it("returns null reaction percentiles when no deal has activities", () => {
    const metrics = computeActivityMetrics([deal()], [], config);
    expect(metrics.firstReactionHours).toEqual({ median: null, p90: null, sampleSize: 0 });
  });

  it("flags abandoned open deals: no planned next step and stale activity", () => {
    const metrics = computeActivityMetrics(
      [
        // fresh deal with a pending activity -> healthy
        deal({ id: "1", createdAt: "2026-07-15T10:00:00+03:00" }),
        // old deal, last activity 2026-06-01 (48 days before asOf), everything completed -> stale + no next step
        deal({ id: "2", createdAt: "2026-05-01T10:00:00+03:00" }),
        // old deal without any activity at all -> stale + no next step
        deal({ id: "3", createdAt: "2026-04-01T10:00:00+03:00" }),
        // closed deal is never counted as abandoned
        deal({ id: "4", createdAt: "2026-04-01T10:00:00+03:00", isOpen: false })
      ],
      [
        activity({ ID: "1", OWNER_ID: "1", COMPLETED: "N", CREATED: "2026-07-16T10:00:00+03:00" }),
        activity({ ID: "2", OWNER_ID: "2", COMPLETED: "Y", CREATED: "2026-06-01T10:00:00+03:00" })
      ],
      config
    );

    expect(metrics.abandonedOpenDeals.noPlannedNextStep).toBe(2);
    expect(metrics.abandonedOpenDeals.noActivityForDays).toBe(2);
    expect(metrics.abandonedOpenDeals.staleAfterDays).toBe(14);
  });

  it("aggregates per-manager open-deal health using stable manager IDs only", () => {
    const metrics = computeActivityMetrics(
      [
        deal({ id: "1", managerId: "7" }),
        deal({ id: "2", managerId: "7", createdAt: "2026-05-01T10:00:00+03:00" }),
        deal({ id: "3", managerId: "9", isOpen: false })
      ],
      [activity({ ID: "1", OWNER_ID: "1", COMPLETED: "N", CREATED: "2026-07-18T10:00:00+03:00" })],
      config
    );

    const manager7 = metrics.byManager.find((row) => row.managerId === "7");
    expect(manager7).toMatchObject({ openDeals: 2, openWithoutActivity: 1, abandonedOpen: 1 });
    expect(metrics.byManager.find((row) => row.managerId === "9")).toBeUndefined();
  });

  it("ignores activities that belong to non-deal owners or unknown deals", () => {
    const metrics = computeActivityMetrics(
      [deal({ id: "1" })],
      [
        activity({ ID: "1", OWNER_ID: "1", OWNER_TYPE_ID: "1" }),
        activity({ ID: "2", OWNER_ID: "999" })
      ],
      config
    );

    expect(metrics.dealsWithoutActivity.open).toBe(1);
  });
});
