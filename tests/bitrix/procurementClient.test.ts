import { describe, expect, it, vi } from "vitest";
import type { BitrixClient } from "../../src/bitrix/client.js";
import { ProcurementBitrixClient } from "../../src/bitrix/procurementClient.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";

describe("ProcurementBitrixClient duplicate checks", () => {
  it("finds cross-source duplicates by BIN, amount and similar title", async () => {
    const transport = { listAll: vi.fn(async () => [{
      ID: "55", TITLE: "Ноутбук для ТОО Заказчик", COMMENTS: "БИН: 123456789012"
    }]) } as unknown as BitrixClient;
    const client = new ProcurementBitrixClient(transport);
    await expect(client.findPotentialDuplicate(row())).resolves.toMatchObject({ ID: "55" });
  });

  it("does not block an unrelated deal that merely has the same amount", async () => {
    const transport = { listAll: vi.fn(async () => [{ ID: "56", TITLE: "Мебель для офиса", COMMENTS: "" }]) } as unknown as BitrixClient;
    await expect(new ProcurementBitrixClient(transport).findPotentialDuplicate(row())).resolves.toBeNull();
  });
});

function row(): ProcurementRecord {
  return { source: "mitwork", recordKind: "plan", externalId: "MTW-1", parentExternalId: null, status: "Утвержден",
    productName: "Ноутбук", description: "", truCode: "262011.100.000002", customerName: "ТОО Заказчик",
    customerBin: "123456789012", amount: 1_000_000, currency: "KZT", startDate: null, endDate: null,
    url: "https://example.kz/1", purchaseMethod: null, collectedAt: "2026-07-21T00:00:00Z" };
}
