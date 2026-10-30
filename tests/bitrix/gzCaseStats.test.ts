import { describe, expect, it } from "vitest";
import {
  formatGzCaseReport, gzCaseSource, isGzManualCopy, summarizeGzCase, type GzCaseDeal
} from "../../src/bitrix/reporting/gzCaseStats.js";

const deal = (overrides: Partial<GzCaseDeal>): GzCaseDeal => ({
  ID: "1",
  TITLE: "[GZ 100] Школа - Ноутбук",
  ORIGINATOR_ID: "scrape2lead-gz-plans",
  DATE_CREATE: "2026-03-05T10:00:00+05:00",
  STAGE_SEMANTIC_ID: "P",
  OPPORTUNITY: "1000",
  UF_CRM_S2L_GZ_OUTCOME: null,
  ...overrides
});

describe("gzCaseSource", () => {
  it("узнаёт сделку робота по ORIGINATOR_ID, а ранний Excel-импорт по названию [GZ …]", () => {
    expect(gzCaseSource(deal({ ORIGINATOR_ID: "scrape2lead-gz-plans" }))).toBe("plans");
    expect(gzCaseSource(deal({ ORIGINATOR_ID: "scrape2lead-gz-lots", TITLE: "[GZ лот 1-1] Акимат — Панель" }))).toBe("lots");
    expect(gzCaseSource(deal({ ORIGINATOR_ID: "scrape2lead-procurement", TITLE: "Закупка" }))).toBe("procurement");
    expect(gzCaseSource(deal({ ORIGINATOR_ID: "app_iu_xls_import" }))).toBe("excel");
    expect(gzCaseSource(deal({ ORIGINATOR_ID: null, TITLE: "Звонок клиента" }))).toBeNull();
  });

  it("не считает роботом сделку, которую менеджер завёл руками с названием [GZ …]", () => {
    expect(gzCaseSource(deal({ ORIGINATOR_ID: null }))).toBeNull();
    expect(isGzManualCopy(deal({ ORIGINATOR_ID: null }))).toBe(true);
    expect(isGzManualCopy(deal({ ORIGINATOR_ID: "app_iu_xls_import" }))).toBe(false);
    expect(isGzManualCopy(deal({ ORIGINATOR_ID: null, TITLE: "Звонок клиента" }))).toBe(false);
  });
});

