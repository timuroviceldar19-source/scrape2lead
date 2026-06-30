import { describe, expect, it } from "vitest";
import { buildExportRow } from "../../src/kz/gzPlanExporter.js";
import type { GoszakupRegistryRecord } from "../../src/kz/registryTypes.js";
import type { GoszakupPlanDetail, GoszakupPlanListItem } from "../../src/kz/goszakupPlanTypes.js";

function listItem(overrides: Partial<GoszakupPlanListItem> = {}): GoszakupPlanListItem {
  return {
    plan_point_id: "100",
    plan_list_number: null,
    customer_name: null,
    customer_url: null,
    keyword: "test",
    item_name: "Item",
    method: null,
    unit: null,
    quantity: null,
    unit_price: null,
    planned_amount: null,
    planned_month: null,
    status: null,
    detail_url: null,
    ...overrides
  };
}

function detail(overrides: Partial<GoszakupPlanDetail> = {}): GoszakupPlanDetail {
  return {
    plan_point_id: "100",
    customer_bin: "000240001420",
    customer_name: null,
    name_ru: null,
    ref_enstru_code: null,
    desc_ru: null,
    extra_desc_ru: null,
    date_approved: null,
    ref_abp_code: null,
    abp_name: null,
    delivery_address: null,
    plan_act_number: null,
    ...overrides
  };
}

function registry(overrides: Partial<GoszakupRegistryRecord> = {}): GoszakupRegistryRecord {
  return {
    bin: "000240001420",
    participant_id: "12345",
    name_ru: "School",
    name_kz: null,
    rnn: null,
    role: null,
    residency: null,
    phone: null,
    email: null,
    website: null,
    registration_date: null,
    last_update_date: null,
    kopf: null,
    ownership_form: null,
    economic_sector: null,
    director_name: null,
    director_iin: null,
    legal_address: "Карагандинская область, г.Сарань, УШАКОВА, 8/1",
    location_address: null,
    full_address_ru: "Карагандинская область, г.Сарань, УШАКОВА, 8/1",
    reporting_administrator: 'ГУ "Управление образования Карагандинской области"',
    registry_url: null,
    updated_at: "2026-06-25T00:00:00.000Z",
    raw_snapshot_path: null,
    ...overrides
  };
}

describe("buildExportRow registry fallback", () => {
  it("uses registry reporting administrator when plan detail has no abp_name", () => {
    const row = buildExportRow(listItem(), detail({ abp_name: null, ref_abp_code: null }), registry());
    expect(row?.reporting_administrator).toBe('ГУ "Управление образования Карагандинской области"');
  });

  it("prefers plan detail abp_name over registry", () => {
    const row = buildExportRow(
      listItem(),
      detail({ abp_name: "Plan ABP", ref_abp_code: "CODE" }),
      registry()
    );
    expect(row?.reporting_administrator).toBe("Plan ABP");
  });

  it("uses registry full_address_ru for full_address column", () => {
    const row = buildExportRow(listItem(), detail({ delivery_address: null }), registry());
    expect(row?.full_address).toContain("Карагандинская область, г.Сарань");
  });

  it("joins registry address with plan delivery_address", () => {
    const row = buildExportRow(
      listItem(),
      detail({ delivery_address: "Склад №2" }),
      registry({ location_address: "Фактический адрес" })
    );
    expect(row?.full_address).toBe(
      "Карагандинская область, г.Сарань, УШАКОВА, 8/1; Фактический адрес; Склад №2"
    );
  });

  it("exports plan detail source fields separately", () => {
    const row = buildExportRow(
      listItem(),
      detail({
        ref_enstru_code: "262030.100.000043",
        desc_ru: "Краткое описание",
        extra_desc_ru: "Приобретение интерактивная панель с меловой доской в комплекте",
        delivery_address: "область Жетісу, г.Талдыкорган Алимжанова 20"
      }),
      registry()
    );

    expect(row?.stru_code).toBe("262030.100.000043");
    expect(row?.short_characteristics).toBe("Краткое описание");
    expect(row?.extra_description).toBe("Приобретение интерактивная панель с меловой доской в комплекте");
    expect(row?.delivery_address).toBe("область Жетісу, г.Талдыкорган Алимжанова 20");
  });
});
