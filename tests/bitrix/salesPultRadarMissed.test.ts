import { describe, expect, it } from "vitest";
import {
  buildRadarView,
  computeRadarKpis,
  parseRadarLotDeal,
  type RadarCard,
  type RadarGroupView
} from "../../src/bitrix/salesPult/radar/aggregate.js";
import { filterRadarForManager } from "../../src/bitrix/salesPult/radar/filter.js";
import type { RadarView } from "../../src/bitrix/salesPult/radar/types.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import type { RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import {
  RADAR_AS_OF_DATE, RADAR_AS_OF_TIME, RADAR_MANAGER_NAMES, RADAR_PORTAL, radarLot, radarMissedDeals, radarMissedView
} from "../fixtures/sales-pult/radarMissed.js";

// Все данные выдуманные: см. tests/fixtures/sales-pult/radarMissed.ts.
const ids = (cards: RadarCard[]) => cards.map((c) => c.id);
const sum = (cards: RadarCard[]) => cards.reduce((acc, c) => acc + c.sum, 0);
const columns = ["submitToday", "discussion", "secondChance", "missed"] as const;
const allCards = (g: RadarGroupView) => columns.flatMap((col) => g[col]);
const parse = (id: string, asOfTime = RADAR_AS_OF_TIME) =>
  parseRadarLotDeal(radarMissedDeals().find((d) => d.ID === id)!, { asOfDate: RADAR_AS_OF_DATE, asOfTime, portal: RADAR_PORTAL, managerNames: RADAR_MANAGER_NAMES });

/** KPI группы, посчитанные заново прямо по спискам: тем же правилам, что описаны в aggregate.ts. */
function expectKpisMatchLists(g: RadarGroupView) {
  const soon = g.submitToday.filter((c) => c.isToday || c.isWithin48h);
  const submit = soon.length ? soon : g.submitToday;
  expect(g.kpis).toEqual({
    totalCount: g.submitToday.length + g.discussion.length + g.secondChance.length,
    totalSum: sum(g.submitToday) + sum(g.discussion) + sum(g.secondChance),
    submitCount: submit.length,
    submitSum: sum(submit),
    discussionCount: g.discussion.length,
    discussionSum: sum(g.discussion),
    secondChanceCount: g.secondChance.length,
    secondChanceSum: sum(g.secondChance),
    missedCount: g.missed.length,
    missedSum: sum(g.missed)
  });
}

