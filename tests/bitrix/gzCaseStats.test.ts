import { describe, expect, it } from "vitest";
import { formatGzCaseReport, gzCaseSource, summarizeGzCase, type GzCaseDeal } from "../../src/bitrix/reporting/gzCaseStats.js";

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
    expect(text).toContain("Доля выигранных среди закрытых: 50%");
    expect(text).toContain("Договор подписан с нами (портал): 1");
    expect(text).toContain("оценка: 10 мин на сделку");
  });
});
