import { describe, expect, it } from "vitest";
import {
  renderPultHtml,
  formatMoney,
  type SalesPultPayload
} from "../../src/bitrix/salesPult/site.js";

describe("salesPultSite", () => {
  const basePayload: SalesPultPayload = {
    asOfDate: "2026-10-28",
    generatedAt: "2026-10-28 15:00 (UTC+5)",
    portal: "https://ft3.bitrix24.kz",
    pultUrl: "https://f3-pult.pages.dev",
    targets: {
      daily: { calls: 15, proposals: 3, contracts: 1 },
      weekly: { calls: 75, proposals: 15, contracts: 5 },
      monthly: { calls: 300, proposals: 60, contracts: 20 }
    },
    callsAvailable: true,
    proposalsTracked: false,
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
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" },
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
                deadline: "2026-10-22T10:00:00+05:00",
                planNumber: "88001",
                lastComment: "Ждем КП",
                isOverdue: true,
                rank: 1
              }
            ]
          },
          {
            id: "205",
            name: "Жанат",
            active: true,
            rollups: {
              managerId: "205",
              asOfDate: "2026-10-28",
              day: {
                calls: { successful: 9, totalAttempts: 12, durationSeconds: 400, durationMinutes: 7, status: "red" },
                proposals: { uniqueDealsCount: 1, dealIds: ["102"], status: "red" },
                contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
              },
              week: {
                calls: { successful: 20, totalAttempts: 30, durationSeconds: 1000, durationMinutes: 16, status: "red" },
                proposals: { uniqueDealsCount: 2, dealIds: [], status: "red" },
                contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
              },
              month: {
                calls: { successful: 50, totalAttempts: 70, durationSeconds: 2500, durationMinutes: 41, status: "red" },
                proposals: { uniqueDealsCount: 5, dealIds: [], status: "red" },
                contracts: { uniqueDealsCount: 1, totalAmount: 1500000, dealIds: [], status: "red" }
              },
              signals: {
                zeroBitrixCallsToday: false,
                zeroKpThreeDays: false
              }
            },
            topTasks: []
          },
          {
            id: "2345",
            name: "Турар",
            active: true,
            rollups: {
              managerId: "2345",
              asOfDate: "2026-10-28",
              day: {
                calls: { successful: 15, totalAttempts: 16, durationSeconds: 900, durationMinutes: 15, status: "green" },
                proposals: { uniqueDealsCount: 3, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 4, totalAmount: 2400000, dealIds: [], status: "green" }
              },
              week: {
                calls: { successful: 80, totalAttempts: 90, durationSeconds: 4000, durationMinutes: 66, status: "green" },
                proposals: { uniqueDealsCount: 16, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 6, totalAmount: 5000000, dealIds: [], status: "green" }
              },
              month: {
                calls: { successful: 310, totalAttempts: 340, durationSeconds: 16000, durationMinutes: 266, status: "green" },
                proposals: { uniqueDealsCount: 65, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 22, totalAmount: 40000000, dealIds: [], status: "green" }
              },
              signals: {
                zeroBitrixCallsToday: false,
                zeroKpThreeDays: false
              }
            },
            topTasks: []
          }
        ]
      },
      {
        id: "tenders",
        name: "Тендерный отдел",
        managers: [
          {
            id: "559",
            name: "Эльмира",
            active: true,
            rollups: {
              managerId: "559",
              asOfDate: "2026-10-28",
              day: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "green" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 3, totalAmount: 4600000, dealIds: ["301"], status: "green" }
              },
              week: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "green" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 5, totalAmount: 8000000, dealIds: [], status: "green" }
              },
              month: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "green" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 18, totalAmount: 32000000, dealIds: [], status: "green" }
              },
              signals: {
                zeroBitrixCallsToday: false,
                zeroKpThreeDays: false
              }
            },
            topTasks: []
          },
          {
            id: "2377",
            name: "Нурдаулет",
            active: true,
            rollups: {
              managerId: "2377",
              asOfDate: "2026-10-28",
              day: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "green" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
              },
              week: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "green" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 1, totalAmount: 1000000, dealIds: [], status: "red" }
              },
              month: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "green" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "green" },
                contracts: { uniqueDealsCount: 2, totalAmount: 2365000, dealIds: [], status: "red" }
              },
              signals: {
                zeroBitrixCallsToday: false,
                zeroKpThreeDays: false
              }
            },
            topTasks: []
          }
        ]
      }
    ],
    dynamics: [
      {
        date: "2026-10-28",
        calls: 37,
        proposals: 4,
        contracts: 5,
        amount: 7800000
      }
    ]
  };

  it("formats money correctly: 850 000 ₸ / 2,4 млн ₸ / 1 млн ₸", () => {
    expect(formatMoney(850000)).toBe("850 000 ₸");
    expect(formatMoney(2400000)).toBe("2,4 млн ₸");
    expect(formatMoney(1000000)).toBe("1 млн ₸");
    expect(formatMoney(0)).toBe("");
  });

  it("never outputs '0 ₸' anywhere on the page", () => {
    const html = renderPultHtml(basePayload);
    expect(html).not.toContain("0 ₸");
    expect(html).not.toMatch(/\b0\s*₸\b/);
  });

  it("ensures tender department has no calls or proposals anywhere", () => {
    const html = renderPultHtml(basePayload);

    // Header has tender dept
    expect(html).toContain("Тендерный отдел");

    // The tender table header only has Manager and Signed
    expect(html).toContain("<thead><tr><th>Менеджер</th><th>Подписал</th></tr></thead>");

    // In every tender department section, no calls or proposals exist
    const tenderParts = html.split('<h2>Тендерный отдел</h2>').slice(1);
    expect(tenderParts.length).toBeGreaterThan(0);

    for (const part of tenderParts) {
      // Look until the end of this department section
      const deptContent = part.split('</div>\n    </div>')[0] || part.split('</table>')[0];
      expect(deptContent).not.toContain("Дозвонился");
      expect(deptContent).not.toContain("Дозвонились");
      expect(deptContent).not.toContain("Отправил КП");
      expect(deptContent).not.toContain("Отправили КП");
      expect(deptContent).not.toContain("набирал");
      expect(deptContent).not.toContain("говорил");
    }
  });

  it("does not show low calls signal before 14:00 and shows it after 14:00", () => {
    const morningPayload: SalesPultPayload = {
      ...basePayload,
      generatedAt: "2026-10-28 11:30 (UTC+5)"
    };
    const morningHtml = renderPultHtml(morningPayload);
    expect(morningHtml).not.toContain("Мало звонков");

    const afternoonPayload: SalesPultPayload = {
      ...basePayload,
      generatedAt: "2026-10-28 15:30 (UTC+5)"
    };
    const afternoonHtml = renderPultHtml(afternoonPayload);
    expect(afternoonHtml).toContain("Мало звонков: Жанат — 9 из 15");
  });

  it("does not show red in proposals when proposalsTracked is false", () => {
    const untrackedPayload: SalesPultPayload = {
      ...basePayload,
      proposalsTracked: false
    };
    const html = renderPultHtml(untrackedPayload);

    expect(html).toContain("в CRM пока не отмечают");

    // Verify proposals column has no red status in sales table
    const salesTable = html.slice(0, html.indexOf("Тендерный отдел"));
    expect(salesTable).toContain("tile-value gray");
    expect(salesTable).toContain("mini-bar-fill gray");
  });

  it("sorts worse performing managers higher in the list", () => {
    const html = renderPultHtml(basePayload);

    // In sales, Жанат is red (9 of 15), Бахтияр is yellow (13 of 15), Турар is green (15 of 15)
    // Find day period view
    const dayViewStart = html.indexOf('<div class="period-view" data-period="day"');
    const weekViewStart = html.indexOf('<div class="period-view" data-period="week"');
    const daySection = html.slice(dayViewStart, weekViewStart);

    const janatIndex = daySection.indexOf("Жанат");
    const bahtiyarIndex = daySection.indexOf("Бахтияр");
    const turarIndex = daySection.indexOf("Турар");

    expect(janatIndex).toBeGreaterThan(-1);
    expect(bahtiyarIndex).toBeGreaterThan(-1);
    expect(turarIndex).toBeGreaterThan(-1);

    expect(janatIndex).toBeLessThan(bahtiyarIndex);
    expect(bahtiyarIndex).toBeLessThan(turarIndex);

    // In tenders, Нурдаулет is red (0 contracts), Эльмира is green (3 contracts)
    const nurdauletIndex = daySection.indexOf("Нурдаулет");
    const elmiraIndex = daySection.indexOf("Эльмира");

    expect(nurdauletIndex).toBeGreaterThan(-1);
    expect(elmiraIndex).toBeGreaterThan(-1);
    expect(nurdauletIndex).toBeLessThan(elmiraIndex);
  });

  it("renders task deadlines and overdue format correctly", () => {
    const html = renderPultHtml(basePayload);

    // Overdue by days
    expect(html).toContain("просрочено на 6 дней");
    // Deadline format
    expect(html).toContain("до 22 октября, 10:00");
  });

  it("renders a self-contained HTML page escaping scripts and dangerous characters", () => {
    const html = renderPultHtml(basePayload);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Пульт продаж F3</title>");
    expect(html).toContain("Обновлено 28 октября в 15:00");

    // Safe escaping: <script> should not be rendered raw in HTML body
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");

    // Deal links to Bitrix
    expect(html).toContain("https://ft3.bitrix24.kz/crm/deal/details/101/");

    // Period switchers
    expect(html).toContain('data-period="day"');
    expect(html).toContain('data-period="week"');
    expect(html).toContain('data-period="month"');
  });

  it("contains no external resource links (scripts, styles, fonts, images)", () => {
    const html = renderPultHtml(basePayload);

    const scriptSrcMatches = html.match(/<script[^>]+src=["'](https?:)?\/\/[^"']+/gi) ?? [];
    const linkHrefMatches = html.match(/<link[^>]+href=["'](https?:)?\/\/[^"']+/gi) ?? [];
    const fontMatches = html.match(/url\(["']?(https?:)?\/\/[^"')]+/gi) ?? [];

    expect(scriptSrcMatches).toHaveLength(0);
    expect(linkHrefMatches).toHaveLength(0);
    expect(fontMatches).toHaveLength(0);
  });
});
