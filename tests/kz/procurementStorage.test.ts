import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ProcurementStorage } from "../../src/kz/procurement/storage.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

describe("ProcurementStorage", () => {
  it("upserts by source, record kind and external id", () => {
    const storage = new ProcurementStorage({ db: new Database(":memory:") });
    storage.upsert(row({ status: "Утвержден", amount: 1_000_000 }));
    storage.upsert(row({ status: "Опубликован", amount: 1_200_000 }));

    expect(storage.list()).toHaveLength(1);
    expect(storage.list()[0]?.sourceRecordId).toBe("219");
    expect(storage.list()[0]).toMatchObject({ status: "Опубликован", amount: 1_200_000 });
  });

  it("keeps the same external id from another source or kind separate", () => {
    const storage = new ProcurementStorage({ db: new Database(":memory:") });
    storage.upsert(row());
    storage.upsert(row({ source: "samruk" }));
    storage.upsert(row({ recordKind: "tender" }));
    expect(storage.list()).toHaveLength(3);
  });

  it("round-trips optional plan detail JSON", () => {
    const storage = new ProcurementStorage({ db: new Database(":memory:") });
    storage.upsert(row({ planDetail: { approvedAt: "2026-04-15", financialYear: 2026, nameRu: "Ноутбук",
      nameKk: "Ноутбук", shortDescriptionRu: "Описание", shortDescriptionKk: null, extraDescription: null,
      unitName: "Штука", quantity: 4, unitPrice: 250_000, prepaymentPercent: null, deliveryDeadline: null,
      itemType: "Товар", deliveries: [{ address: "Астана", kato: "710000000", quantity: 4 }] } }));
    expect(storage.list()[0]?.planDetail).toMatchObject({ financialYear: 2026, quantity: 4,
      deliveries: [{ address: "Астана", kato: "710000000", quantity: 4 }] });
  });
});

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return {
    source: "mitwork", recordKind: "plan", sourceRecordId: "219", externalId: "42", parentExternalId: null,
    status: "Утвержден", productName: "Ноутбук", description: "", truCode: "262011.100.000002",
    customerName: "Customer", customerBin: "123456789012", amount: 1_000_000, currency: "KZT",
    startDate: null, endDate: null, url: "https://example.kz/42", purchaseMethod: null,
    collectedAt: "2026-07-21T00:00:00.000Z", ...overrides
  };
}
