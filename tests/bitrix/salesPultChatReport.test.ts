import { describe, expect, it } from "vitest";
import {
  buildMorningReport,
  buildEveningReport,
  isReportAlreadySent,
  parseManualReport
} from "../../src/bitrix/salesPult/chatReport.js";
import type { ManagerRollups, TopTask } from "../../src/bitrix/salesPult/metrics.js";

describe("salesPultChatReport", () => {
  const rollups: ManagerRollups = {
    managerId: "147",
    asOfDate: "2026-10-28",
    day: {
      calls: { successful: 13, totalAttempts: 18, durationSeconds: 2520, durationMinutes: 42, status: "yellow" },
      proposals: { uniqueDealsCount: 4, dealIds: ["p1", "p2", "p3", "p4"], status: "green" },
      contracts: { uniqueDealsCount: 2, totalAmount: 3_200_000, dealIds: ["c1", "c2"], status: "green" }
    },
    week: {
      calls: { successful: 38, totalAttempts: 50, durationSeconds: 7200, durationMinutes: 120, status: "yellow" },
      proposals: { uniqueDealsCount: 11, dealIds: [], status: "yellow" },
      contracts: { uniqueDealsCount: 3, totalAmount: 7_500_000, dealIds: [], status: "yellow" }
    },
    month: {
      calls: { successful: 210, totalAttempts: 300, durationSeconds: 36000, durationMinutes: 600, status: "yellow" },
      proposals: { uniqueDealsCount: 42, dealIds: [], status: "yellow" },
      contracts: { uniqueDealsCount: 14, totalAmount: 34_500_000, dealIds: [], status: "yellow" }
    },
    signals: {
      zeroBitrixCallsToday: false,
      zeroKpThreeDays: false
    }
  };

  const tasks: TopTask[] = [
    {
      id: "a1",
      dealId: "101",
      title: "Ноутбуки",
      amount: 4_500_000,
      deadline: "2026-10-28T14:00:00+05:00",
      planNumber: "123456",
      lastComment: "Звонил закупщику, просил перезвонить после обеда",
      isOverdue: false,
      rank: 1
    }
  ];

  it("builds morning message with header marker, targets and top 5 tasks", () => {
    const text = buildMorningReport({
      managerId: "147",
      managerName: "Бахтияр",
      date: "2026-10-28",
      targets: { calls: 15, proposals: 3, contracts: 1 },
      tasks,
      pultUrl: "https://f3-pult.pages.dev"
    });

    expect(text.startsWith("#автоотчёт 2026-10-28 утро 147")).toBe(true);
    expect(text).toContain("Бахтияр");
    expect(text).toContain("Звонки: 15");
    expect(text).toContain("ТС/КП: 3");
    expect(text).toContain("Договоры: 1");
    expect(text).toContain("123456");
    expect(text).toContain("4 500 000");
    expect(text).toContain("Звонил закупщику");
    expect(text).toContain("https://f3-pult.pages.dev");
  });

  it("shows error warning when tasks failed to load instead of claiming no tasks", () => {
    const text = buildMorningReport({
      managerId: "147",
      managerName: "Бахтияр",
      date: "2026-10-28",
      targets: { calls: 15, proposals: 3, contracts: 1 },
      tasks: [],
      pultUrl: "https://f3-pult.pages.dev",
      taskError: "Bitrix API timeout"
    });

    expect(text).toContain("🔥 Топ-5 задач: ⚠️ не удалось загрузить задачи (ошибка API)");
    expect(text).not.toContain("нет открытых задач");
  });

  it("builds evening message with fact of day, week and month and marker", () => {
    const text = buildEveningReport({
      managerId: "147",
      managerName: "Бахтияр",
      rollups,
      targets: {
        daily: { calls: 15, proposals: 3, contracts: 1 },
        weekly: { calls: 75, proposals: 15, contracts: 5 },
        monthly: { calls: 300, proposals: 60, contracts: 20 }
      },
      pultUrl: "https://f3-pult.pages.dev"
    });

    expect(text.startsWith("#автоотчёт 2026-10-28 вечер 147")).toBe(true);
    expect(text).toContain("Бахтияр");
    expect(text).toContain("Звонки: 15/13");
    expect(text).toContain("ТС/КП выставлено: 3/4");
    expect(text).toContain("Договоров заключено: 1/2 — 3 200 000 ₸");
    expect(text).toContain("https://f3-pult.pages.dev");
  });

  it("handles telephony insufficient_scope gracefully in evening message", () => {
    const text = buildEveningReport({
      managerId: "147",
      managerName: "Бахтияр",
      rollups,
      targets: {
        daily: { calls: 15, proposals: 3, contracts: 1 },
        weekly: { calls: 75, proposals: 15, contracts: 5 },
        monthly: { calls: 300, proposals: 60, contracts: 20 }
      },
      pultUrl: "https://f3-pult.pages.dev",
      callsAvailable: false,
      callsError: "insufficient_scope: требуется scope telephony в вебхуке"
    });

    expect(text).toContain("Звонки: нет доступа (требуется scope telephony)");
  });

  it("detects already sent reports in chat messages", () => {
    const messages = [
      { id: 1, text: "Some random discussion" },
      { id: 2, text: "#автоотчёт 2026-10-28 утро 147\nПлан..." }
    ];

    expect(isReportAlreadySent(messages, "2026-10-28", "утро", "147")).toBe(true);
    expect(isReportAlreadySent(messages, "2026-10-28", "вечер", "147")).toBe(false);
    expect(isReportAlreadySent(messages, "2026-10-28", "утро", "205")).toBe(false);
  });

  it("parses real manual reports from managers with varied formatting", () => {
    const reportKaiyrzhan = `2ү/10/2026
Менеджер: Кайыржан

Ежедневный план: 750 000 / [0]
Звонки: 15/0
ТС/КП выставлено: 3/0
Договоров заключено: 0

Еженедельный план: 3 750 000 / [0]
Звонки: 75/16
ТС/КП выставлено: 15/0
Договоров заключено: 4/0

Ежемесячный план: 15 000 000 / [0]
Звонки: 300/150
ТС/КП выставлено: 60/29
Договоров заключено: 16/0`;

    const parsedK = parseManualReport(reportKaiyrzhan);
    expect(parsedK.managerName).toBe("Кайыржан");
    expect(parsedK.month.callsFact).toBe(150);
    expect(parsedK.month.proposalsFact).toBe(29);
    expect(parsedK.month.contractsFact).toBe(0);
    expect(parsedK.month.amountFact).toBe(0);

    const reportBekzat = `27.10.2026
Менеджер: Бекзат

Ежедневный отчет: 1 500 000 / [10 027 867]
Звонки: 15/15
ТС/КП выставлено: 3/7
Договоров заключено: (6)

Еженедельный отчет: 7 500 000 / [0]
Звонки: 75/15
ТС/КП выставлено: 15/7
Договоров заключено: 4/6

Ежемесячный план: 30 000 000 / [35 224 582]
Звонки: 300/152
ТС/КП выставлено: 60/48
Договоров заключено: 16/17`;

    const parsedB = parseManualReport(reportBekzat);
    expect(parsedB.managerName).toBe("Бекзат");
    expect(parsedB.date).toBe("2026-10-27");
    expect(parsedB.day.contractsFact).toBe(6);
    expect(parsedB.day.amountFact).toBe(10_027_867);
    expect(parsedB.month.callsFact).toBe(152);
    expect(parsedB.month.proposalsFact).toBe(48);
    expect(parsedB.month.contractsFact).toBe(17);
    expect(parsedB.month.amountFact).toBe(35_224_582);

    const reportElmira = `28.10.2026 ЭЛЬМИРА
Ежедневный план: 2 500 000 / [0]
Просчетов: 10/0
Подач: 5/0
Договоров заключено: 1/0

Ежемесячный план за период с 01.10.2026 по 31.10.2026: 30 000 000/ [86 271 438]
Просчетов: 200/127
Подач: 100/84
Договоров заключено: 20/31`;

    const parsedE = parseManualReport(reportElmira);
    expect(parsedE.managerName).toBe("ЭЛЬМИРА");
    expect(parsedE.date).toBe("2026-10-28");
    expect(parsedE.month.contractsFact).toBe(31);
    expect(parsedE.month.amountFact).toBe(86_271_438);

    const reportZhanat = `Менеджер: Жанат
23.10.2026

Ежемесячный план: 30 000 000 / [9 785 517,22]
Звонки: 300/122
ТС/КП выставлено: 60/42
Договоров заключено: 16/7`;

    const parsedZ = parseManualReport(reportZhanat);
    expect(parsedZ.managerName).toBe("Жанат");
    expect(parsedZ.date).toBe("2026-10-23");
    expect(parsedZ.month.contractsFact).toBe(7);
    expect(parsedZ.month.amountFact).toBe(9_785_517.22);
  });
  it("shows date in deadline tag when task deadline is not today [до 23.10 10:00]", () => {
    const text = buildMorningReport({
      managerId: "147",
      managerName: "Бахтияр",
      date: "2026-10-28",
      targets: { calls: 15, proposals: 3, contracts: 1 },
      tasks: [
        {
          id: "t1",
          dealId: "101",
          title: "Ноутбуки",
          amount: 4_500_000,
          deadline: "2026-10-23T08:00:00+03:00",
          planNumber: "123456",
          isOverdue: true,
          rank: 0
        },
        {
          id: "t2",
          dealId: "102",
          title: "Интерактивная панель",
          amount: 2_000_000,
          deadline: "2026-10-28T08:00:00+03:00",
          planNumber: "654321",
          isOverdue: false,
          rank: 1
        }
      ],
      pultUrl: "https://f3-pult.pages.dev"
    });

    expect(text).toContain("[до 23.10 10:00]");
    expect(text).toContain("[до 10:00]");
  });

  it("preserves Kazakh characters like Қ and ғ in morning report titles without corruption", () => {
    const title = 'Ясли-сад № 43 "Қызғалдақ"';
    const text = buildMorningReport({
      managerId: "147",
      managerName: "Бахтияр",
      date: "2026-10-28",
      targets: { calls: 15, proposals: 3, contracts: 1 },
      tasks: [
        {
          id: "t1",
          dealId: "101",
          title,
          amount: 1_200_000,
          deadline: "2026-10-28T10:00:00+05:00",
          planNumber: "88399123",
          lastComment: "Қызғалдақ балабақшасымен хабарластым",
          isOverdue: false,
          rank: 1
        }
      ],
      pultUrl: "https://f3-pult.pages.dev"
    });

    expect(text).toContain('Ясли-сад № 43 "Қызғалдақ"');
    expect(text).toContain("Қ");
    expect(text).toContain("ғ");
    expect(text).toContain("Қызғалдақ балабақшасымен хабарластым");
    expect(text).not.toContain("?");
  });
});
