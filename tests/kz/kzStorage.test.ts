import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { KzStorage } from "../../src/kz/kzStorage.js";
import type { GoszakupRegistryRecord } from "../../src/kz/registryTypes.js";
import type { StatGovRecord, TenderRecord } from "../../src/kz/tenderTypes.js";

describe("KzStorage", () => {
  it("builds company cards with tender aggregates", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertStatGov(company("100000000001", "Alpha"));
    storage.upsertStatGov(company("100000000002", "Beta"));
    storage.upsertTenders([
      tender("zakup.sk.kz", "100000000001", "A-1", "PUBLISHED", "1000", "2026-06-10"),
      tender("goszakup.gov.kz", "100000000001", "A-2", "closed", "2500.50", "2026-06-12"),
      tender("zakup.sk.kz", "100000000002", "B-1", "ACTIVE", null, null)
    ]);

    const alpha = storage.getCompanyCards(["100000000001"])[0];
    expect(alpha.tender_count_total).toBe(2);
    expect(alpha.tender_count_active).toBe(1);
    expect(alpha.tender_budget_sum).toBe(3500.5);
    expect(alpha.tender_sources.split(",").sort()).toEqual(["goszakup.gov.kz", "zakup.sk.kz"]);
    expect(alpha.last_tender_end_date).toBe("2026-06-12");

    const beta = storage.getCompanyCards(["100000000002"])[0];
    expect(beta.tender_count_total).toBe(1);
    expect(beta.tender_count_active).toBe(1);
    expect(beta.tender_budget_sum).toBeNull();

    db.close();
  });

  it("counts goszakup HTML contract statuses as active", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertStatGov(company("100000000005", "ContractCo"));
    storage.upsertTenders([
      tender("goszakup.gov.kz", "100000000005", "C-1", "Действует", "1000", "2026-12-01"),
      tender("goszakup.gov.kz", "100000000005", "C-2", "Исполнен", "2000", "2026-01-01"),
      tender("goszakup.gov.kz", "100000000005", "C-3", "Изменен", "500", "2026-12-15")
    ]);

    const card = storage.getCompanyCards(["100000000005"])[0];
    expect(card.tender_count_total).toBe(3);
    expect(card.tender_count_active).toBe(2);

    db.close();
  });

  it("checks stat.gov TTL freshness from updated_at", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertStatGov({
      ...company("100000000003", "FreshCo"),
      updated_at: "2026-06-01T00:00:00.000Z"
    });

    expect(storage.isStatGovFresh("100000000003", 7, new Date("2026-06-07T00:00:00.000Z"))).toBe(true);
    expect(storage.isStatGovFresh("100000000003", 3, new Date("2026-06-07T00:00:00.000Z"))).toBe(false);
    expect(storage.isStatGovFresh("missing", 7, new Date("2026-06-07T00:00:00.000Z"))).toBe(false);

    db.close();
  });

  it("records enrich errors", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });

    storage.recordEnrichError("100000000004", "stat_gov", "timeout");

    expect(storage.getEnrichErrors()[0]).toMatchObject({
      bin: "100000000004",
      stage: "stat_gov",
      message: "timeout"
    });

    db.close();
  });

  it("includes registry-only BIN in company cards", () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupRegistry({
      bin: "241240019455",
      participant_id: "12345",
      name_ru: "ТОО ALATAU STROY 2030",
      name_kz: null,
      rnn: null,
      role: "Поставщик",
      residency: null,
      phone: "+77072454647",
      email: "torekhanuly_m@mail.ru",
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
      registry_url: "https://goszakup.gov.kz/ru/registry/show_supplier/12345",
      updated_at: "2026-06-07T00:00:00.000Z",
      raw_snapshot_path: null
    });
    const cards = storage.getCompanyCards(["241240019455"]);
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe("ТОО ALATAU STROY 2030");
    expect(cards[0].registry_phone).toBe("+77072454647");
    expect(cards[0].participant_id).toBe("12345");
    db.close();
  });
});

function company(bin: string, name: string): StatGovRecord {
  return {
    bin,
    name,
    registration_date: "2026-01-01",
    oked: "12345",
    oked_name: "Test activity",
    address: "Almaty",
    director: "Director",
    legal_status: "unknown",
    krp_code: null,
    krp_name: null,
    kfs_code: null,
    kfs_name: null,
    sector_code: null,
    sector_name: null,
    updated_at: "2026-06-07T00:00:00.000Z",
    raw_snapshot_path: null
  };
}

function tender(
  source: TenderRecord["source"],
  bin: string,
  number: string,
  status: string,
  budget: string | null,
  endDate: string | null
): TenderRecord {
  return {
    source,
    bin,
    tender_number: number,
    tender_name: `Tender ${number}`,
    customer_name: "Customer",
    budget_amount: budget,
    currency: "KZT",
    start_date: null,
    end_date: endDate,
    status,
    method: "auction",
    url: null,
    parsed_at: "2026-06-07T00:00:00.000Z"
  };
}
