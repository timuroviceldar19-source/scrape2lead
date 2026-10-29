import { describe, expect, it } from "vitest";
import {
  buildSignals,
  formatDebtLines,
  formatTaskLine,
  renderPultHtml,
  type PultManagerView,
  type SalesPultPayload
} from "../../src/bitrix/salesPult/site.js";
import { buildMorningReport } from "../../src/bitrix/salesPult/chatReport.js";
import { EMPTY_DEBTS, type ManagerDebts } from "../../src/bitrix/salesPult/debts.js";
import type { ManagerRollups, TopTask } from "../../src/bitrix/salesPult/metrics.js";

const summary = {
  calls: { successful: 15, totalAttempts: 15, durationSeconds: 0, durationMinutes: 0, status: "green" as const },
  proposals: { uniqueDealsCount: 3, dealIds: [], status: "green" as const },
  contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" as const }
};
const rollups: ManagerRollups = {
  managerId: "x", asOfDate: "2026-10-28", day: summary, week: summary, month: summary,
  signals: { zeroBitrixCallsToday: false, zeroKpThreeDays: false }
};

function manager(id: string, name: string, debts?: ManagerDebts, topTasks: TopTask[] = []): PultManagerView {
  return { id, name, active: true, rollups: { ...rollups, managerId: id }, topTasks, debts };
}

function payload(managers: PultManagerView[], tenders: PultManagerView[] = []): SalesPultPayload {
  return {
    asOfDate: "2026-10-28",
    generatedAt: "2026-10-28 11:00 (UTC+5)",
    portal: "https://ft3.bitrix24.kz",
    pultUrl: "https://f3-pult.pages.dev",
    targets: {
      daily: { calls: 15, proposals: 3, contracts: 1 },
      weekly: { calls: 75, proposals: 15, contracts: 5 },
      monthly: { calls: 300, proposals: 60, contracts: 20 }
    },
    callsAvailable: true,
    groups: [
      { id: "sales", name: "Отдел продаж", managers },
      ...(tenders.length ? [{ id: "tenders", name: "Тендерный отдел", managers: tenders }] : [])
    ],
    dynamics: []
  };
}

const debts = (overrides: Partial<ManagerDebts>): ManagerDebts => ({ ...EMPTY_DEBTS, ...overrides });

describe("formatDebtLines", () => {
  it("renders all three lines like the spec", () => {
    const lines = formatDebtLines(debts({
      overdue: 15, overdueOverMonth: 8, newDeals: 25, newOldestAgeDays: 5,
      readyToCloseDealIds: ["1", "2", "3", "4"]
    }));
    expect(lines.map((l) => l.text)).toEqual([
      "просрочено 15 · больше месяца 8",
      "новых без звонка 25 (самой старой 5 дней)",
      "пора закрыть 4"
    ]);
  });

  it("skips empty parts", () => {
    expect(formatDebtLines(debts({ overdue: 3 })).map((l) => l.text)).toEqual(["просрочено 3"]);
    expect(formatDebtLines(debts({ newDeals: 2, newOldestAgeDays: 0 })).map((l) => l.text))
      .toEqual(["новых без звонка 2"]);
    expect(formatDebtLines(debts({ readyToCloseDealIds: ["1"] })).map((l) => l.text)).toEqual(["пора закрыть 1"]);
  });

  it("uses correct plural for days", () => {
    expect(formatDebtLines(debts({ newDeals: 1, newOldestAgeDays: 1 }))[0].text).toContain("1 день");
    expect(formatDebtLines(debts({ newDeals: 1, newOldestAgeDays: 3 }))[0].text).toContain("3 дня");
  });
});

describe("Долги in payload and manager view", () => {
  it("includes debts in the sales manager data and renders correctly", () => {
    const html = renderPultHtml(payload(
      [manager("1", "Нурбол", debts({ overdue: 15, overdueOverMonth: 8 })), manager("2", "Жанат", debts({}))],
      [manager("3", "Тендерщик", debts({ overdue: 9 }))]
    ));
    expect(html).toContain("Нурбол");
    expect(html).toContain('"overdue":15');
    expect(html).toContain('"overdueOverMonth":8');
  });

  it("renders the same debts in payload for all managers", () => {
    const html = renderPultHtml(payload([manager("1", "Нурбол", debts({ overdue: 4 }))]));
    expect(html).toContain('"overdue":4');
  });
});

