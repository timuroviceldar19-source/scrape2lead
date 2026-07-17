import { describe, expect, it } from "vitest";
import { renderDashboardHtml } from "../../src/bitrix/reporting/dashboard.js";
import type { DashboardPayload } from "../../src/bitrix/reporting/types.js";

const payload: DashboardPayload = {
  generatedAt: "2026-07-17T12:00:00+03:00",
  asOfDate: "2026-07-17",
  portalBaseUrl: "https://example.bitrix24.kz",
  metrics: {
    totalDeals: 2,
    salesDeals: 2,
    routingDeals: 0,
    openDeals: 1,
    wonDeals: 1,
    lostDeals: 0,
    conversionRate: 1,
    amountCoverageRate: 1,
    openAmount: 100,
    routingAmount: 0,
    currentPeriodEntries: 2,
    previousPeriodEntries: 1,
    ageBuckets: { "0-7": 1, "8-14": 0, "15-30": 0, "31-60": 0, "61+": 1 },
    byPhase: [{ phase: "new", deals: 1, amount: 100 }],
    byPipeline: [{ pipelineId: 9, pipelineName: "B2G - Остальные", deals: 2, amount: 200 }],
    monthlyComparison: [],
    lossReasons: [],
    migrationSummary: []
  },
  deals: [{
    id: "1",
    title: "Закрытая сделка",
    pipelineId: 9,
    pipelineName: "B2G - Остальные",
    pipelineRole: "sales_funnel",
    rawStageId: "C9:WON",
    rawStageName: "Сделка успешна",
    canonicalPhase: "won",
    outcome: "won",
    amount: 100,
    hasPositiveAmount: true,
    currency: "KZT",
    createdAt: "2026-01-01T00:00:00+03:00",
    cohortEntryAt: "2026-01-01T00:00:00+03:00",
    lastStageAt: "2026-07-17T00:00:00+03:00",
    ageDays: 0,
    managerId: "7",
    managerName: "Иван Иванов",
    companyId: "70",
    companyName: "Компания Альфа",
    sourceId: "WEB",
    dealUrl: "https://example.bitrix24.kz/crm/deal/details/1/"
  }],
  pipelineNames: { "9": "B2G - Остальные" },
  managerNames: { "7": "Иван Иванов" },
  stageMapping: [],
  dataQuality: {
    amountCoverageRate: 1,
    companyCoverageRate: 1,
    sourceCoverageRate: 1,
    assignedCoverageRate: 1,
    unknownStageEvents: 0,
    retiredStageKeys: 0,
    notes: []
  }
};

describe("self-contained reporting dashboard", () => {
  it("embeds data and interactions without CDN dependencies or a webhook token", () => {
    const html = renderDashboardHtml(payload);

    expect(html).toContain("Bitrix24 — B2G аналитика");
    expect(html).toContain("Компания Альфа");
    expect(html).toContain("data-filter=\"phase\"");
    expect(html).toContain("crm/deal/details/1/");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).not.toContain("rest/1/");
  });

  it("escapes executable user data before embedding it into HTML", () => {
    const dangerous = structuredClone(payload);
    dangerous.deals[0].title = "</script><script>alert(1)</script>";

    const html = renderDashboardHtml(dangerous);

    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script>");
  });
});