describe("summarizeGzCase: уточнения для кейса", () => {
  const semantics = { "C9:LOSE": "failure", "C9:4": "apology", "C9:WON": "success" };
  const summary = summarizeGzCase([
    deal({ ID: "1", TITLE: "[GZ 100] Школа - Ноутбук", STAGE_ID: "C9:WON", STAGE_SEMANTIC_ID: "S", OPPORTUNITY: "500000" }),
    deal({ ID: "2", ORIGINATOR_ID: "scrape2lead-gz-lots", TITLE: "[GZ лот 100-ОК1] Школа — Ноутбук", ORIGIN_ID: "gz-lot:100-ОК1",
      STAGE_ID: "C9:LOSE", STAGE_SEMANTIC_ID: "F", OPPORTUNITY: "400000", UF_CRM_S2L_GZ_OUTCOME: "won:7" }),
    deal({ ID: "3", ORIGINATOR_ID: "scrape2lead-gz-lots", TITLE: "Переименовал менеджер", ORIGIN_ID: "gz-lot:200-ОК1",
      STAGE_ID: "C9:4", STAGE_SEMANTIC_ID: "F", OPPORTUNITY: "300000", UF_CRM_S2L_GZ_OUTCOME: "published:опубликован" }),
    deal({ ID: "4", TITLE: "Тоже переименована", UF_CRM_PLAN_ID: "200", OPPORTUNITY: "200000",
      UF_CRM_S2L_GZ_OUTCOME: "contract-draft:проект договора" }),
    deal({ ID: "5", ORIGINATOR_ID: null, TITLE: "[GZ 100] Копия в другую воронку", OPPORTUNITY: "500000" })
  ], { minutesPerDeal: 60, stageSemantics: semantics });

  it("выносит ручные копии [GZ …] из итога в отдельную строку", () => {
    expect(summary.deals).toBe(4);
    expect(summary.manualCopies).toEqual({ deals: 1, amount: 500_000 });
    expect(summary.hoursSaved).toBe(4);
  });

  it("находит лоты, которые повторяют уже заведённый пункт плана", () => {
    expect(summary.lotsRepeatingPlans).toEqual({ deals: 2, amount: 700_000 });
    expect(summary.uniqueProcurements).toEqual({ deals: 2, amount: 700_000 });
  });

  it("отделяет отсеянные менеджером сделки от проигранных", () => {
    expect(summary.stages.won).toEqual({ deals: 1, amount: 500_000 });
    expect(summary.stages.lost).toEqual({ deals: 1, amount: 400_000 });
    expect(summary.stages.rejected).toEqual({ deals: 1, amount: 300_000 });
    expect(summary.winRate).toBeCloseTo(1 / 3);
    expect(summary.winRateContested).toBe(0.5);
  });

  it("считает выигранные по этапу или порталу без повторов", () => {
    expect(summary.portalWon).toEqual({ deals: 1, amount: 400_000 });
    expect(summary.wonAny).toEqual({ deals: 2, amount: 900_000 });
  });

  it("делит выигранные по источнику и показывает, отслеживаются ли там итоги", () => {
    expect(summary.wonBySource.plans).toEqual({ deals: 1, amount: 500_000 });
    expect(summary.wonBySource.lots).toEqual({ deals: 1, amount: 400_000 });
    expect(summary.coverageBySource.plans).toEqual({ deals: 2, withOutcome: 1, closed: 1 });
    expect(summary.coverageBySource.lots).toEqual({ deals: 2, withOutcome: 2, closed: 2 });
    const text = formatGzCaseReport(summary, "2026-10-30");
    expect(text).toContain("  - Пункты планов goszakup: 1 на 500 000 ₸ (итог с портала у 1 из 2, закрыто в Bitrix 1)");
    expect(text).toContain("  - Лоты goszakup: 1 на 400 000 ₸ (итог с портала у 2 из 2, закрыто в Bitrix 2)");
    expect(text).not.toContain("до объявления");
    expect(text).not.toContain("не проверяется");
  });

  it("не выдаёт ноль выигранных за результат, если у источника итоги не отслеживаются", () => {
    const text = formatGzCaseReport(summarizeGzCase([
      deal({ ID: "1", STAGE_SEMANTIC_ID: "S", OPPORTUNITY: "100" }),
      deal({ ID: "2", ORIGINATOR_ID: "scrape2lead-procurement", TITLE: "Закупка", OPPORTUNITY: "50" })
    ], { minutesPerDeal: 10 }), "2026-10-30");
    expect(text).toContain("  - Другие площадки: 0 на 0 ₸ (итог с портала у 0 из 1, закрыто в Bitrix 0)");
    expect(text).toContain("Для «Пункты планов goszakup», «Другие площадки» итог с портала не проверяется");
  });

  it("показывает в отчёте все итоги портала и новые строки", () => {
    const text = formatGzCaseReport(summary, "2026-10-30");
    expect(text).toContain("Создано сделок: 4");
    expect(text).toContain("Проиграно: 1 на 400 000 ₸");
    expect(text).toContain("Отсеяно менеджером");
    expect(text).toContain("Доля выигранных среди выигранных и проигранных: 50%");
    expect(text).toContain("Доля выигранных среди всех закрытых, включая отсеянные: 33%");
    expect(text).toContain("Выиграно всего (этап Bitrix или портал): 2 на 900 000 ₸");
    expect(text).toContain("Договор подписан с нами (портал): 1 на 400 000 ₸");
    expect(text).toContain("Объявление опубликовано, итога пока нет: 1");
    expect(text).toContain("Победитель определён, договор ещё не подписан: 1");
    expect(text).toContain("Уникальных закупок (оценка): 2 на 700 000 ₸");
    expect(text).toContain("Ручные копии сделок робота");
    expect(text).not.toContain("Ранний Excel-импорт");
  });
});

