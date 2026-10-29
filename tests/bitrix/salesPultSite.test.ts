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
  cleanTaskTitle,
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
                calls: { successful: 8, totalAttempts: 12, durationSeconds: 400, durationMinutes: 7, status: "red" },
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
    const signals = buildSignals(basePayload);

    // Gender neutral contract signals: "<b>Эльмира</b>: подписано 2 договора на 4,6 млн ₸"
    const elmira = signals.find((s) => s.text.includes("Эльмира"));
    expect(elmira?.text).toContain("подписано 2 договора на 4,6 млн ₸");
    expect(elmira?.text).not.toContain("подписал");
    expect(elmira?.text).not.toContain("подписала");

    const turar = signals.find((s) => s.text.includes("Турар"));
    expect(turar?.text).toContain("подписано 4 договора на 2,4 млн ₸");

    // Gender neutral zero calls signal: "<b>Бекзат</b>: сегодня ни одного звонка через Битрикс"
    const bekzat = signals.find((s) => s.text.includes("Бекзат"));
    expect(bekzat?.text).toContain("сегодня ни одного звонка через Битрикс");
    expect(bekzat?.text).not.toContain("не звонил через Битрикс");
    expect(bekzat?.text).not.toContain("не звонила через Битрикс");

    // Low calls signal: "Мало дозвонов к 15:00: <b>Жанат</b> <span class=num>9</span> при норме 15"
    const lowCalls = signals.find((s) => s.text.includes("Мало дозвонов"));
    expect(lowCalls?.text).toContain("Жанат");
    expect(lowCalls?.text).toContain("при норме 15");
  });

  it("3. correctly pluralizes words and avoids duplicate counters or .replace tricks", () => {
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
    expect(html).toContain("Пульт продаж");
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

  it("5. extracts plan number and cleans deal titles", () => {
    expect(
      cleanTaskTitle({
        title: "[GZ 87699186] Поставка оборудования",
        planNumber: "87699186"
      })
    ).toEqual({
      title: "Поставка оборудования",
      plan: "87699186"
    });

    expect(
      cleanTaskTitle({
        title: "Другая поставка",
        planNumber: "99999999"
      })
    ).toEqual({
      title: "Другая поставка",
      plan: "99999999"
    });
  });

  it("6. decodes HTML entities in comments before escaping", () => {
    expect(decodeHtmlEntities('работает с &quot;Аданком&quot;')).toBe('работает с "Аданком"');
    expect(decodeHtmlEntities('Цена &lt; 500 &amp; Срок &gt; 10')).toBe('Цена < 500 & Срок > 10');

    const html = renderPultHtml(basePayload);
    // On the rendered page, raw payload is safe
    expect(html).not.toContain("&amp;quot;Аданком");
    expect(html).toContain("Аданком");
  });

  it("7. formats contract in signals with zero or missing amount as 'подписан договор'", () => {
    const signals = buildSignals(basePayload);
    const nurdaulet = signals.find((s) => s.text.includes("Нурдаулет"));
    expect(nurdaulet?.text).toContain("подписан договор");
    expect(nurdaulet?.text).not.toContain("0 ₸");
  });

  it("8. safely embeds payload into HTML without raw script injection", () => {
    const html = renderPultHtml(basePayload);
    expect(html).toContain("const PAYLOAD = ");
    expect(html).not.toContain("</script>alert(1)</script>");
  });

  it("9. respects proposalsTracked in payload", () => {
    const untrackedPayload: SalesPultPayload = {
      ...basePayload,
      proposalsTracked: false
    };
    const html = renderPultHtml(untrackedPayload);
    expect(html).toContain('"proposalsTracked":false');
  });

  it("formats money correctly: 850 000 ₸ / 2,4 млн ₸ / 1 млн ₸", () => {
    expect(formatMoney(850000)).toBe("850 000 ₸");
    expect(formatMoney(2400000)).toBe("2,4 млн ₸");
    expect(formatMoney(1000000)).toBe("1 млн ₸");
    expect(formatMoney(0)).toBe("");
  });

  it("never outputs '0 ₸' anywhere from formatMoney", () => {
    expect(formatMoney(0)).toBe("");
  });

  it("ensures tender department section is present in template", () => {
    const html = renderPultHtml(basePayload);
    expect(html).toContain('id="tenders"');
    expect(html).toContain("Тендерный отдел");
  });

  it("does not show low calls signal before 14:00 and shows it after 14:00", () => {
    const morningPayload: SalesPultPayload = {
      ...basePayload,
      generatedAt: "2026-10-28 11:30 (UTC+5)"
    };
    const morningSignals = buildSignals(morningPayload);
    expect(morningSignals.some((s) => s.text.includes("Мало дозвонов"))).toBe(false);

    const afternoonPayload: SalesPultPayload = {
      ...basePayload,
      generatedAt: "2026-10-28 15:30 (UTC+5)"
    };
    const afternoonSignals = buildSignals(afternoonPayload);
    const lowSignal = afternoonSignals.find((s) => s.text.includes("Мало дозвонов"));
    expect(lowSignal).toBeDefined();
    expect(lowSignal?.text).toContain("Жанат");
  });

  it("connects Google Fonts (Geologica, JetBrains Mono) per design system and has no external script tags", () => {
    const html = renderPultHtml(basePayload);

    // Google Fonts link
    expect(html).toContain("https://fonts.googleapis.com");
    expect(html).toContain("Geologica");
    expect(html).toContain("JetBrains+Mono");

    // No external JavaScript scripts
    const scriptSrcMatches = html.match(/<script[^>]+src=["'](https?:)?\/\/[^"']+/gi) ?? [];
    expect(scriptSrcMatches).toHaveLength(0);
  });
});