describe("Радар: пропущенные сроки", () => {
  it("истёкший срок + стадия «Новая» + не старше 7 дней — колонка missed", () => {
    const card = parse("8103");
    expect(card).not.toBeNull();
    expect(card!.column).toBe("missed");
    expect(card!.isNewStage).toBe(true);
    expect(card!.endAt).toBe("2026-11-20 18:00");
    expect(card!.hoursLeft).toBeLessThan(0);
    expect(card!.isWithin48h).toBe(false);
  });

  it("истёкший срок в другой стадии, старше 7 дней, закрытая сделка, даты-заглушки — не попадают", () => {
    expect(parse("8105"), "в работе").toBeNull();
    expect(parse("8106"), "старше 7 дней").toBeNull();
    expect(parse("8107"), "закрыта").toBeNull();
    expect(parse("8109"), "даты-заглушки Битрикса").toBeNull();
  });

  it("граница окна: ровно 7 дней назад ещё пропуск, на минуту раньше — уже нет", () => {
    const opts = { asOfDate: "2026-11-21", asOfTime: "2026-11-21T10:00:00+05:00", portal: RADAR_PORTAL };
    expect(parseRadarLotDeal(radarLot({ ID: "8201", window: "2026-11-10 09:00 — 2026-11-14 10:00" }), opts)?.column).toBe("missed");
    expect(parseRadarLotDeal(radarLot({ ID: "8202", window: "2026-11-10 09:00 — 2026-11-14 09:59" }), opts)).toBeNull();
    // Дата без времени — конец дня по Алматы: 14.11 23:59:59 ещё в окне.
    expect(parseRadarLotDeal(radarLot({ ID: "8203", window: "2026-11-10 — 2026-11-14" }), opts)?.column).toBe("missed");
  });

  it("несостоявшаяся закупка остаётся «Вторым шансом», а не пропуском", () => {
    const card = parseRadarLotDeal(
      radarLot({ ID: "8204", status: "Закупка не состоялась", window: "2026-11-15 09:00 — 2026-11-19 12:00" }),
      { asOfDate: RADAR_AS_OF_DATE, asOfTime: RADAR_AS_OF_TIME }
    );
    expect(card?.column).toBe("secondChance");
  });

  it("buildRadarView: missed отдельно, свежие сверху, потом по сумме; прежние колонки и KPI не меняются", () => {
    const view = radarMissedView();
    expect(ids(view.ip.missed)).toEqual(["8108", "8103", "8104"]);
    expect(ids(view.kt.missed)).toEqual(["8110"]);
    expect(ids(view.ip.submitToday)).toEqual(["8101", "8102"]);
    expect(ids(view.ip.discussion)).toEqual(["8111"]);
    expect(view.ip.secondChance).toEqual([]);
    expect(view.ip.kpis).toMatchObject({
      totalCount: 3, totalSum: 9_200_000, submitCount: 2, submitSum: 7_000_000,
      missedCount: 3, missedSum: 13_000_000
    });
    expect(view.kt.kpis).toMatchObject({ totalCount: 0, totalSum: 0, missedCount: 1, missedSum: 2_500_000 });
    expectKpisMatchLists(view.ip);
    expectKpisMatchLists(view.kt);
  });

  it("computeRadarKpis считает по спискам и для пустой группы", () => {
    expect(computeRadarKpis({ submitToday: [], discussion: [], secondChance: [], missed: [] })).toEqual({
      totalCount: 0, totalSum: 0, submitCount: 0, submitSum: 0, discussionCount: 0, discussionSum: 0,
      secondChanceCount: 0, secondChanceSum: 0, missedCount: 0, missedSum: 0
    });
    const view = radarMissedView();
    expect(computeRadarKpis(view.ip)).toEqual(view.ip.kpis);
  });

  it("лотов с истёкшим окном без «Новой» по-прежнему нет нигде", () => {
    const view = buildRadarView({
      lotDeals: [radarLot({ ID: "8301", STAGE_ID: "C43:EXECUTING", window: "2026-11-15 09:00 — 2026-11-20 12:00" })],
      asOfDate: RADAR_AS_OF_DATE, asOfTime: RADAR_AS_OF_TIME
    });
    expect(allCards(view.ip)).toEqual([]);
  });
});

describe("filterRadarForManager", () => {
  it("оставляет только карточки менеджера во всех колонках, KPI пересчитаны, чужих имён и ID нет", () => {
    const full = radarMissedView();
    const mine = filterRadarForManager(full, "s");
    expect(ids(mine.ip.submitToday)).toEqual(["8101"]);
    expect(ids(mine.ip.missed)).toEqual(["8103"]);
    expect(mine.ip.discussion).toEqual([]);
    expect(ids(mine.kt.missed)).toEqual(["8110"]);
    for (const g of [mine.ip, mine.kt]) {
      expect(allCards(g).every((c) => c.managerId === "s")).toBe(true);
      expectKpisMatchLists(g);
    }
    expect(mine.ip.kpis).toMatchObject({ totalCount: 1, totalSum: 4_000_000, missedCount: 1, missedSum: 2_000_000 });
    const json = JSON.stringify(mine);
    for (const other of ["Борис", "Чужая", "8102", "8104", "8108", "8111"]) expect(json, other).not.toContain(other);
    expect(mine.asOf).toBe(full.asOf);
    // Исходный вид не тронут.
    expect(ids(full.ip.missed)).toEqual(["8108", "8103", "8104"]);
  });

  it("сохраняет error и asOf; группы без данных и пустой ID дают пустые списки", () => {
    const broken = { asOf: "2026-11-21", error: "Не удалось загрузить" } as RadarView;
    const out = filterRadarForManager(broken, "s");
    expect(out.error).toBe("Не удалось загрузить");
    expect(out.asOf).toBe("2026-11-21");
    expect(out.ip.group).toBe("ИП");
    expect(out.kt.group).toBe("КТ");
    expect(allCards(out.ip)).toEqual([]);
    expect(out.ip.kpis.missedCount).toBe(0);

    const unassigned = buildRadarView({
      lotDeals: [radarLot({ ID: "8401", ASSIGNED_BY_ID: "", window: "2026-11-18 09:00 — 2026-11-22 18:00" })],
      asOfDate: RADAR_AS_OF_DATE, asOfTime: RADAR_AS_OF_TIME
    });
    expect(unassigned.ip.submitToday).toHaveLength(1);
    expect(allCards(filterRadarForManager(unassigned, "").ip)).toEqual([]);
  });

  it("не тащит в вид менеджера посторонние поля полного радара", () => {
    const full = { ...radarMissedView(), extra: "секрет" } as RadarView & { extra: string };
    (full.ip as RadarGroupView & { extra?: string }).extra = "секрет";
    expect(JSON.stringify(filterRadarForManager(full, "s"))).not.toContain("секрет");
  });
});

