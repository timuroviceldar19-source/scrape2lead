import { describe, expect, it, vi } from "vitest";
import {
  ReadOnlyBitrixClient,
  flattenBitrixParams
} from "../../src/bitrix/reporting/readOnlyClient.js";

describe("ReadOnlyBitrixClient", () => {
  it("rejects mutation methods before they reach the transport", async () => {
    const call = vi.fn();
    const client = new ReadOnlyBitrixClient({ call });

    await expect(client.call("crm.deal.update", { id: 1 })).rejects.toThrow(/read-only/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a batch that contains a mutating subcommand", async () => {
    const call = vi.fn();
    const client = new ReadOnlyBitrixClient({ call });

    await expect(client.call("batch", {
      cmd: { safe: "crm.deal.list?start=0", unsafe: "crm.deal.delete?id=1" }
    })).rejects.toThrow(/crm\.deal\.delete/);
    expect(call).not.toHaveBeenCalled();
  });

  it("reads array and nested-items list methods through 50-command batches", async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) => ({ ID: String(index + 1) }));
    const call = vi.fn(async (_method: string, body: unknown) => {
      const commands = Object.keys((body as { cmd: Record<string, string> }).cmd);
      return {
        result: Object.fromEntries(commands.map((key, index) => [
          key,
          index === 0 ? { items: fullPage } : { items: index === 1 ? [{ ID: "51" }] : [] }
        ])),
        result_error: {}
      };
    });
    const client = new ReadOnlyBitrixClient({ call });

    const rows = await client.listAllBatched("crm.stagehistory.list", {
      entityTypeId: 2,
      order: { ID: "ASC" },
      select: ["ID"]
    }, "items");

    expect(rows).toHaveLength(51);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("flattens nested Bitrix parameters without leaking malformed query syntax", () => {
    expect(flattenBitrixParams({
      order: { ID: "ASC" },
      select: ["ID", "TITLE"],
      filter: { CATEGORY_ID: 9 }
    })).toBe("order%5BID%5D=ASC&select%5B0%5D=ID&select%5B1%5D=TITLE&filter%5BCATEGORY_ID%5D=9");
  });
});

