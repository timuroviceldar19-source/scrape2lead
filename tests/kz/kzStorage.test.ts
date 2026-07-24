import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { KzStorage } from "../../src/kz/kzStorage.js";
import type { GoszakupPlanDetail } from "../../src/kz/goszakupPlanTypes.js";
import type { GoszakupRegistryRecord } from "../../src/kz/registryTypes.js";

describe("KzStorage active GZ registry surface", () => {
  it("stores and reads a registry record", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupRegistry(registryRecord());

    expect(storage.getGoszakupRegistryByBin("123456789012")).toMatchObject({
      bin: "123456789012",
      name_ru: "Test Customer",
      email: "contact@example.kz"
    });
  });

  it("checks TTL and required contacts", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupRegistry(registryRecord({ email: null, updated_at: "2026-06-29T00:00:00.000Z" }));

    const now = new Date("2026-06-30T00:00:00.000Z");
    expect(storage.isGoszakupRegistryFresh("123456789012", 7, now)).toBe(true);
    expect(storage.isGoszakupRegistryFresh("123456789012", 7, now, { requireAnyContact: true })).toBe(false);
  });

  it("does not treat a cached registry record without a name as complete", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupRegistry(registryRecord({ name_ru: null }));

    const now = new Date("2026-06-30T00:00:00.000Z");
    expect(storage.isGoszakupRegistryFresh("123456789012", 7, now, { requireName: true })).toBe(false);
  });

  it("records enrichment errors", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.recordEnrichError("123456789012", "goszakup_registry", "timeout");
    expect(storage.getEnrichErrors()[0]).toMatchObject({
      bin: "123456789012",
      stage: "goszakup_registry",
      message: "timeout"
    });
  });
});

describe("KzStorage plan detail cache", () => {
  it("stores and reads back a fresh plan detail", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupPlanDetail(planDetail(), "2026-07-24T00:00:00.000Z");

    const now = new Date("2026-07-25T00:00:00.000Z");
    expect(storage.getFreshGoszakupPlanDetail("100200", 3, now)).toMatchObject({
      plan_point_id: "100200",
      customer_bin: "123456789012",
      ref_enstru_code: "262011.100.000001"
    });
  });

  it("treats an expired detail as a cache miss", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupPlanDetail(planDetail(), "2026-07-20T00:00:00.000Z");

    const now = new Date("2026-07-24T00:00:00.000Z");
    expect(storage.getFreshGoszakupPlanDetail("100200", 3, now)).toBeNull();
  });

  it("returns null for corrupt JSON, a mismatched id or an unparseable date", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    const now = new Date("2026-07-24T00:00:00.000Z");

    db.prepare("INSERT INTO goszakup_plan_details (plan_point_id, detail_json, fetched_at) VALUES (?, ?, ?)")
      .run("corrupt", "{not json", now.toISOString());
    db.prepare("INSERT INTO goszakup_plan_details (plan_point_id, detail_json, fetched_at) VALUES (?, ?, ?)")
      .run("mismatch", JSON.stringify(planDetail({ plan_point_id: "999" })), now.toISOString());
    db.prepare("INSERT INTO goszakup_plan_details (plan_point_id, detail_json, fetched_at) VALUES (?, ?, ?)")
      .run("baddate", JSON.stringify(planDetail({ plan_point_id: "baddate" })), "not-a-date");

    expect(storage.getFreshGoszakupPlanDetail("corrupt", 3, now)).toBeNull();
    expect(storage.getFreshGoszakupPlanDetail("mismatch", 3, now)).toBeNull();
    expect(storage.getFreshGoszakupPlanDetail("baddate", 3, now)).toBeNull();
  });

  it("overwrites an existing detail on re-upsert", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupPlanDetail(planDetail({ customer_name: "Old" }), "2026-07-24T00:00:00.000Z");
    storage.upsertGoszakupPlanDetail(planDetail({ customer_name: "New" }), "2026-07-24T12:00:00.000Z");

    const now = new Date("2026-07-25T00:00:00.000Z");
    expect(storage.getFreshGoszakupPlanDetail("100200", 3, now)?.customer_name).toBe("New");
  });
});

function planDetail(overrides: Partial<GoszakupPlanDetail> = {}): GoszakupPlanDetail {
  return {
    plan_point_id: "100200",
    customer_bin: "123456789012",
    customer_name: "Test School",
    name_ru: "Панель интерактивная",
    ref_enstru_code: "262011.100.000001",
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

function registryRecord(overrides: Partial<GoszakupRegistryRecord> = {}): GoszakupRegistryRecord {
  return {
    bin: "123456789012",
    participant_id: "42",
    name_ru: "Test Customer",
    name_kz: null,
    rnn: null,
    role: null,
    residency: null,
    phone: null,
    email: "contact@example.kz",
    website: null,
    registration_date: null,
    last_update_date: null,
    kopf: null,
    ownership_form: null,
    economic_sector: null,
    director_name: null,
    director_iin: null,
    legal_address: null,
    location_address: null,
    full_address_ru: null,
    reporting_administrator: null,
    registry_url: "https://goszakup.gov.kz/ru/registry/show_supplier/42",
    updated_at: "2026-06-29T00:00:00.000Z",
    raw_snapshot_path: null,
    ...overrides
  };
}