describe("вид менеджера: свой «Радар»", () => {
  function sample() {
    const f = fixture();
    f.payload.radar = radarMissedView();
    const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, register: f.register };
    return { pult: f.payload, reg };
  }

  it("payload менеджера: только его лоты и пропуски, конкурентов нет", () => {
    const { pult, reg } = sample();
    const v = buildManagerVariant({ pult, reg, planDeals: [], managerId: "s" })!;
    const radar = v.pult.radar!;
    expect(radar).not.toBeNull();
    expect(ids(radar.ip.submitToday)).toEqual(["8101"]);
    expect(ids(radar.ip.missed)).toEqual(["8103"]);
    expect(v.pult.competitors).toBeNull();
    // Закрытые месяцы радара не несут.
    for (const closed of Object.values(v.pult.closedMonths ?? {})) expect(closed?.radar ?? null).toBeNull();
  });

  // Ссылки меню («Радар» есть, «Финансов» и «Конкурентов» нет) убирает скрипт страницы:
  // это проверяет браузерный тест salesPultRadarLiveBrowser.test.ts.
  it("HTML менеджера содержит его лоты и не содержит чужих имён и сделок", () => {
    const { pult, reg } = sample();
    const pages = renderManagerVariant(buildManagerVariant({ pult, reg, planDeals: [], managerId: "s" })!);
    const html = pages.index;
    expect(html).toContain("Панель Своя-горящая");
    expect(html).toContain("Панель Своя-пропущенная");
    expect(html).toContain("/crm/deal/details/8101/");
    expect(html).toContain("/crm/deal/details/8103/");
    for (const other of ["Борис", "Чужая", "/crm/deal/details/8102/", "/crm/deal/details/8104/", "/crm/deal/details/8108/", "/crm/deal/details/8111/"]) {
      expect(html, other).not.toContain(other);
    }
    expect(pages.reg).not.toContain("Борис");
  });

  it("без радара в полном пульте у менеджера null; с ошибкой — ошибка без карточек", () => {
    const { pult, reg } = sample();
    const none = buildManagerVariant({ pult: { ...pult, radar: null }, reg, planDeals: [], managerId: "s" })!;
    expect(none.pult.radar).toBeNull();
    const errored: SalesPultPayload = { ...pult, radar: { ...radarMissedView(), error: "Не удалось загрузить данные Радара из Битрикс24." } };
    const v = buildManagerVariant({ pult: errored, reg, planDeals: [], managerId: "s" })!;
    expect(v.pult.radar!.error).toBe("Не удалось загрузить данные Радара из Битрикс24.");
    expect(JSON.stringify(v.pult.radar)).not.toContain("Борис");
  });
});
