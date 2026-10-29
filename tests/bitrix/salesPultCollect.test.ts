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

  it("re-attributes tasks and debts to deal.assignedById when present in pult, adding note «дело на <имя>»", async () => {
    const call = vi.fn(async (method: string, body: any) => {
      if (method === "im.user.get") {
        if (body.ID === 205) return { name: "Жанат Какимжанов", active: true };
        if (body.ID === 2345) return { name: "Турар Кожанов", active: true };
        return { name: `Менеджер ${body.ID}`, active: true };
      }
      if (method === "batch") {
        const cmd = body?.cmd ?? {};
        const firstCmd = Object.values(cmd)[0] as string;
        if (firstCmd?.includes("crm.activity.list")) {
          // If query for 205, return activity on deal 48517
          if (firstCmd.includes("RESPONSIBLE_ID%5D=205") || firstCmd.includes("RESPONSIBLE_ID]=205")) {
            return {
              result: {
                p0: [
                  {
                    ID: "150543",
                    OWNER_ID: "48517",
                    OWNER_TYPE_ID: 2,
                    RESPONSIBLE_ID: 205,
                    SUBJECT: "Связаться с клиентом",
                    CREATED: "2026-10-27T10:00:00+05:00",
                    DEADLINE: "2026-10-27T10:00:00+05:00",
                    PROVIDER_ID: "CRM_TODO"
                  }
                ]
              },
              result_error: {}
            };
          }
          // For 2345: no direct activities
          return { result: { p0: [] }, result_error: {} };
        }
        return { result: {}, result_error: {} };
      }
      if (method === "crm.deal.list") {
        return [
          {
            ID: "48517",
            TITLE: "[GZ 88181747] Жасыл даму — Ноутбук",
            OPPORTUNITY: "74250000",
            ASSIGNED_BY_ID: "2345",
            CATEGORY_ID: "9",
            STAGE_ID: "C9:UC_KQEL1P",
            CLOSED: "N",
            STAGE_SEMANTIC_ID: "P",
            UF_CRM_PLAN_STATUS: "Опубликован"
          }
        ];
      }
      return [];
    });

    const client = new ReadOnlyBitrixClient({ call });
    const data = await collectPultData({
      client,
      fromDate: "2026-10-20",
      toDate: "2026-10-29",
      managerIds: ["205", "2345"],
      proposalStages: [],
      contractStages: [],
      nowIso: "2026-10-29T12:00:00+05:00"
    });

    // 205 has NO tasks and NO debts for this deal
    expect(data.tasksByManager.get("205")).toEqual([]);
    expect(data.debtsByManager.get("205")?.newDeals).toBe(0);

    // 2345 gets the task with note «дело на Жанате» and debts
    const turarTasks = data.tasksByManager.get("2345") ?? [];
    expect(turarTasks).toHaveLength(1);
    expect(turarTasks[0].dealId).toBe("48517");
    expect(turarTasks[0].responsibleNote).toBe("дело на Жанате");
    expect(data.debtsByManager.get("2345")?.newDeals).toBe(1);
  });

  it("does not include closed deals (e.g. C9:9 with CLOSED=Y) in tasks or debts", async () => {
    const call = vi.fn(async (method: string, body: any) => {
      if (method === "im.user.get") {
        return { name: `Менеджер ${body.ID}`, active: true };
      }
      if (method === "batch") {
        const cmd = body?.cmd ?? {};
        const firstCmd = Object.values(cmd)[0] as string;
        if (firstCmd?.includes("crm.activity.list")) {
          return {
            result: {
              p0: [
                {
                  ID: "150543",
                  OWNER_ID: "48517",
                  OWNER_TYPE_ID: 2,
                  RESPONSIBLE_ID: 2345,
                  SUBJECT: "Связаться с клиентом",
                  CREATED: "2026-10-27T10:00:00+05:00",
                  DEADLINE: "2026-10-27T10:00:00+05:00",
                  PROVIDER_ID: "CRM_TODO"
                }
              ]
            },
            result_error: {}
          };
        }
        return { result: {}, result_error: {} };
      }
      if (method === "crm.deal.list") {
        return [
          {
            ID: "48517",
            TITLE: "[GZ 88181747] Жасыл даму — Ноутбук",
            OPPORTUNITY: "74250000",
            ASSIGNED_BY_ID: "2345",
            CATEGORY_ID: "9",
            STAGE_ID: "C9:9",
            CLOSED: "Y",
            STAGE_SEMANTIC_ID: "F",
            UF_CRM_PLAN_STATUS: "Закупка состоялась"
          }
        ];
      }
      return [];
    });

    const client = new ReadOnlyBitrixClient({ call });
    const data = await collectPultData({
      client,
      fromDate: "2026-10-20",
      toDate: "2026-10-29",
      managerIds: ["2345"],
      proposalStages: [],
      contractStages: [],
      nowIso: "2026-10-29T12:00:00+05:00"
    });

    expect(data.tasksByManager.get("2345")).toEqual([]);
    expect(data.debtsByManager.get("2345")?.newDeals).toBe(0);
    expect(data.debtsByManager.get("2345")?.overdue).toBe(0);
  });
});