describe("summarizeGzCase", () => {
  const deals = [
    deal({ ID: "1", STAGE_SEMANTIC_ID: "S", OPPORTUNITY: "500000", UF_CRM_S2L_GZ_OUTCOME: "won:123" }),
    deal({ ID: "2", STAGE_SEMANTIC_ID: "F", OPPORTUNITY: "200000", UF_CRM_S2L_GZ_OUTCOME: "lost:124" }),
    deal({ ID: "3", ORIGINATOR_ID: "scrape2lead-gz-lots", DATE_CREATE: "2026-04-01T09:00:00+05:00",
      OPPORTUNITY: "300000", UF_CRM_S2L_GZ_OUTCOME: "partner:125" }),
    deal({ ID: "4", ORIGINATOR_ID: "app_iu_xls_import", DATE_CREATE: "2025-12-20T09:00:00+05:00", OPPORTUNITY: "" }),
    deal({ ID: "4", ORIGINATOR_ID: "app_iu_xls_import", DATE_CREATE: "2025-12-20T09:00:00+05:00", OPPORTUNITY: "" }),
    deal({ ID: "5", ORIGINATOR_ID: "manual", TITLE: "Не робот" })
  ];
  const summary = summarizeGzCase(deals, { minutesPerDeal: 15 });

  it("считает только сделки робота и не дублирует один ID", () => {
    expect(summary.deals).toBe(4);
    expect(summary.amount).toBe(1_000_000);
    expect(summary.bySource.plans).toEqual({ deals: 2, amount: 700_000 });
    expect(summary.bySource.lots).toEqual({ deals: 1, amount: 300_000 });
    expect(summary.bySource.excel).toEqual({ deals: 1, amount: 0 });
    expect(summary.firstCreated).toBe("2025-12-20");
    expect(summary.lastCreated).toBe("2026-04-01");
  });

  it("делит сделки по этапам Bitrix и считает долю выигранных среди закрытых", () => {
    expect(summary.stages.won).toEqual({ deals: 1, amount: 500_000 });
    expect(summary.stages.lost).toEqual({ deals: 1, amount: 200_000 });
    expect(summary.stages.open).toEqual({ deals: 2, amount: 300_000 });
    expect(summary.winRate).toBe(0.5);
  });

  it("берёт итог закупки с портала из UF_CRM_S2L_GZ_OUTCOME", () => {
    expect(summary.outcomes).toEqual({ won: 1, lost: 1, partner: 1, none: 1 });
  });

  it("группирует по месяцу создания и оценивает сэкономленные часы", () => {
    expect(summary.byMonth.map((row) => row.month)).toEqual(["2025-12", "2026-03", "2026-04"]);
    expect(summary.byMonth[1]).toEqual({ month: "2026-03", deals: 2, amount: 700_000 });
    expect(summary.hoursSaved).toBe(1);
  });

  it("не делит на ноль, когда закрытых сделок нет", () => {
    expect(summarizeGzCase([deal({})], { minutesPerDeal: 10 }).winRate).toBeNull();
  });
});

describe("formatGzCaseReport", () => {
  it("пишет главные цифры и честно помечает оценку часов", () => {
    const text = formatGzCaseReport(summarizeGzCase([
      deal({ ID: "1", STAGE_SEMANTIC_ID: "S", OPPORTUNITY: "500000", UF_CRM_S2L_GZ_OUTCOME: "won:1" }),
      deal({ ID: "2", STAGE_SEMANTIC_ID: "F", OPPORTUNITY: "200000" })
    ], { minutesPerDeal: 10 }), "2026-10-30");
    expect(text).toContain("Создано сделок: 2");
    expect(text).toContain("Выиграно (этап Bitrix): 1 на 500 000 ₸");
    expect(text).toContain("Доля выигранных среди всех закрытых, включая отсеянные: 50%");
    expect(text).toContain("Договор подписан с нами (портал): 1");
    expect(text).toContain("оценка: 10 мин на сделку");
  });
});
