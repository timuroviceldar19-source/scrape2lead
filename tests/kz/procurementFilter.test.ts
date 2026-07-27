import { describe, expect, it } from "vitest";
import { classifyProcurementRecords } from "../../src/kz/procurement/filter.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";
import { buildPlanPeriodWindow, EMPTY_PLAN_PERIOD } from "../../src/kz/procurement/planPeriod.js";

describe("procurement plan period filtering", () => {
  const planPeriodWindow = buildPlanPeriodWindow(new Date(2026, 6, 27), 7); // июль 2026 -> янв 2027

  it("rejects a plan from a year outside the collection window", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "old", planYear: 2024, collectionPlanYear: 2024 }),
      row({ externalId: "current", planYear: 2026, collectionPlanYear: 2026 })
    ], { planPeriodWindow });

    expect(result.rejected.map((x) => [x.record.externalId, x.reason])).toEqual([["old", "plan_year_outside_window"]]);
    expect(result.data.map((x) => x.record.externalId)).toEqual(["current"]);
  });

  it("keeps a plan whose month the source never published", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "no-month", planYear: 2026, planMonth: null, collectionPlanYear: 2026 })
    ], { planPeriodWindow });
    expect(result.data.map((x) => x.record.externalId)).toEqual(["no-month"]);
  });

  it("rejects a known month outside the window but keeps one inside it", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "february", planYear: 2026, planMonth: 2, collectionPlanYear: 2026 }),
      row({ externalId: "september", planYear: 2026, planMonth: 9, collectionPlanYear: 2026 })
    ], { planPeriodWindow });

    expect(result.rejected.map((x) => [x.record.externalId, x.reason])).toEqual([["february", "plan_period_outside_window"]]);
    expect(result.data.map((x) => x.record.externalId)).toEqual(["september"]);
  });

  it("sends a year conflict to Review instead of dropping it silently", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "conflict", planYear: 2024, collectionPlanYear: 2026 })
    ], { planPeriodWindow });

    expect(result.data).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.review.map((x) => [x.record.externalId, x.reason])).toEqual([["conflict", "plan_year_conflict"]]);
  });

  it("skips period checks entirely when no window is configured", () => {
    expect(classifyProcurementRecords([row({ externalId: "old", planYear: 2024 })]).data.map((x) => x.record.externalId))
      .toEqual(["old"]);
  });
});

describe("procurement plan status allow-list", () => {
  it("accepts every configured status and rejects the rest", () => {
    const planStatuses = ["Утвержден", "На проверке камерального контроля"];
    const result = classifyProcurementRecords([
      row({ externalId: "approved", status: "Утвержден" }),
      row({ externalId: "cameral", status: "На проверке камерального контроля" }),
      row({ externalId: "draft", status: "Черновик" })
    ], { planStatuses });

    expect(result.data.map((x) => x.record.externalId)).toEqual(["approved", "cameral"]);
    expect(result.rejected.map((x) => [x.record.externalId, x.reason])).toEqual([["draft", "unsupported_status"]]);
  });

  it("falls back to approved-only when the config does not list statuses", () => {
    const result = classifyProcurementRecords([row({ externalId: "cameral", status: "На проверке камерального контроля" })]);
    expect(result.rejected.map((x) => x.reason)).toEqual(["unsupported_status"]);
  });
});

