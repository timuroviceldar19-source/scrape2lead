import { describe, expect, it, vi } from "vitest";
import { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import {
  collectPultData,
  fetchDealsBatched,
  fetchLatestComment,
  isServiceComment,
  type CollectPultDataParams
} from "../../src/bitrix/salesPult/collect.js";

describe("salesPultCollect", () => {
  it("ReadOnlyBitrixClient strictly rejects any mutating method", async () => {
    const call = vi.fn();
    const client = new ReadOnlyBitrixClient({ call });

    await expect(client.call("crm.deal.add", {})).rejects.toThrow(/read-only/i);
    await expect(client.call("crm.deal.update", {})).rejects.toThrow(/read-only/i);
    await expect(client.call("crm.activity.delete", {})).rejects.toThrow(/read-only/i);
    await expect(client.call("im.message.add", {})).rejects.toThrow(/read-only/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("fetches deals in chunks of at most 50 IDs", async () => {
    const requestedChunks: string[][] = [];
    const client = {
      call: vi.fn(async (method: string, params: any) => {
        if (method === "crm.deal.list") {
          requestedChunks.push(params.filter.ID);
          return (params.filter.ID as string[]).map((id) => ({
            ID: id,
            TITLE: `Deal ${id}`,
            OPPORTUNITY: "1000",
            ASSIGNED_BY_ID: "147"
          }));
        }
        return [];
      })
    } as unknown as ReadOnlyBitrixClient;

    const ids = Array.from({ length: 125 }, (_, i) => String(i + 1));
    const deals = await fetchDealsBatched(client, ids);

    expect(deals.size).toBe(125);
    expect(requestedChunks).toHaveLength(3); // 50 + 50 + 25
    expect(requestedChunks[0]).toHaveLength(50);
    expect(requestedChunks[1]).toHaveLength(50);
    expect(requestedChunks[2]).toHaveLength(25);
  });

  it("gracefully catches telephony insufficient_scope and marks calls unavailable", async () => {
    const call = vi.fn(async (method: string, body: any) => {
      if (method === "batch") {
        const cmd = body?.cmd ?? {};
        const firstCmd = Object.values(cmd)[0] as string;
        if (firstCmd?.startsWith("voximplant.statistic.get")) {
          return {
            result: {},
            result_error: {
              p0: { error: "insufficient_scope", error_description: "The method requires telephony scope" }
            }
          };
        }
        return { result: {}, result_error: {} };
      }
      return [];
    });
    const client = new ReadOnlyBitrixClient({ call });

    const params: CollectPultDataParams = {
      client,
      fromDate: "2026-10-01",
      toDate: "2026-10-28",
      managerIds: ["147"],
      proposalStages: ["C9:UC_O85E7B"],
      contractStages: ["C9:WON"]
    };

    const data = await collectPultData(params);
    expect(data.callsAvailable).toBe(false);
    expect(data.calls).toHaveLength(0);
    expect(data.callsError).toContain("telephony");
  });

  it("rethrows any non-insufficient_scope error from telephony to crash the run", async () => {
    const call = vi.fn(async (method: string, body: any) => {
      if (method === "batch") {
        const cmd = body?.cmd ?? {};
        const firstCmd = Object.values(cmd)[0] as string;
        if (firstCmd?.startsWith("voximplant.statistic.get")) {
          throw new Error("Internal Server Error 500: database connection failed");
        }
        return { result: {}, result_error: {} };
      }
      return [];
    });
    const client = new ReadOnlyBitrixClient({ call });

    const params: CollectPultDataParams = {
      client,
      fromDate: "2026-10-01",
      toDate: "2026-10-28",
      managerIds: ["147"],
      proposalStages: ["C9:UC_O85E7B"],
      contractStages: ["C9:WON"]
    };

    await expect(collectPultData(params)).rejects.toThrow("Internal Server Error 500");
  });

  it("filters out service comments and webhook bot comments in fetchLatestComment", async () => {
    expect(isServiceComment("Досье заказчика БИН 12345", "147", "2301")).toBe(true);
    expect(isServiceComment("[B]Досье заказчика[/B] ...", "147", "2301")).toBe(true);
    expect(isServiceComment("[P]Ранее была направлена жалоба", "147", "2301")).toBe(true);
    expect(isServiceComment("Итог закупки: выиграли", "147", "2301")).toBe(true);
    expect(isServiceComment("Произвольный коммент", "2301", "2301")).toBe(true); // from webhook user
    expect(isServiceComment("договор согласован с клиентом", "147", "2301")).toBe(false);

    const call = vi.fn(async (method: string) => {
      if (method === "crm.timeline.comment.list") {
        return [
          { ID: "3", COMMENT: "[B]Досье заказчика[/B] 12345", AUTHOR_ID: "2301" },
          { ID: "2", COMMENT: "Итог закупки: победил поставщик", AUTHOR_ID: "147" },
          { ID: "1", COMMENT: "ссылка-договор буйырса", AUTHOR_ID: "147" }
        ];
      }
      return [];
    });
    const client = new ReadOnlyBitrixClient({ call });

    const comment = await fetchLatestComment(client, "46255", "2301");
    expect(comment).toBe("ссылка-договор буйырса");
  });

  it("records activity load errors in taskErrorsByManager without throwing", async () => {
    const call = vi.fn(async (method: string, body: any) => {
      if (method === "batch") {
        const cmd = body?.cmd ?? {};
        const firstCmd = Object.values(cmd)[0] as string;
        if (firstCmd?.startsWith("crm.activity.list")) {
          throw new Error("Activity API timeout");
        }
        return { result: {}, result_error: {} };
      }
      return [];
    });
    const client = new ReadOnlyBitrixClient({ call });

    const params: CollectPultDataParams = {
      client,
      fromDate: "2026-10-01",
      toDate: "2026-10-28",
      managerIds: ["147"],
      proposalStages: [],
      contractStages: []
    };

    const data = await collectPultData(params);
    expect(data.taskErrorsByManager.get("147")).toContain("Activity API timeout");
  });
  it("logs console.warn with deal ID when fetchLatestComment fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const call = vi.fn(async () => {
      throw new Error("Network timeout");
    });
    const client = new ReadOnlyBitrixClient({ call });

    const comment = await fetchLatestComment(client, "998877", "2301");
    expect(comment).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("998877"),
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });
});
