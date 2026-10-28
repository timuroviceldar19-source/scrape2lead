import { describe, expect, it } from "vitest";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

describe("salesPultSite", () => {
  const samplePayload: SalesPultPayload = {
    asOfDate: "2026-10-28",
    generatedAt: "2026-10-28 14:00 (UTC+5)",
    portal: "https://ft3.bitrix24.kz",
    pultUrl: "https://f3-pult.pages.dev",
    targets: {
      daily: { calls: 15, proposals: 3, contracts: 1 },
      weekly: { calls: 75, proposals: 15, contracts: 5 },
      monthly: { calls: 300, proposals: 60, contracts: 20 }
    },
    callsAvailable: true,
    groups: [
      {
        id: "sales",
        name: "Отдел продаж",
        managers: [
          {
            id: "147",
            name: "Бахтияр <script>alert(1)</script>",
            active: true,
            rollups: {
              managerId: "147",
              asOfDate: "2026-10-28",
              day: {
                calls: { successful: 13, totalAttempts: 15, durationSeconds: 600, durationMinutes: 10, status: "yellow" },
                proposals: { uniqueDealsCount: 4, dealIds: ["101"], status: "green" },
                contracts: { uniqueDealsCount: 2, totalAmount: 3200000, dealIds: ["201"], status: "green" }
              },
              week: {
                calls: { successful: 38, totalAttempts: 45, durationSeconds: 2400, durationMinutes: 40, status: "yellow" },
                proposals: { uniqueDealsCount: 11, dealIds: [], status: "yellow" },
                contracts: { uniqueDealsCount: 3, totalAmount: 7500000, dealIds: [], status: "yellow" }
              },
              month: {
                calls: { successful: 210, totalAttempts: 250, durationSeconds: 15000, durationMinutes: 250, status: "yellow" },
                proposals: { uniqueDealsCount: 42, dealIds: [], status: "yellow" },
                contracts: { uniqueDealsCount: 14, totalAmount: 34500000, dealIds: [], status: "yellow" }
              },
              signals: {
                zeroBitrixCallsToday: false,
                zeroKpThreeDays: false
              }
            },
            topTasks: [
              {
                id: "act-1",
                dealId: "101",
                title: 'Ноутбуки & "планшеты"',
                amount: 4500000,
                deadline: "2026-10-28T14:00:00+05:00",
                planNumber: "88001",
                lastComment: "Ждем КП",
                isOverdue: false,
                rank: 1
              }
            ]
          }
        ]
      }
    ],
    dynamics: [
      {
        date: "2026-10-28",
        calls: 13,
        proposals: 4,
        contracts: 2,
        amount: 3200000
      }
    ]
  };

  it("renders a self-contained HTML page escaping scripts and dangerous characters", () => {
    const html = renderPultHtml(samplePayload);

    // Document structure
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Пульт руководителя продаж F3</title>");
    expect(html).toContain("данные на 2026-10-28 14:00 (UTC+5)");

    // Safe escaping: <script> should not be rendered raw in HTML
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");

    // Deal links to Bitrix
    expect(html).toContain("https://ft3.bitrix24.kz/crm/deal/details/101/");

    // Period switcher elements
    expect(html).toContain('data-period="day"');
    expect(html).toContain('data-period="week"');
    expect(html).toContain('data-period="month"');

    // Signals block
    expect(html).toContain("Сигналы");
  });

  it("contains no external resource links (scripts, styles, fonts, images)", () => {
    const html = renderPultHtml(samplePayload);

    // Check for external scripts and styles
    const scriptSrcMatches = html.match(/<script[^>]+src=["'](https?:)?\/\/[^"']+/gi) ?? [];
    const linkHrefMatches = html.match(/<link[^>]+href=["'](https?:)?\/\/[^"']+/gi) ?? [];
    const fontMatches = html.match(/url\(["']?(https?:)?\/\/[^"')]+/gi) ?? [];

    expect(scriptSrcMatches).toHaveLength(0);
    expect(linkHrefMatches).toHaveLength(0);
    expect(fontMatches).toHaveLength(0);
  });
});
