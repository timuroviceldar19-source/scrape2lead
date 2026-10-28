import { describe, expect, it } from "vitest";
import {
  renderPultHtml,
  formatMoney,
  plural,
  pluralDeals,
  pluralDays,
  decodeHtmlEntities,
  formatTaskDeadline,
  formatOverdue,
  formatUpdatedTime,
  getAlmatyHour,
  buildSignals,
  type SalesPultPayload
} from "../../src/bitrix/salesPult/site.js";
import { formatAlmatyTime } from "../../src/bitrix/salesPult/metrics.js";

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
                lastComment: 'работает с &quot;Аданком&quot;',
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
          },
          {
            id: "999",
            name: "Бекзат",
            active: true,
            rollups: {
              managerId: "999",
              asOfDate: "2026-10-28",
              day: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "red" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" },
                contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
              },
              week: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "red" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" },
                contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
              },
              month: {
                calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "red" },
                proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" },
                contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
              },
              signals: {
                zeroBitrixCallsToday: true,
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
                contracts: { uniqueDealsCount: 2, totalAmount: 4600000, dealIds: ["301"], status: "green" }
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
                contracts: { uniqueDealsCount: 1, totalAmount: 0, dealIds: ["302"], status: "green" }
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

  it("1. calculates Almaty time (UTC+5) correctly from UTC ISO string", () => {
    expect(formatAlmatyTime("2026-10-28T13:50:00Z")).toBe("18:50");
    expect(formatAlmatyTime("2026-10-28T09:00:00Z")).toBe("14:00");
  });

  it("2. uses gender-neutral phrasing in signals and tables", () => {
    const html = renderPultHtml(basePayload);

    // Gender neutral contract signals: "Эльмира — 2 договора на 4,6 млн ₸"
    expect(html).toContain("Эльмира — 2 договора на 4,6 млн ₸");
    expect(html).toContain("Турар — 4 договора на 2,4 млн ₸");
    expect(html).not.toContain("подписал");
    expect(html).not.toContain("подписала");

    // Gender neutral zero calls signal: "Бекзат: сегодня нет звонков через Битрикс"
    expect(html).toContain("Бекзат: сегодня нет звонков через Битрикс");
    expect(html).not.toContain("не звонил через Битрикс");
    expect(html).not.toContain("не звонила через Битрикс");

    // In the table for manager with zero calls:
    expect(html).toContain("нет звонков через Битрикс");

    // Low calls signal: "Мало звонков: Жанат — 9 из 15"
    expect(html).toContain("Мало звонков: Жанат — 9 из 15");
  });

  it("3. correctly pluralizes words and avoids duplicate counters or .replace tricks", () => {
    // Unit plural tests
    expect(plural(1, ["задача", "задачи", "задач"])).toBe("1 задача");
    expect(plural(2, ["задача", "задачи", "задач"])).toBe("2 задачи");
    expect(plural(3, ["задача", "задачи", "задач"])).toBe("3 задачи");
    expect(plural(5, ["задача", "задачи", "задач"])).toBe("5 задач");
    expect(plural(11, ["задача", "задачи", "задач"])).toBe("11 задач");
    expect(plural(21, ["задача", "задачи", "задач"])).toBe("21 задача");

    expect(plural(1, ["договор", "договора", "договоров"])).toBe("1 договор");
    expect(plural(2, ["договор", "договора", "договоров"])).toBe("2 договора");
    expect(plural(5, ["договор", "договора", "договоров"])).toBe("5 договоров");

    expect(plural(1, ["день", "дня", "дней"])).toBe("1 день");
    expect(plural(3, ["день", "дня", "дней"])).toBe("3 дня");
    expect(plural(5, ["день", "дня", "дней"])).toBe("5 дней");

    const html = renderPultHtml(basePayload);
    expect(html).toContain("1 задача");
    expect(html).not.toContain("1 1 задач");
    expect(html).not.toContain("5 5 задачов");
    expect(html).not.toContain("3 3 задача");
  });

  it("4. converts task deadlines from Bitrix (+03:00) to Almaty (+05:00) and handles overdue", () => {
    // 07:19:33 +03:00 -> 09:19 in Almaty (+05:00)
    expect(formatTaskDeadline("2026-10-28T07:19:33+03:00")).toBe("до 28 октября, 09:19");

    // Overdue today (deadline today in Almaty and already passed)
    expect(formatOverdue("2026-10-28T07:19:33+03:00", "2026-10-28")).toBe("просрочено сегодня");

    // Overdue yesterday (1 day difference)
    expect(formatOverdue("2026-10-27T07:19:33+03:00", "2026-10-28")).toBe("просрочено на 1 день");

    // Overdue 3 days ago
    expect(formatOverdue("2026-10-25T10:00:00+03:00", "2026-10-28")).toBe("просрочено на 3 дня");
  });

  it("5. omits planTag when the plan number is already present in the deal title", () => {
    const payloadWithPlanInTitle: SalesPultPayload = {
      ...basePayload,
      groups: [
        {
          id: "sales",
          name: "Отдел продаж",
          managers: [
            {
              id: "1",
              name: "Менеджер",
              active: true,
              rollups: basePayload.groups[0].managers[0].rollups,
              topTasks: [
                {
                  id: "t1",
                  dealId: "d1",
                  title: "[GZ 87699186] Поставка оборудования",
                  planNumber: "87699186",
                  amount: 1000000,
                  deadline: "2026-10-22T10:00:00+05:00",
                  isOverdue: true,
                  rank: 1
                },
                {
                  id: "t2",
                  dealId: "d2",
                  title: "Другая поставка",
                  planNumber: "99999999",
                  amount: 2000000,
                  deadline: "2026-10-22T10:00:00+05:00",
                  isOverdue: true,
                  rank: 2
                }
              ]
            }
          ]
        }
      ]
    };

    const html = renderPultHtml(payloadWithPlanInTitle);

    // For t1: planNumber is in title, so no separate <b>[87699186]</b>
    expect(html).not.toContain("<b>[87699186]</b>");
    expect(html).toContain("[GZ 87699186] Поставка оборудования");

    // For t2: planNumber is not in title, so <b>[99999999]</b> is rendered
    expect(html).toContain("<b>[99999999]</b>");
  });

  it("6. decodes HTML entities in comments before escaping", () => {
    expect(decodeHtmlEntities('работает с &quot;Аданком&quot;')).toBe('работает с "Аданком"');
    expect(decodeHtmlEntities('Цена &lt; 500 &amp; Срок &gt; 10')).toBe('Цена < 500 & Срок > 10');

    const html = renderPultHtml(basePayload);
    // On the rendered page, &quot; is not double-escaped to &amp;quot;
    expect(html).not.toContain("&amp;quot;");
    expect(html).toContain("&quot;Аданком&quot;");
  });

  it("7. formats contract with zero or missing amount as '1 · сумма не указана'", () => {
    const html = renderPultHtml(basePayload);

    // In signals: Nurdaulet has 1 contract with 0 amount
    expect(html).toContain("Нурдаулет — 1 договор · сумма не указана");

    // In table: Nurdaulet's cell
    expect(html).toContain("1 · сумма не указана");
  });

  it("8. does not contain <script id='pult-data'> payload dump", () => {
    const html = renderPultHtml(basePayload);
    expect(html).not.toContain('id="pult-data"');
    expect(html).not.toContain("application/json");
  });

  it("9. respects proposalsTracked: false without reading files via fs", () => {
    const untrackedPayload: SalesPultPayload = {
      ...basePayload,
      proposalsTracked: false
    };
    const html = renderPultHtml(untrackedPayload);

    expect(html).toContain("в CRM пока не отмечают");
    expect(html).toContain("tile-bar-fill gray");
  });

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

    expect(html).toContain("Тендерный отдел");
    expect(html).toContain("<thead><tr><th>Менеджер</th><th>Подписал</th></tr></thead>");

    const tenderParts = html.split('<h2>Тендерный отдел</h2>').slice(1);
    expect(tenderParts.length).toBeGreaterThan(0);

    for (const part of tenderParts) {
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
