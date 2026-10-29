import { formatDebtLines } from "../../src/bitrix/salesPult/format.js";
import { EMPTY_DEBTS } from "../../src/bitrix/salesPult/debts.js";
import { describe, expect, it, vi } from "vitest";
import { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import { collectPultData } from "../../src/bitrix/salesPult/collect.js";
import {
  buildManagerDebts,
  classifyTodo,
  formatResponsibleNote,
  isOpenDebtDeal,
  workingAgeDays,
  type DebtCandidate
} from "../../src/bitrix/salesPult/debts.js";

const NOW = "2026-10-28T19:40:00+05:00"; // Wednesday
const HOLIDAYS = ["2026-10-25"];

function todo(overrides: Partial<DebtCandidate> & { id: string }): DebtCandidate {
  return {
    dealId: `deal-${overrides.id}`,
    title: `Сделка ${overrides.id}`,
    subject: "Перезвонить",
    deadline: "2026-10-28T12:00:00+05:00",
    created: "2026-10-20T09:00:00+05:00",
    amount: 1_000_000,
    categoryId: 9,
    stageId: "C9:UC_KQEL1P",
    planStatus: null,
    ...overrides
  };
}

const context = { nowIso: NOW, holidays: HOLIDAYS };

describe("classifyTodo", () => {
  it("treats deadline == created as a new deal, not an overdue debt", () => {
    const result = classifyTodo(
      todo({ id: "1", created: "2026-10-28T10:00:00+05:00", deadline: "2026-10-28T10:00:00+05:00" }),
      context
    );
    expect(result?.kind).toBe("new");
  });

  it("uses a 5 minute window for new activities", () => {
    const base = { created: "2026-10-27T10:00:00+05:00" };
    expect(classifyTodo(todo({ id: "a", ...base, deadline: "2026-10-27T10:04:00+05:00" }), context)?.kind).toBe("new");
    expect(classifyTodo(todo({ id: "b", ...base, deadline: "2026-10-27T10:06:00+05:00" }), context)?.kind).toBe("overdue");
  });

  it("puts finished procurements into «passed» regardless of deadline, case-insensitive", () => {
    for (const status of [
      "Проект договора", "договор действует", "Закупка состоялась", "Договор заключен", "ИСПОЛНЕН",
      "Отказ от закупки", "Отменен", "Договор изменен", "Договор частично исполнен", "Договор не исполнен. Нет платежей"
    ]) {
      expect(classifyTodo(todo({ id: "p", planStatus: status, deadline: "2026-10-01T10:00:00+05:00" }), context)?.kind)
        .toBe("passed");
    }
    const newOnPassed = todo({
      id: "n", planStatus: "Проект договора",
      created: "2026-10-28T10:00:00+05:00", deadline: "2026-10-28T10:00:00+05:00"
    });
    expect(classifyTodo(newOnPassed, context)?.kind).toBe("passed");
  });

  it("classifies a past deadline as overdue and counts calendar days", () => {
    const result = classifyTodo(todo({ id: "o", deadline: "2026-10-27T12:00:00+05:00" }), context);
    expect(result).toMatchObject({ kind: "overdue", overdueDays: 1 });
  });

  it("classifies a deadline later today as «today»", () => {
    expect(classifyTodo(todo({ id: "t", deadline: "2026-10-28T21:00:00+05:00" }), context)?.kind).toBe("today");
  });

  it("ignores activities without a deadline and with a future deadline", () => {
    expect(classifyTodo(todo({ id: "x", deadline: "" }), context)).toBeNull();
    expect(classifyTodo(todo({ id: "y", deadline: "2026-10-30T10:00:00+05:00" }), context)).toBeNull();
  });
});

describe("workingAgeDays", () => {
  const at = (iso: string) => Date.parse(iso);

  it("does not count weekends: Friday 10:00 → Tuesday 10:00 is two working days", () => {
    expect(workingAgeDays(at("2026-10-23T10:00:00+05:00"), at("2026-10-27T10:00:00+05:00"), [])).toBeCloseTo(2, 5);
  });

  it("does not count holidays", () => {
    const age = workingAgeDays(at("2026-10-23T10:00:00+05:00"), at("2026-10-27T10:00:00+05:00"), ["2026-10-26"]);
    expect(age).toBeCloseTo(1, 5);
  });

  it("counts Friday evening → Monday morning as less than one working day", () => {
    expect(workingAgeDays(at("2026-10-23T18:00:00+05:00"), at("2026-10-26T09:00:00+05:00"), [])).toBeLessThan(1);
  });

  it("is zero for the same moment or reversed range", () => {
    expect(workingAgeDays(at("2026-10-28T10:00:00+05:00"), at("2026-10-28T10:00:00+05:00"), [])).toBe(0);
    expect(workingAgeDays(at("2026-10-28T11:00:00+05:00"), at("2026-10-28T10:00:00+05:00"), [])).toBe(0);
  });
});

describe("buildManagerDebts", () => {
  it("counts 25 new deals without a call and flags those older than one working day", () => {
    const fresh = Array.from({ length: 20 }, (_, i) =>
      todo({ id: `f${i}`, created: "2026-10-28T10:00:00+05:00", deadline: "2026-10-28T10:00:00+05:00" }));
    const stale = Array.from({ length: 5 }, (_, i) =>
      todo({ id: `s${i}`, created: "2026-10-21T10:00:00+05:00", deadline: "2026-10-21T10:00:00+05:00" }));

    const { debts } = buildManagerDebts([...fresh, ...stale], context);

    expect(debts).toMatchObject({ newDeals: 25, newStaleDeals: 5, overdue: 0 });
    expect(debts.newOldestAgeDays).toBe(5); // 21.10 (Wed) → 28.10 (Wed) minus the weekend = 5.x working days
  });

  it("counts 45-day overdue in totals and «больше месяца», but keeps it out of the top", () => {
    const { debts, top } = buildManagerDebts(
      [
        todo({ id: "old", deadline: "2026-09-13T10:00:00+05:00", amount: 90_000_000 }),
        todo({ id: "recent", deadline: "2026-10-26T10:00:00+05:00", amount: 1_000_000 })
      ],
      context
    );
    expect(debts).toMatchObject({ overdue: 2, overdueOverMonth: 1 });
    expect(top.map((t) => t.id)).toEqual(["recent"]);
  });

  it("counts «пора закрыть» by deal, never as a debt, and excludes it from the top", () => {
    const { debts, top } = buildManagerDebts(
      [
        todo({ id: "1", dealId: "D1", planStatus: "Проект договора", deadline: "2026-10-20T10:00:00+05:00" }),
        todo({ id: "2", dealId: "D1", planStatus: "Проект договора", deadline: "2026-10-21T10:00:00+05:00" }),
        todo({ id: "3", dealId: "D2", planStatus: "Договор действует" })
      ],
      context
    );
    expect(debts.readyToCloseDealIds.sort()).toEqual(["D1", "D2"]);
    expect(debts.overdue).toBe(0);
    expect(top).toEqual([]);
  });

  it("counts overdue activities on ongoing procurements separately", () => {
    const { debts } = buildManagerDebts(
      [
        todo({ id: "1", planStatus: "Опубликован", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "2", planStatus: "Заявка", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "3", planStatus: "Проект заявки", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "4", planStatus: "Утвержден", deadline: "2026-10-27T10:00:00+05:00" })
      ],
      context
    );
    expect(debts).toMatchObject({ overdue: 4, overdueOngoing: 3 });
  });

  it("orders the top: ongoing overdue, other overdue, today, stale new; by amount inside a group", () => {
    const { top } = buildManagerDebts(
      [
        todo({ id: "new", amount: 99_000_000, created: "2026-10-21T10:00:00+05:00", deadline: "2026-10-21T10:00:00+05:00" }),
        todo({ id: "today-small", amount: 1_000_000, deadline: "2026-10-28T21:00:00+05:00" }),
        todo({ id: "today-big", amount: 5_000_000, deadline: "2026-10-28T22:00:00+05:00" }),
        todo({ id: "overdue-plain", amount: 7_000_000, deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "overdue-ongoing-small", amount: 100_000, planStatus: "Опубликован", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "overdue-ongoing-big", amount: 3_000_000, planStatus: "Заявка", deadline: "2026-10-26T10:00:00+05:00" })
      ],
      context
    );
    expect(top.map((t) => t.id)).toEqual([
      "overdue-ongoing-big", "overdue-ongoing-small", "overdue-plain", "today-big", "today-small"
    ]);
    expect(top.map((t) => t.group)).toEqual([1, 1, 2, 3, 3]);
  });

  it("puts a stale new deal in the top only after everything else, and skips fresh new ones", () => {
    const { top } = buildManagerDebts(
      [
        todo({ id: "stale", created: "2026-10-21T10:00:00+05:00", deadline: "2026-10-21T10:00:00+05:00" }),
        todo({ id: "fresh", created: "2026-10-28T10:00:00+05:00", deadline: "2026-10-28T10:00:00+05:00" })
      ],
      context
    );
    expect(top.map((t) => t.id)).toEqual(["stale"]);
    expect(top[0]).toMatchObject({ kind: "new", isOverdue: false, group: 4 });
  });

  it("returns at most 5 tasks and one per deal", () => {
    const many = Array.from({ length: 8 }, (_, i) => todo({ id: `m${i}`, deadline: "2026-10-27T10:00:00+05:00", amount: i }));
    const duplicate = todo({ id: "dup", dealId: "deal-m7", deadline: "2026-10-20T10:00:00+05:00" });
    const { top } = buildManagerDebts([...many, duplicate], context);
    expect(top).toHaveLength(5);
    expect(new Set(top.map((t) => t.dealId)).size).toBe(5);
  });

  it("keeps the most urgent activity when a deal has several", () => {
    const { top } = buildManagerDebts(
      [
        todo({ id: "today", dealId: "D", deadline: "2026-10-28T22:00:00+05:00" }),
        todo({ id: "overdue", dealId: "D", deadline: "2026-10-27T10:00:00+05:00" })
      ],
      context
    );
    expect(top.map((t) => t.id)).toEqual(["overdue"]);
  });

  it("ignores closed deals and other pipelines", () => {
    const { debts, top } = buildManagerDebts(
      [
        todo({ id: "won", stageId: "C9:WON", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "lose", categoryId: 41, stageId: "C41:LOSE", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "other", categoryId: 1, stageId: "NEW", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "closed-flag", categoryId: 9, stageId: "C9:9", closed: "Y", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "closed-semantic", categoryId: 9, stageId: "C9:9", stageSemanticId: "F", deadline: "2026-10-27T10:00:00+05:00" }),
        todo({ id: "ok", categoryId: 43, stageId: "C43:EXECUTING", deadline: "2026-10-27T10:00:00+05:00" })
      ],
      context
    );
    expect(debts.overdue).toBe(1);
    expect(top.map((t) => t.id)).toEqual(["ok"]);
  });
});

describe("isOpenDebtDeal", () => {
  it("treats deals with CLOSED=Y, closed=true or CLOSED=1 as closed regardless of stageId", () => {
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:9", closed: "Y" })).toBe(false);
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:9", closed: true })).toBe(false);
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:9", closed: "1" })).toBe(false);
  });

  it("treats deals with STAGE_SEMANTIC_ID=F (failed) or S (success) as closed", () => {
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:9", stageSemanticId: "F" })).toBe(false);
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:9", stageSemanticId: "S" })).toBe(false);
  });

  it("treats deals with STAGE_SEMANTIC_ID=P and CLOSED=N in allowed pipeline as open", () => {
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:UC_KQEL1P", closed: "N", stageSemanticId: "P" })).toBe(true);
  });

  it("falls back to stageId pattern if closed and stageSemanticId are missing", () => {
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:WON" })).toBe(false);
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:LOSE" })).toBe(false);
    expect(isOpenDebtDeal({ categoryId: 9, stageId: "C9:APOLOGY" })).toBe(false);
  });
});

describe("formatResponsibleNote", () => {
  it("declines manager names into prepositional case «дело на <имя>»", () => {
    expect(formatResponsibleNote("Жанат")).toBe("дело на Жанате");
    expect(formatResponsibleNote("Жанат Какимжанов")).toBe("дело на Жанате");
    expect(formatResponsibleNote("Турар")).toBe("дело на Тураре");
    expect(formatResponsibleNote("Бахтияр")).toBe("дело на Бахтияре");
    expect(formatResponsibleNote("Бекзат")).toBe("дело на Бекзате");
    expect(formatResponsibleNote("Нурбол")).toBe("дело на Нурболе");
    expect(formatResponsibleNote("Кайыржан")).toBe("дело на Кайыржане");
    expect(formatResponsibleNote("Нурдаулет")).toBe("дело на Нурдаулете");
    expect(formatResponsibleNote("Эльмира")).toBe("дело на Эльмире");
    expect(formatResponsibleNote("Динара")).toBe("дело на Динаре");
  });
});

describe("collectPultData debts", () => {
  it("excludes tasks and calls, reads plan status from the deal field and exposes debts", async () => {
    const activities = [
      { ID: "1", OWNER_ID: "10", OWNER_TYPE_ID: "2", SUBJECT: "Перезвонить", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "2026-10-27T10:00:00+05:00", PROVIDER_ID: "CRM_TODO" },
      { ID: "2", OWNER_ID: "11", OWNER_TYPE_ID: "2", SUBJECT: "Задача", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "2026-10-27T10:00:00+05:00", PROVIDER_ID: "CRM_TASKS_TASK" },
      { ID: "3", OWNER_ID: "12", OWNER_TYPE_ID: "2", SUBJECT: "Звонок", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "2026-10-27T10:00:00+05:00", PROVIDER_ID: "VOXIMPLANT_CALL" },
      { ID: "4", OWNER_ID: "13", OWNER_TYPE_ID: "2", SUBJECT: "Связаться с клиентом", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "", PROVIDER_ID: "CRM_TODO" },
      { ID: "5", OWNER_ID: "14", OWNER_TYPE_ID: "2", SUBJECT: "Связаться с клиентом", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "2026-10-27T10:00:00+05:00", PROVIDER_ID: "CRM_TODO" }
    ];
    const deals = ["10", "11", "12", "13", "14"].map((id) => ({
      ID: id, TITLE: `Deal ${id}`, OPPORTUNITY: "1000", ASSIGNED_BY_ID: "147", CATEGORY_ID: "9",
      STAGE_ID: "C9:UC_KQEL1P", UF_CRM_PLAN_STATUS: id === "14" ? "Проект договора" : "Опубликован"
    }));
    const call = vi.fn(async (method: string, body: any) => {
      if (method === "batch") {
        const first = Object.values(body?.cmd ?? {})[0] as string;
        return { result: first?.startsWith("crm.activity.list") ? { p0: activities } : {}, result_error: {} };
      }
      if (method === "crm.deal.list") return deals.filter((d) => (body.filter.ID as string[]).includes(d.ID));
      return [];
    });

    const data = await collectPultData({
      client: new ReadOnlyBitrixClient({ call }),
      fromDate: "2026-10-01",
      toDate: "2026-10-28",
      managerIds: ["147"],
      proposalStages: [],
      contractStages: [],
      nowIso: NOW,
      holidays: HOLIDAYS
    });

    const debts = data.debtsByManager.get("147");
    expect(debts?.overdue).toBe(1);
    expect(debts?.readyToCloseDealIds).toEqual(["14"]);
    const top = data.tasksByManager.get("147") ?? [];
    expect(top.map((t) => t.dealId)).toEqual(["10"]);
    expect(top[0]).toMatchObject({ subject: "Перезвонить", planStatus: "Опубликован", group: 1 });
  });
});

describe("formatDebtLines wonOnPortalNotClosed", () => {
  it("formats wonOnPortalNotClosed with proper Russian declensions in red", () => {
    expect(formatDebtLines({ ...EMPTY_DEBTS, wonOnPortalNotClosed: 1 })).toContainEqual({
      color: "red",
      text: "выиграно на портале, не закрыто в CRM: 1 сделка"
    });
    expect(formatDebtLines({ ...EMPTY_DEBTS, wonOnPortalNotClosed: 3 })).toContainEqual({
      color: "red",
      text: "выиграно на портале, не закрыто в CRM: 3 сделки"
    });
    expect(formatDebtLines({ ...EMPTY_DEBTS, wonOnPortalNotClosed: 5 })).toContainEqual({
      color: "red",
      text: "выиграно на портале, не закрыто в CRM: 5 сделок"
    });
  });
});


describe("procurement outcomes in debts (Req 1)", () => {
  it("classifies terminal outcomes (lost, failed, cancelled, repurposed, terminated) as passed", () => {
    for (const outcome of [
      "lost:100/200",
      "failed:закупка не состоялась",
      "cancelled:отменено",
      "repurposed:плинтус",
      "terminated:100/200"
    ]) {
      const res = classifyTodo(
        todo({ id: `term-${outcome}`, outcome, planStatus: "Опубликован", deadline: "2026-10-20T10:00:00+05:00" }),
        context
      );
      expect(res?.kind).toBe("passed");
    }
  });

  it("keeps ongoing and winning outcomes (won, partner, published, contract-draft, plan-renumbered, plan-moved) unchanged", () => {
    for (const outcome of [
      "won:100/200",
      "partner:100/200",
      "published:опубликован",
      "contract-draft:проект договора",
      "plan-renumbered:999",
      "plan-moved:888"
    ]) {
      const res = classifyTodo(
        todo({ id: `keep-${outcome}`, outcome, planStatus: "Опубликован", deadline: "2026-10-20T10:00:00+05:00" }),
        context
      );
      expect(res?.kind).toBe("overdue");
    }
  });

  it("moves terminal-outcome deals to readyToCloseDealIds and excludes them from overdue, newDeals, and top", () => {
    const { debts, top } = buildManagerDebts(
      [
        todo({ id: "t-lost", dealId: "D-LOST", outcome: "lost:111/222", planStatus: "Опубликован", deadline: "2026-10-25T10:00:00+05:00", amount: 10_000_000 }),
        todo({ id: "t-canc", dealId: "D-CANC", outcome: "cancelled:отказ", planStatus: "Утвержден", created: "2026-10-28T10:00:00+05:00", deadline: "2026-10-28T10:00:00+05:00" }),
        todo({ id: "t-repurp", dealId: "D-REP", outcome: "repurposed:бумага", planStatus: "Утвержден", deadline: "2026-10-25T10:00:00+05:00", amount: 20_000_000 }),
        todo({ id: "t-pub", dealId: "D-PUB", outcome: "published:опубликован", planStatus: "Опубликован", deadline: "2026-10-25T10:00:00+05:00", amount: 2_000_000 })
      ],
      context
    );
    expect(debts.readyToCloseDealIds.sort()).toEqual(["D-CANC", "D-LOST", "D-REP"]);
    expect(debts.overdue).toBe(1);
    expect(debts.newDeals).toBe(0);
    expect(top.map((t) => t.id)).toEqual(["t-pub"]);
  });
});

describe("passed plan month for Утвержден (Req 2)", () => {
  it("attaches «план на <месяц> прошёл» for Утвержден with a past month and sorts after current/future months within group", () => {
    const { top } = buildManagerDebts(
      [
        todo({ id: "apr-big", planStatus: "Утвержден", planMonth: "Апрель", amount: 50_000_000, deadline: "2026-10-25T10:00:00+05:00" }),
        todo({ id: "oct-small", planStatus: "Утвержден", planMonth: "Октябрь", amount: 1_000_000, deadline: "2026-10-25T10:00:00+05:00" }),
        todo({ id: "nov-mid", planStatus: "Утвержден", planMonth: "Ноябрь", amount: 3_000_000, deadline: "2026-10-25T10:00:00+05:00" }),
        todo({ id: "sep-mid", planStatus: "Утвержден", planMonth: "Сентябрь", amount: 10_000_000, deadline: "2026-10-25T10:00:00+05:00" })
      ],
      context
    );
    expect(top.map((t) => t.id)).toEqual(["nov-mid", "oct-small", "apr-big", "sep-mid"]);
    expect(top[0].passedPlanMonthNote).toBeNull();
    expect(top[1].passedPlanMonthNote).toBeNull();
    expect(top[2].passedPlanMonthNote).toBe("план на апрель прошёл");
    expect(top[3].passedPlanMonthNote).toBe("план на сентябрь прошёл");
  });

  it("ignores empty or unrecognized planMonth and non-Утвержден statuses", () => {
    const { top } = buildManagerDebts(
      [
        todo({ id: "empty", planStatus: "Утвержден", planMonth: "", deadline: "2026-10-25T10:00:00+05:00" }),
        todo({ id: "unknown", planStatus: "Утвержден", planMonth: "3 квартал", deadline: "2026-10-25T10:00:00+05:00" }),
        todo({ id: "pub-apr", planStatus: "Опубликован", planMonth: "Апрель", deadline: "2026-10-25T10:00:00+05:00" })
      ],
      context
    );
    expect(top.every((t) => !t.passedPlanMonthNote)).toBe(true);
  });

  it("handles year rollover: in January, planMonth «Декабрь» is treated as passed while «Январь» and «Февраль» are not", () => {
    const janContext = { nowIso: "2027-01-15T12:00:00+05:00", holidays: [] };
    const { top } = buildManagerDebts(
      [
        todo({ id: "dec-plan", planStatus: "Утвержден", planMonth: "Декабрь", dealCreated: "2026-12-20T09:00:00+05:00", amount: 20_000_000, created: "2026-12-20T09:00:00+05:00", deadline: "2027-01-10T10:00:00+05:00" }),
        todo({ id: "jan-plan", planStatus: "Утвержден", planMonth: "Январь", dealCreated: "2027-01-05T09:00:00+05:00", amount: 2_000_000, created: "2027-01-05T09:00:00+05:00", deadline: "2027-01-10T10:00:00+05:00" }),
        todo({ id: "feb-plan", planStatus: "Утвержден", planMonth: "Февраль", dealCreated: "2027-01-05T09:00:00+05:00", amount: 1_000_000, created: "2027-01-05T09:00:00+05:00", deadline: "2027-01-10T10:00:00+05:00" })
      ],
      janContext
    );
    expect(top.map((t) => t.id)).toEqual(["jan-plan", "feb-plan", "dec-plan"]);
    expect(top[0].passedPlanMonthNote).toBeNull();
    expect(top[1].passedPlanMonthNote).toBeNull();
    expect(top[2].passedPlanMonthNote).toBe("план на декабрь прошёл");
  });
});

describe("overdue over 30 days list and contacted after deadline note (Req 4 & 5)", () => {
  it("populates overdueOverMonthTasks sorted by amount desc for tasks older than 30 days, separate from top", () => {
    const { debts, top } = buildManagerDebts(
      [
        todo({ id: "old-1", dealId: "D-OLD-1", title: "Старая сделка 1", deadline: "2026-09-10T10:00:00+05:00", amount: 2_000_000 }),
        todo({ id: "old-2", dealId: "D-OLD-2", title: "Старая сделка 2", deadline: "2026-09-01T10:00:00+05:00", amount: 8_000_000 }),
        todo({ id: "fresh-1", dealId: "D-FRESH", title: "Свежая сделка", deadline: "2026-10-25T10:00:00+05:00", amount: 1_500_000 })
      ],
      context
    );
    expect(debts.overdueOverMonth).toBe(2);
    expect(debts.overdueOverMonthTasks?.map((t) => t.id)).toEqual(["old-2", "old-1"]);
    expect(debts.overdueOverMonthTasks?.[0]).toMatchObject({
      dealId: "D-OLD-2",
      title: "Старая сделка 2",
      amount: 8_000_000,
      overdueDays: 57
    });
    expect(top.map((t) => t.id)).toEqual(["fresh-1"]);
  });

  it("attaches «связался — закрыть дело / поставить следующий шаг» to overdue tasks with contact after deadline", () => {
    const { top } = buildManagerDebts(
      [
        todo({ id: "contacted", deadline: "2026-10-25T10:00:00+05:00", hasContactAfterDeadline: true }),
        todo({ id: "not-contacted", deadline: "2026-10-25T10:00:00+05:00", hasContactAfterDeadline: false }),
        todo({ id: "today-contacted", deadline: "2026-10-28T21:00:00+05:00", hasContactAfterDeadline: true })
      ],
      context
    );
    const byId = new Map(top.map((t) => [t.id, t]));
    expect(byId.get("contacted")?.contactedAfterDeadlineNote).toBe(
      "связался — закрыть дело / поставить следующий шаг"
    );
    expect(byId.get("not-contacted")?.contactedAfterDeadlineNote).toBeNull();
    expect(byId.get("today-contacted")?.contactedAfterDeadlineNote).toBeNull();
  });
});

describe("passed plan month uses the year the deal was created in", () => {
  const FIVE_DAYS_MS = 5 * 86_400_000;
  const noteOf = (nowIso: string, planMonth: string, dealCreated: string) => {
    const deadline = new Date(Date.parse(nowIso) - FIVE_DAYS_MS).toISOString();
    const task = todo({ id: "x", planStatus: "Утвержден", planMonth, dealCreated, deadline });
    return buildManagerDebts([task], { nowIso, holidays: [] }).top[0]?.passedPlanMonthNote ?? null;
  };

  it("marks «Ноябрь» of the previous year as passed in January", () => {
    expect(noteOf("2027-01-15T12:00:00+05:00", "Ноябрь", "2026-11-03T09:00:00+05:00")).toBe("план на ноябрь прошёл");
  });

  it("keeps marking «Декабрь» of the previous year as passed in February", () => {
    expect(noteOf("2027-02-10T12:00:00+05:00", "Декабрь", "2026-12-20T09:00:00+05:00")).toBe("план на декабрь прошёл");
  });

  it("does not mark «Декабрь» of the current year in October", () => {
    expect(noteOf("2026-10-28T12:00:00+05:00", "Декабрь", "2026-09-01T09:00:00+05:00")).toBeNull();
  });

  it("does not mark the current month of the creation year", () => {
    expect(noteOf("2026-10-28T12:00:00+05:00", "Октябрь", "2026-10-02T09:00:00+05:00")).toBeNull();
  });

  it("falls back to the current year when the creation date is missing", () => {
    const task = todo({ id: "nodate", planStatus: "Утвержден", planMonth: "Март", deadline: "2026-10-30T10:00:00+05:00" });
    const { top } = buildManagerDebts([task], { nowIso: "2026-10-31T12:00:00+05:00", holidays: [] });
    expect(top[0].passedPlanMonthNote).toBe("план на март прошёл");
  });
});
