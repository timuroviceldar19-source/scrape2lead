import { describe, expect, it, vi } from "vitest";
import { planProcurementPush } from "../../src/bitrix/procurementPush.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

describe("planProcurementPush", () => {
  it("plans creates, linked updates and duplicate blocks without writing", async () => {
    const client = {
      findByOrigin: vi.fn(async (_originator: string, originId: string) => originId.endsWith(":plan:parent")
        ? { ID: "700", CATEGORY_ID: "1", STAGE_ID: "C1:UC_XMKT7F" } : null),
      findPotentialDuplicate: vi.fn(async (record: ProcurementRecord) => record.externalId === "dup" ? { ID: "701" } : null),
      addDeal: vi.fn(), updateDeal: vi.fn()
    };
    const result = await planProcurementPush([
      row({ externalId: "new" }),
      row({ recordKind: "tender", externalId: "published", parentExternalId: "parent" }),
      row({ externalId: "dup" })
    ], client, { execute: false });

    expect(result.items.map((item) => item.action)).toEqual(["create", "update", "duplicate"]);
    expect(result.counts).toEqual({ create: 1, update: 1, duplicate: 1, failed: 0 });
    expect(client.addDeal).not.toHaveBeenCalled();
    expect(client.updateDeal).not.toHaveBeenCalled();
  });

  it("executes only create/update items and never resets a manual stage", async () => {
    const client = {
      findByOrigin: vi.fn(async (_originator: string, originId: string) => originId.endsWith(":plan:parent")
        ? { ID: "700", CATEGORY_ID: "1", STAGE_ID: "C1:UC_XMKT7F" } : null),
      findPotentialDuplicate: vi.fn(async () => null),
      addDeal: vi.fn(async (_fields: Record<string, unknown>) => "900"),
      updateDeal: vi.fn(async (_id: string, _fields: Record<string, unknown>) => undefined)
    };
    const result = await planProcurementPush([
      row({ externalId: "new" }),
      row({ recordKind: "tender", externalId: "published", parentExternalId: "parent" })
    ], client, { execute: true });
    expect(result.counts).toMatchObject({ create: 1, update: 1, failed: 0 });
    expect(client.addDeal.mock.calls[0]?.[0]).not.toHaveProperty("ASSIGNED_BY_ID");
    expect(client.updateDeal.mock.calls[0]?.[1]).not.toHaveProperty("STAGE_ID");
  });
});

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return { source: "mitwork", recordKind: "plan", externalId: "42", parentExternalId: null, status: "Утвержден",
    productName: "Ноутбук", description: "", truCode: "262011.100.000002", customerName: "Buyer",
    customerBin: "123456789012", amount: 1_000_000, currency: "KZT", startDate: null, endDate: null,
    url: "https://example.kz/42", purchaseMethod: null, collectedAt: "2026-07-21T00:00:00Z", ...overrides };
}
