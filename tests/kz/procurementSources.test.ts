import { describe, expect, it } from "vitest";
import { parseEpzLot, parseEpzPlan } from "../../src/kz/procurement/epz.js";
import { parseTizilimTender } from "../../src/kz/procurement/tizilim.js";

describe("EPZ procurement normalization", () => {
  it("excludes Goszakup and maps MITWORK and Samruk plans", () => {
    expect(parseEpzPlan({ system_id: 1, id: 1, external_id: "gz-1" })).toBeNull();

    expect(parseEpzPlan({
      system_id: 2,
      id: 219,
      external_id: "mtw-7",
      purchase_method_name: "Запрос ценовых предложений",
      total_price: 900_000,
      unit_price: 450_000,
      count: 2,
      organization_name: "ТОО NIS",
      status_name: "Утвержден",
      enstru: { name_ru: "Компьютер персональный", code: "262013.000.000011" }
    })).toMatchObject({
      source: "mitwork",
      recordKind: "plan",
      sourceRecordId: "219",
      externalId: "mtw-7",
      productName: "Компьютер персональный",
      truCode: "262013.000.000011",
      amount: 900_000
    });

    expect(parseEpzPlan({ system_id: 3, id: 220, external_id: "sk-8", enstru: { name_ru: "Ноутбук" } }))
      .toMatchObject({ source: "samruk", externalId: "sk-8" });
  });

  it("maps published lots and preserves the upstream plan relationship", () => {
    expect(parseEpzLot({
      system: { id: 3, name: "SKK" },
      id: 44,
      external_id: 991,
      lot_number: "4493136",
      announcement_number: "1240690",
      name_ru: "Поставка ноутбуков",
      enstru_key: "262011.100.000002",
      organization_name: "АО Заказчик",
      total_price: 4_000_000,
      status_name: "Опубликован",
      offer_start_date: "2026-07-21T00:00:00Z",
      offer_end_date: "2026-07-27T00:00:00Z",
      plan_items: [{ id: 7788 }]
    })).toMatchObject({
      source: "samruk",
      recordKind: "tender",
      externalId: "991",
      parentExternalId: "7788",
      truCode: "262011.100.000002",
      status: "Опубликован"
    });
  });
});

describe("Tizilim procurement normalization", () => {
  it("maps a public tender and keeps absent BIN explicit", () => {
    expect(parseTizilimTender({
      number: "2026.ОК-33622",
      name_ru: "Поставка интерактивной панели 75 дюймов",
      customer: { name_ru: "ТОО Табынай" },
      amount: "11800000.00",
      type: { name_ru: "Открытый конкурс" },
      status: { name_ru: "Опубликован" },
      start_date: "2026-07-21 19:10:00+05",
      end_date: "2026-08-05 08:00:00+05"
    })).toMatchObject({
      source: "tizilim",
      recordKind: "tender",
      externalId: "2026.ОК-33622",
      customerBin: null,
      amount: 11_800_000,
      status: "Опубликован"
    });
  });
});