describe("debt signals", () => {
  it("shows red per-manager signals and one gray «пора закрыть» line", () => {
    const signals = buildSignals(payload([
      manager("1", "Турар", debts({ newStaleDeals: 25, readyToCloseDealIds: ["a", "b", "c"] })),
      manager("2", "Нурбол", debts({ overdueOngoing: 3, readyToCloseDealIds: ["c", "d"] }))
    ]));
    expect(signals).toContainEqual({ color: "red", text: "<b>Турар</b>: 25\u00A0новых сделок без звонка больше суток" });
    expect(signals).toContainEqual({ color: "red", text: "<b>Нурбол</b>: 3\u00A0дела по идущим закупкам просрочено" });
    const gray = signals.filter((s) => s.color === "gray");
    expect(gray).toEqual([{ color: "gray", text: "Пора закрыть 5\u00A0сделок: закупка уже прошла, а сделки ещё в работе" }]);
  });

  it("uses the singular verb form and no debt signals when there is nothing", () => {
    const one = buildSignals(payload([manager("1", "Нурбол", debts({ overdueOngoing: 1 }))]));
    expect(one).toContainEqual({ color: "red", text: "<b>Нурбол</b>: 1\u00A0дело по идущим закупкам просрочено" });

    const none = buildSignals(payload([manager("1", "Нурбол", debts({}))]));
    expect(none).toEqual([{ color: "green", text: "Сегодня без происшествий" }]);
  });

  it("does not signal fresh new deals (only older than a working day)", () => {
    const signals = buildSignals(payload([manager("1", "Турар", debts({ newDeals: 25, newStaleDeals: 0 }))]));
    expect(signals.some((s) => s.text.includes("без звонка"))).toBe(false);
  });
});

describe("«Что сделать сегодня» card", () => {
  const overdueTask: TopTask = {
    id: "1", dealId: "10", title: "Жасыл даму — Ноутбук", subject: "Перезвонить", amount: 74_300_000,
    deadline: "2026-10-27T10:00:00+05:00", isOverdue: true, rank: 1, kind: "overdue", group: 1,
    planStatus: "Опубликован", overdueDays: 1
  };
  const newTask: TopTask = {
    id: "2", dealId: "11", title: "Школа 5 — Панели", subject: "Связаться с клиентом", amount: 5_000_000,
    deadline: "2026-10-21T10:00:00+05:00", isOverdue: false, rank: 4, kind: "new", group: 4, ageDays: 5.4
  };

  it("formats the line as «суть · сделка · сумма · статус»", () => {
    expect(formatTaskLine(overdueTask, "2026-10-28")).toBe(
      "Перезвонить · Жасыл даму — Ноутбук · 74,3 млн ₸ · просрочено на 1 день"
    );
    expect(formatTaskLine(newTask, "2026-10-28")).toBe(
      "Связаться с клиентом · Школа 5 — Панели · 5 млн ₸ · новая, без звонка 5 дней"
    );
  });

  it("renders the subject and task title in the payload", () => {
    const html = renderPultHtml(payload([manager("1", "Нурбол", debts({}), [overdueTask, newTask])]));
    expect(html).toContain("Перезвонить");
    expect(html).toContain("Опубликован");
    expect(html).toContain("Жасыл даму — Ноутбук");
  });
});

describe("morning report", () => {
  const base = { managerId: "1", managerName: "Нурбол", date: "2026-10-28", pultUrl: "https://p", targets: { calls: 15, proposals: 3, contracts: 1 } };
  const overdueTask: TopTask = {
    id: "1", dealId: "10", title: "Ноутбуки", amount: 1_000_000, deadline: "2026-10-27T10:00:00+05:00",
    isOverdue: true, rank: 1, kind: "overdue", group: 1
  };
  const newTask: TopTask = {
    id: "2", dealId: "11", title: "Панели", amount: 1_000_000, deadline: "2026-10-21T10:00:00+05:00",
    isOverdue: false, rank: 4, kind: "new", group: 4, ageDays: 5.4
  };

  it("marks only real overdue, never new deals", () => {
    const text = buildMorningReport({ ...base, tasks: [overdueTask, newTask] });
    const [overdueLine, newLine] = text.split("\n").filter((line) => /^\d\./.test(line));
    expect(overdueLine).toContain("⚠️ (просрочено)");
    expect(newLine).not.toContain("просрочено");
    expect(newLine).toContain("новая, без звонка 5 дн.");
    expect(newLine).not.toContain("[до");
  });
});


describe("stage 2 UI and sorting rules (Req 2, 3, 4, 5)", () => {
  it("does not re-sort tasks by overdueDays in pult.client.js and renders 30+ days list and new tags", () => {
    const taskWithNotes: TopTask = {
      id: "t1",
      dealId: "1001",
      title: "Тестовая поставка А",
      subject: "Перезвонить",
      amount: 5_000_000,
      deadline: "2026-10-27T10:00:00+05:00",
      isOverdue: true,
      rank: 1,
      kind: "overdue",
      group: 2,
      overdueDays: 1,
      planStatus: "Утвержден",
      passedPlanMonthNote: "план на апрель прошёл",
      contactedAfterDeadlineNote: "связался — закрыть дело / поставить следующий шаг"
    };
    const mgrDebts = debts({
      overdue: 2,
      overdueOverMonth: 1,
      overdueOverMonthTasks: [
        {
          id: "old-99",
          dealId: "2002",
          title: "Давняя закупка моноблоков",
          overdueDays: 42,
          amount: 3_200_000,
          deadline: "2026-09-16T10:00:00+05:00"
        }
      ]
    });
    const html = renderPultHtml(payload([manager("1", "ТестМенеджер", mgrDebts, [taskWithNotes])]));
    expect(html).toContain("план на апрель прошёл");
    expect(html).toContain("связался — закрыть дело / поставить следующий шаг");
    expect(html).toContain("Давняя закупка моноблоков");
    expect(html).toContain("old-tasks");
    expect(html).not.toContain("(b.t.overdueDays || 0) - (a.t.overdueDays || 0)");
  });
});
