import { describe, expect, it, vi } from "vitest";
import { planProcurementPush } from "../../src/bitrix/procurementPush.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";
import { EMPTY_PLAN_PERIOD } from "../../src/kz/procurement/planPeriod.js";

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

  it("links the resolved customer company on create and fills it on an update that lacks one", async () => {
    const client = {
      findByOrigin: vi.fn(async (_originator: string, originId: string) => {
        if (originId.endsWith(":plan:parent")) return { ID: "700", CATEGORY_ID: "1", STAGE_ID: "C1:NEW", COMPANY_ID: "0" };
        if (originId.endsWith(":plan:linked")) return { ID: "701", CATEGORY_ID: "1", STAGE_ID: "C1:NEW", COMPANY_ID: "77" };
        return null;
      }),
      findPotentialDuplicate: vi.fn(async () => null),
      addDeal: vi.fn(async (_fields: Record<string, unknown>) => "900"),
      updateDeal: vi.fn(async (_id: string, _fields: Record<string, unknown>) => undefined)
    };
    const resolveCustomer = vi.fn(async () => ({ action: "create" as const, companyId: "555", warning: null }));
    const result = await planProcurementPush([
      row({ externalId: "new" }),
      row({ recordKind: "tender", externalId: "published", parentExternalId: "parent" }),
      row({ recordKind: "tender", externalId: "other", parentExternalId: "linked" })
    ], client, { execute: true, resolveCustomer });

    expect(client.addDeal.mock.calls[0]?.[0]).toMatchObject({ COMPANY_ID: "555" });
    expect(client.updateDeal.mock.calls[0]?.[1]).toMatchObject({ COMPANY_ID: "555" });
    expect(client.updateDeal.mock.calls[1]?.[1]).not.toHaveProperty("COMPANY_ID");
    expect(resolveCustomer).toHaveBeenCalledTimes(2);
    expect(result.items[0]?.customer).toEqual({ action: "create", companyId: "555", warning: null });
  });

  it("keeps the deal when the customer lookup fails and reports the reason", async () => {
    const client = {
      findByOrigin: vi.fn(async () => null),
      findPotentialDuplicate: vi.fn(async () => null),
      addDeal: vi.fn(async (_fields: Record<string, unknown>) => "901"),
      updateDeal: vi.fn()
    };
    const result = await planProcurementPush([row()], client, {
      execute: true, resolveCustomer: async () => { throw new Error("bitrix company list failed"); }
    });
    expect(result.counts).toMatchObject({ create: 1, failed: 0 });
    expect(client.addDeal.mock.calls[0]?.[0]).not.toHaveProperty("COMPANY_ID");
    expect(result.items[0]?.customer?.warning).toContain("bitrix company list failed");
  });
});

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return { source: "mitwork", recordKind: "plan", externalId: "42", parentExternalId: null, status: "Утвержден",
    productName: "Ноутбук", description: "", truCode: "262011.100.000002", customerName: "Buyer",
    customerBin: "123456789012", amount: 1_000_000, currency: "KZT", startDate: null, endDate: null,
    url: "https://example.kz/42", purchaseMethod: null, ...EMPTY_PLAN_PERIOD,
    collectedAt: "2026-07-21T00:00:00Z", ...overrides };
}
