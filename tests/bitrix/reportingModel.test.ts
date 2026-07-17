import { describe, expect, it } from "vitest";
import {
  buildNormalizedReport,
  computeReportMetrics,
  mapCanonicalPhase,
  type RawDeal,
  type RawStageHistory,
  type ReportingConfig
} from "../../src/bitrix/reporting/model.js";

const config: ReportingConfig = {
  asOf: "2026-07-17T23:59:59+03:00",
  currentPeriod: { from: "2026-01-01", to: "2026-07-17" },
  previousPeriod: { from: "2025-01-01", to: "2025-07-17" },
  salesPipelineIds: [9, 41, 43],
  routingPipelineIds: [29],
  servicePipelineIds: [17],
  selectedPipelineIds: [9, 29, 41, 43],
  attentionAfterDays: 30,
  criticalAfterDays: 60
};

function deal(overrides: Partial<RawDeal> = {}): RawDeal {
  return {
    ID: "1",
    TITLE: "Сделка 1",
    CATEGORY_ID: "9",
    STAGE_ID: "C9:NEW",
    OPPORTUNITY: "1000000",
    CURRENCY_ID: "KZT",
    DATE_CREATE: "2026-01-10T10:00:00+03:00",
    DATE_MODIFY: "2026-01-10T10:00:00+03:00",
    ASSIGNED_BY_ID: "7",
    COMPANY_ID: "70",
    SOURCE_ID: "WEB",
    ...overrides
  };
}

function event(overrides: Partial<RawStageHistory> = {}): RawStageHistory {
  return {
    ID: "1",
    TYPE_ID: "1",
    OWNER_ID: "1",
    CREATED_TIME: "2026-01-10T10:00:00+03:00",
    CATEGORY_ID: "9",
    STAGE_SEMANTIC_ID: "P",
    STAGE_ID: "C9:NEW",
    ...overrides
  };
}

describe("Bitrix B2G reporting model", () => {
  it("treats pipeline 29 terminal technical semantics as routing, not wins or losses", () => {
    expect(mapCanonicalPhase(29, "C29:WON", "S")).toBe("excluded");
    expect(mapCanonicalPhase(29, "C29:LOSE", "F")).toBe("excluded");

    const report = buildNormalizedReport(
      [deal({ CATEGORY_ID: "29", STAGE_ID: "C29:WON" })],
      [event({ CATEGORY_ID: "29", STAGE_ID: "C29:WON", STAGE_SEMANTIC_ID: "S" })],
      config
    );

    expect(report.deals[0].outcome).toBe("routed");
    expect(computeReportMetrics(report, config).conversionRate).toBeNull();
  });

  it("uses the first entry into a logical sales funnel and does not duplicate a moved deal", () => {
    const report = buildNormalizedReport(
      [deal({ ID: "8", CATEGORY_ID: "41", STAGE_ID: "C41:PREPAYMENT_INVOIC" })],
      [
        event({ ID: "10", OWNER_ID: "8", CATEGORY_ID: "0", STAGE_ID: "NEW", CREATED_TIME: "2026-02-01T09:00:00+03:00" }),
        event({ ID: "11", OWNER_ID: "8", TYPE_ID: "5", CATEGORY_ID: "41", STAGE_ID: "C41:NEW", CREATED_TIME: "2026-02-05T09:00:00+03:00" }),
        event({ ID: "12", OWNER_ID: "8", TYPE_ID: "5", CATEGORY_ID: "9", STAGE_ID: "C9:NEW", CREATED_TIME: "2026-02-06T09:00:00+03:00" }),
        event({ ID: "13", OWNER_ID: "8", TYPE_ID: "5", CATEGORY_ID: "41", STAGE_ID: "C41:PREPAYMENT_INVOIC", CREATED_TIME: "2026-02-07T09:00:00+03:00" })
      ],
      config
    );

    expect(report.deals).toHaveLength(1);
    expect(report.deals[0].cohortEntryAt).toBe("2026-02-05T09:00:00+03:00");
    expect(report.migrations).toHaveLength(3);
  });

  it("classifies 9 to 17 as a service handoff instead of a loss", () => {
    const report = buildNormalizedReport(
      [deal({ ID: "9", CATEGORY_ID: "17", STAGE_ID: "C17:NEW" })],
      [
        event({ ID: "20", OWNER_ID: "9", CATEGORY_ID: "9", STAGE_ID: "C9:NEW" }),
        event({ ID: "21", OWNER_ID: "9", TYPE_ID: "5", CATEGORY_ID: "17", STAGE_ID: "C17:NEW", CREATED_TIME: "2026-03-01T10:00:00+03:00" })
      ],
      config
    );

    expect(report.deals[0].outcome).toBe("handoff_service");
    expect(computeReportMetrics(report, config).lostDeals).toBe(0);
  });

  it("maps the recoverable legacy preparation stage and isolates unknown legacy stages", () => {
    expect(mapCanonicalPhase(9, "C9:PREPARATION", "P")).toBe("assigned");
    expect(mapCanonicalPhase(9, "C9:UC_0VJVYL", "P")).toBe("legacy_unknown");
    expect(mapCanonicalPhase(41, "C41:UC_2B9SSK", "P")).toBe("legacy_unknown");
  });

  it("calculates conversion, amount coverage, comparison cohorts and age buckets deterministically", () => {
    const deals = [
      deal({ ID: "1", STAGE_ID: "C9:WON", DATE_CREATE: "2026-01-01T00:00:00+03:00" }),
      deal({ ID: "2", STAGE_ID: "C9:6", OPPORTUNITY: "", DATE_CREATE: "2026-07-17T23:59:59+03:00" }),
      deal({ ID: "3", STAGE_ID: "C9:NEW", OPPORTUNITY: "500", DATE_CREATE: "2025-07-17T12:00:00+03:00" })
    ];
    const history = [
      event({ OWNER_ID: "1", STAGE_ID: "C9:WON", STAGE_SEMANTIC_ID: "S", CREATED_TIME: "2026-01-01T00:00:00+03:00" }),
      event({ ID: "2", OWNER_ID: "2", STAGE_ID: "C9:6", STAGE_SEMANTIC_ID: "F", CREATED_TIME: "2026-07-17T23:59:59+03:00" }),
      event({ ID: "3", OWNER_ID: "3", STAGE_ID: "C9:NEW", STAGE_SEMANTIC_ID: "P", CREATED_TIME: "2025-07-17T12:00:00+03:00" })
    ];

    const metrics = computeReportMetrics(buildNormalizedReport(deals, history, config), config);

    expect(metrics.conversionRate).toBe(0.5);
    expect(metrics.amountCoverageRate).toBeCloseTo(2 / 3);
    expect(metrics.currentPeriodEntries).toBe(2);
    expect(metrics.previousPeriodEntries).toBe(1);
    expect(metrics.ageBuckets).toEqual(expect.objectContaining({ "61+": 1 }));
  });
});

