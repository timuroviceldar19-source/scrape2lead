import { describe, expect, it } from "vitest";
import { classifyProcurementRecords } from "../../src/kz/procurement/filter.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

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
      row({ externalId: "two", url: "" })
    ]);
    expect(result.rejected.map((x) => x.reason)).toEqual(["missing_external_id", "missing_url"]);
  });

  it("keeps broad panel search hits in Review until interactivity is explicit", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "ambiguous", productName: "Liquid crystal panel", description: "graphic display" }),
      row({ externalId: "interactive", productName: "Liquid crystal panel", description: "interactive touchscreen" })
    ], { panelKeywords: ["liquid crystal panel"] });
    expect(result.review.map((item) => [item.record.externalId, item.reason])).toContainEqual(["ambiguous", "ambiguous_panel"]);
    expect(result.data.map((item) => item.record.externalId)).toContain("interactive");
  });

  it("rejects inactive plans and reviews plans without a normalized status", () => {
    const result = classifyProcurementRecords([
      row({ externalId: "excluded", status: "Excluded" }),
      row({ externalId: "unknown", status: null })
    ]);
    expect(result.rejected.map((item) => [item.record.externalId, item.reason])).toContainEqual(["excluded", "inactive_status"]);
    expect(result.review.map((item) => [item.record.externalId, item.reason])).toContainEqual(["unknown", "missing_status"]);
  });
});

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return {
    source: "mitwork",
    recordKind: "plan",
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
    collectedAt: "2026-07-21T00:00:00.000Z",
    ...overrides
  };
}