describe("procurement product and CRM eligibility filters", () => {
  it("accepts the four PK families only by an allowed code", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "pc", productName: "Компьютер", truCode: "262013.000.000011" }),
      row({ externalId: "mono", productName: "Моноблок", truCode: "262013.200.000001" }),
      row({ externalId: "notebook", productName: "Ноутбук", truCode: "262011.100.000002" }),
      row({ externalId: "monitor", productName: "Монитор", truCode: "262017.100.000003" })
    ]);
    expect(result.data.map((x) => x.record.externalId)).toEqual(["pc", "mono", "notebook", "monitor"]);
    expect(result.data.every((x) => x.product === "pk")).toBe(true);
  });

  it("rejects printers, MFPs, wrong monitor codes and rows below the minimum", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "printer", productName: "Принтер", truCode: "262018.000.000001" }),
      row({ externalId: "mfp", productName: "Устройство многофункциональное МФУ", truCode: "262013.000.000011" }),
      row({ externalId: "medical", productName: "Монитор медицинский", truCode: "266012.900.000001" }),
      row({ externalId: "cheap", amount: 499_999, productName: "Ноутбук", truCode: "262011.100.000002" })
    ]);
    expect(result.rejected.map((x) => x.reason)).toEqual([
      "stop_word",
      "stop_word",
      "irrelevant_tru_code",
      "below_min_amount"
    ]);
  });

  it("accepts panels by keyword but sends missing BIN or missing PK code to Review", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "panel", productName: "Панель интерактивная 75", truCode: null }),
      row({ externalId: "no-bin", customerBin: null, productName: "Ноутбук", truCode: "262011.100.000002" }),
      row({ externalId: "no-code", productName: "Компьютер персональный", truCode: null })
    ]);
    expect(result.data.map((x) => x.record.externalId)).toEqual(["panel"]);
    expect(result.data[0]?.product).toBe("panel");
    expect(result.review.map((x) => [x.record.externalId, x.reason])).toEqual([
      ["no-bin", "missing_bin"],
      ["no-code", "missing_tru_code"]
    ]);
  });

  it("rejects records without a stable id or URL", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "", url: "https://example.kz/one" }),
      row({ externalId: "two", url: "" }),
      row({ externalId: "three", sourceRecordId: null })
    ]);
    expect(result.rejected.map((x) => x.reason)).toEqual(["missing_external_id", "missing_url", "missing_source_record_id"]);
  });

  it("keeps detail failures and identity mismatches in Review", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "failed", detailIssue: "detail_fetch_failed" }),
      row({ externalId: "mismatch", detailIssue: "detail_identity_mismatch" })
    ]);
    expect(result.review.map((item) => [item.record.externalId, item.reason])).toEqual([
      ["failed", "detail_fetch_failed"], ["mismatch", "detail_identity_mismatch"]
    ]);
  });

  it("keeps broad panel search hits in Review until interactivity is explicit", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "ambiguous", productName: "Liquid crystal panel", description: "graphic display" }),
      row({ externalId: "interactive", productName: "Liquid crystal panel", description: "interactive touchscreen" })
    ], { panelKeywords: ["liquid crystal panel"] });
    expect(result.review.map((item) => [item.record.externalId, item.reason])).toContainEqual(["ambiguous", "ambiguous_panel"]);
    expect(result.data.map((item) => item.record.externalId)).toContain("interactive");
  });

  it("accepts only approved plans regardless of case/spacing and rejects every other or missing status", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "approved", status: "  УТВЕРЖДЕН  " }),
      row({ externalId: "cancelled", status: "Отменен" }),
      row({ externalId: "contract", status: "Договор создан" }),
      row({ externalId: "unknown", status: null })
    ]);
    expect(result.data.map((item) => item.record.externalId)).toContain("approved");
    expect(result.rejected.map((item) => [item.record.externalId, item.reason])).toEqual([
      ["cancelled", "unsupported_status"], ["contract", "unsupported_status"], ["unknown", "unsupported_status"]
    ]);
  });

  it("does not treat monitoring services as computer monitors", () => {
    const result = classifyProcurementRecords([
      row({ recordKind: "tender", externalId: "service", status: "Опубликован", productName: "Услуги онлайн мониторинга транспорта", truCode: null })
    ]);
    expect(result.review).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({ reason: "irrelevant_product" });
  });
});

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return {
    source: "mitwork",
    recordKind: "plan",
    sourceRecordId: "1",
    externalId: "1",
    parentExternalId: null,
    status: "Утвержден",
    productName: "Компьютер персональный",
    description: "",
    truCode: "262013.000.000011",
    customerName: "ТОО Заказчик",
    customerBin: "123456789012",
    amount: 900_000,
    currency: "KZT",
    startDate: null,
    endDate: null,
    url: "https://zakup.gov.kz/home/plan-items?q=1&system_id__in=2",
    purchaseMethod: null,
    ...EMPTY_PLAN_PERIOD, collectedAt: "2026-07-21T00:00:00.000Z",
    ...overrides
  };
}
