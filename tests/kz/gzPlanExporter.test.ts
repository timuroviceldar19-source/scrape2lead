import { describe, expect, it } from "vitest";
import {
  assertRegistryCoverage,
  buildExportRow,
  buildRegistryProfileHints,
  filterPlanRows
} from "../../src/kz/gzPlanExporter.js";
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
  it("prefers the official registry customer name", () => {
    const row = buildExportRow(
      listItem({ customer_name: "Сокращённое название" }),
      detail({ customer_name: "Название из плана" }),
      registry({ name_ru: "Официальное название" })
    );
    expect(row?.customer_name).toBe("Официальное название");
  });

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

describe("registry profile hints", () => {
  it("collects one direct supplier profile URL for all rows of the same BIN", () => {
    const items = ["87017028", "87017029", "87017030"].map((planPointId) => ({
      ...listItem({
        plan_point_id: planPointId,
        customer_url: "https://goszakup.gov.kz/ru/registry/show_supplier/34591"
      }),
      detail: detail({ plan_point_id: planPointId, customer_bin: "980840002897" })
    }));

    // Ссылка на входе — со старого домена (так они лежат в БД), нормализуется на новый.
    expect(buildRegistryProfileHints(items)).toEqual(new Map([
      ["980840002897", "https://procurement.gov.kz/ru/registry/show_supplier/34591"]
    ]));
  });

  it("ignores non-goszakup supplier URLs", () => {
    const items = [{
      ...listItem({ customer_url: "https://example.test/ru/registry/show_supplier/34591" }),
      detail: detail({ customer_bin: "980840002897" })
    }];
    expect(buildRegistryProfileHints(items)).toEqual(new Map());
  });

  it("rejects conflicting supplier profiles for one BIN", () => {
    const items = ["34591", "99999"].map((participantId) => ({
      ...listItem({ customer_url: `https://goszakup.gov.kz/ru/registry/show_supplier/${participantId}` }),
      detail: detail({ customer_bin: "980840002897" })
    }));
    expect(() => buildRegistryProfileHints(items)).toThrow(/980840002897.*34591.*99999/);
  });
});

describe("registry coverage preflight", () => {
  const items = ["87017028", "87017029", "87017030"].map((planPointId) => ({
    ...listItem({ plan_point_id: planPointId }),
    detail: detail({ plan_point_id: planPointId, customer_bin: "980840002897" })
  }));

  it("reports the BIN and all affected plan IDs when enrichment is missing", () => {
    expect(() => assertRegistryCoverage(items, new Map())).toThrow(
      /980840002897.*87017028.*87017029.*87017030/
    );
  });

  it("accepts a registry profile with a name and optional blank contacts", () => {
    expect(() => assertRegistryCoverage(items, new Map([
      ["980840002897", registry({ bin: "980840002897", name_ru: "Customer", email: null, phone: null, website: null })]
    ]))).not.toThrow();
  });
});

describe("filterPlanRows", () => {
  function row(planned_amount: string, stru_name: string, struCode: string | null = null) {
    return buildExportRow(
      listItem({ planned_amount, item_name: stru_name }),
      detail({ name_ru: stru_name, ref_enstru_code: struCode }),
      registry()
    )!;
  }

  it("drops rows below the minimum amount", () => {
    const rows = [row("100", "Панель интерактивная"), row("750000", "Панель интерактивная")];
    const kept = filterPlanRows(rows, 500000, []);
    expect(kept).toHaveLength(1);
    expect(kept[0].planned_amount).toBe("750000");
  });

  it("drops rows whose item name is in the stop-list", () => {
    const rows = [row("900000", "Уголок"), row("900000", "Панель интерактивная")];
    const kept = filterPlanRows(rows, 500000, ["Уголок"]);
    expect(kept).toHaveLength(1);
    expect(kept[0].stru_name).toBe("Панель интерактивная");
  });

  it("keeps everything when no filters are configured", () => {
    const rows = [row("1", "Уголок"), row("900000", "Панель интерактивная")];
    expect(filterPlanRows(rows, 0, [])).toHaveLength(2);
  });

  it("keeps only configured PK TRU families and rejects missing codes", () => {
    const rows = [
      row("900000", "Ноутбук", "262011.100.000002"),
      row("900000", "Компьютер", "262013.000.000011"),
      row("900000", "Монитор", "262017.100.000001"),
      row("900000", "Станция рабочая", "262013.000.000024"),
      row("900000", "Устройство многофункциональное", "262018.900.000006"),
      row("900000", "Принтер", "262016.300.000016"),
      row("900000", "Монитор медицинский", "266012.900.000004"),
      row("900000", "Транспондер", "262030.100.000051"),
      row("900000", "Неизвестный товар", null)
    ];

    const kept = filterPlanRows(rows, 0, [], ["262011.", "262013.", "262017.100."]);

    expect(kept.map((item) => item.stru_name)).toEqual([
      "Ноутбук",
      "Компьютер",
      "Монитор",
      "Станция рабочая"
    ]);
  });
});
