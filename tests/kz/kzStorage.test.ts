import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { KzStorage } from "../../src/kz/kzStorage.js";
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
