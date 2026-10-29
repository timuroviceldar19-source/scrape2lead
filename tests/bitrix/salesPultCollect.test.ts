import { parsePortalSignDate } from "../../src/bitrix/salesPult/collect.js";
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

describe("parsePortalSignDate", () => {
  it("extracts sign date DD.MM.YYYY from outcome comments into YYYY-MM-DD", () => {
    const commentWon = "Итог закупки: договор подписан с нами — договор №991140002353/260055 от 29.09.2026, 4 280 000 ₸.\nОтметьте победу в сделке.";
    expect(parsePortalSignDate(commentWon)).toBe("2026-09-29");

    const commentPartner = 'Итог закупки: выиграл наш партнёр ТОО "Amanat Asia" (БИН 130540000688) — договор №123/45 от 14.10.2026, 120 000 000 ₸.';
    expect(parsePortalSignDate(commentPartner)).toBe("2026-10-14");

    const commentOther = "Обычный комментарий менеджера";
    expect(parsePortalSignDate(commentOther)).toBeNull();
  });
});

describe("collectPultData portal won contracts and mismatches", () => {
  it("fetches won/partner deals, extracts sign date, computes wonOnPortalNotClosed and outcomeMismatches", async () => {
    const call = vi.fn(async (method: string, body: any) => {
      if (method === "batch") {
        const cmd = body?.cmd ?? {};
        const first = Object.values(cmd)[0] as string;
        if (first?.startsWith("crm.deal.list")) {
          if (first.includes("won%3A") || first.includes("won:")) {
            return {
              result: {
                p0: [
                  {
                    ID: "501",
                    TITLE: "[GZ 1001] Школа 1 - Ноутбуки",
                    OPPORTUNITY: "10000000",
                    ASSIGNED_BY_ID: "147",
                    CATEGORY_ID: "9",
                    STAGE_ID: "C9:NEW",
                    STAGE_SEMANTIC_ID: "P",
                    UF_CRM_S2L_GZ_OUTCOME: "won:123/456"
                  },
                  {
                    ID: "502",
                    TITLE: "[GZ 1002] Школа 2 - Компьютеры",
                    OPPORTUNITY: "5000000",
                    ASSIGNED_BY_ID: "147",
                    CATEGORY_ID: "9",
                    STAGE_ID: "C9:LOSE",
                    STAGE_SEMANTIC_ID: "F",
                    UF_CRM_S2L_GZ_OUTCOME: "won:789/012"
                  },
                  {
                    ID: "504",
                    TITLE: "[GZ 1004] Школа 3 - Компьютеры (дубликат)",
                    OPPORTUNITY: "3000000",
                    ASSIGNED_BY_ID: "147",
                    CATEGORY_ID: "41",
                    STAGE_ID: "C41:DUPLICATE",
                    STAGE_SEMANTIC_ID: "F",
                    UF_CRM_S2L_GZ_OUTCOME: "won:555/666"
                  }
                ]
              },
              result_error: {}
            };
          }
          if (first.includes("partner%3A") || first.includes("partner:")) {
            return {
              result: {
                p0: [
                  {
                    ID: "503",
                    TITLE: "[GZ 1003] Колледж 1 - Панели",
                    OPPORTUNITY: "8000000",
                    ASSIGNED_BY_ID: "147",
                    CATEGORY_ID: "9",
                    STAGE_ID: "C9:WON",
                    STAGE_SEMANTIC_ID: "S",
                    UF_CRM_S2L_GZ_OUTCOME: "partner:999/888"
                  }
                ]
              },
              result_error: {}
            };
          }
        }
        if (first?.startsWith("crm.timeline.comment.list")) {
          return {
            result: {
              c501: [
                {
                  ID: "c1",
                  COMMENT: "Итог закупки: договор подписан с нами — договор №101 от 14.10.2026, 10 000 000 ₸.\nОтметьте победу в сделке.",
                  CREATED: "2026-10-14T12:00:00+05:00"
                }
              ],
              c502: [
                {
                  ID: "c2",
                  COMMENT: "Итог закупки: договор подписан с нами — договор №102 от 28.09.2026, 5 000 000 ₸.\nОтметьте победу в сделке.",
                  CREATED: "2026-09-28T12:00:00+05:00"
                }
              ],
              c503: [
                {
                  ID: "c3",
                  COMMENT: 'Итог закупки: выиграл наш партнёр ТОО "Amanat Asia" — договор №103 от 15.10.2026, 8 000 000 ₸.',
                  CREATED: "2026-10-15T12:00:00+05:00"
                }
              ]
            },
            result_error: {}
          };
        }
        return { result: {}, result_error: {} };
      }
      if (method === "crm.deal.list") {
        return [];
      }
      return [];
    });

    const client = new ReadOnlyBitrixClient({ call });
    const data = await collectPultData({
      client,
      fromDate: "2026-10-01",
      toDate: "2026-10-29",
      managerIds: ["147"],
      proposalStages: [],
      contractStages: [],
      nowIso: "2026-10-29T12:00:00+05:00"
    });

    const d501 = data.deals.get("501");
    expect(d501).toBeDefined();
    expect(d501?.portalSignDate).toBe("2026-10-14");
    expect(d501?.outcome).toBe("won:123/456");

    const d503 = data.deals.get("503");
    expect(d503).toBeDefined();
    expect(d503?.portalSignDate).toBe("2026-10-15");

    const debts = data.debtsByManager.get("147");
    expect(debts?.wonOnPortalNotClosed).toBe(1);

    expect(data.outcomeMismatches).toHaveLength(1);
    expect(data.outcomeMismatches[0]).toMatchObject({
      id: "502",
      outcome: "won:789/012",
      portalSignDate: "2026-09-28"
    });
  });
});


describe("collectPultData outcomes, planMonth, and contactedAfterDeadline via batch (Req 1, 2, 5)", () => {
  it("passes outcome and planMonth to debts, and marks overdue tasks contacted after deadline via batch (comment or VOXIMPLANT_CALL)", async () => {
    const activities = [
      { ID: "a1", OWNER_ID: "901", OWNER_TYPE_ID: "2", SUBJECT: "Перезвонить", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "2026-10-25T10:00:00+05:00", PROVIDER_ID: "CRM_TODO" },
      { ID: "a2", OWNER_ID: "902", OWNER_TYPE_ID: "2", SUBJECT: "Перезвонить", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "2026-10-25T10:00:00+05:00", PROVIDER_ID: "CRM_TODO" },
      { ID: "a3", OWNER_ID: "903", OWNER_TYPE_ID: "2", SUBJECT: "Перезвонить", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "2026-10-25T10:00:00+05:00", PROVIDER_ID: "CRM_TODO" },
      { ID: "a4", OWNER_ID: "904", OWNER_TYPE_ID: "2", SUBJECT: "Перезвонить", CREATED: "2026-10-20T09:00:00+05:00", DEADLINE: "2026-10-25T10:00:00+05:00", PROVIDER_ID: "CRM_TODO" }
    ];

    const deals = [
      {
        ID: "901",
        TITLE: "Тест проигрыш на портале",
        OPPORTUNITY: "5000000",
        ASSIGNED_BY_ID: "147",
        CATEGORY_ID: "9",
        STAGE_ID: "C9:UC_KQEL1P",
        UF_CRM_PLAN_STATUS: "Опубликован",
        UF_CRM_S2L_GZ_OUTCOME: "lost:111/222"
      },
      {
        ID: "902",
        TITLE: "Тест план на апрель и коммент после срока",
        OPPORTUNITY: "4000000",
        ASSIGNED_BY_ID: "147",
        CATEGORY_ID: "9",
        STAGE_ID: "C9:UC_KQEL1P",
        UF_CRM_PLAN_STATUS: "Утвержден",
        UF_CRM_1715597726664: "Апрель"
      },
      {
        ID: "903",
        TITLE: "Тест звонок после срока",
        OPPORTUNITY: "3000000",
        ASSIGNED_BY_ID: "147",
        CATEGORY_ID: "9",
        STAGE_ID: "C9:UC_KQEL1P",
        UF_CRM_PLAN_STATUS: "Опубликован"
      },
      {
        ID: "904",
        TITLE: "Тест только коммент робота после срока",
        OPPORTUNITY: "2000000",
        ASSIGNED_BY_ID: "147",
        CATEGORY_ID: "9",
        STAGE_ID: "C9:UC_KQEL1P",
        UF_CRM_PLAN_STATUS: "Опубликован"
      }
    ];

    const call = vi.fn(async (method: string, body: any) => {
      if (method === "batch") {
        const cmd = body?.cmd ?? {};
        const entries = Object.entries(cmd) as Array<[string, string]>;
        const result: Record<string, unknown> = {};
        for (const [k, v] of entries) {
          if (v.startsWith("crm.activity.list") && k === "p0") {
            result[k] = activities;
          } else if (v.startsWith("crm.timeline.comment.list")) {
            if (v.includes("ENTITY_ID%5D=902") || v.includes("ENTITY_ID]=902")) {
              result[k] = [
                { ID: "c1", COMMENT: "Созвонились, ждём публикацию", AUTHOR_ID: "147", CREATED: "2026-10-26T12:00:00+05:00" }
              ];
            } else if (v.includes("ENTITY_ID%5D=904") || v.includes("ENTITY_ID]=904")) {
              result[k] = [
                { ID: "c2", COMMENT: "Автоматический комментарий робота", AUTHOR_ID: "7777", CREATED: "2026-10-26T12:00:00+05:00" },
                { ID: "c3", COMMENT: "Старый коммент до дедлайна", AUTHOR_ID: "147", CREATED: "2026-10-21T12:00:00+05:00" }
              ];
            } else {
              result[k] = [];
            }
          } else if (v.startsWith("crm.activity.list") && v.includes("VOXIMPLANT_CALL")) {
            if (v.includes("OWNER_ID%5D=903") || v.includes("OWNER_ID]=903")) {
              result[k] = [
                { ID: "v1", OWNER_ID: "903", PROVIDER_ID: "VOXIMPLANT_CALL", CREATED: "2026-10-26T15:00:00+05:00", START_TIME: "2026-10-26T15:00:00+05:00" }
              ];
            } else {
              result[k] = [];
            }
          } else {
            result[k] = [];
          }
        }
        return { result, result_error: {} };
      }
      if (method === "crm.deal.list") {
        return deals.filter((d) => (body.filter.ID as string[]).includes(d.ID));
      }
      return [];
    });

    const data = await collectPultData({
      client: new ReadOnlyBitrixClient({ call }),
      fromDate: "2026-10-01",
      toDate: "2026-10-28",
      managerIds: ["147"],
      proposalStages: [],
      contractStages: [],
      nowIso: "2026-10-28T15:00:00+05:00",
      webhookUserId: "7777"
    });

    const debts = data.debtsByManager.get("147");
    expect(debts?.readyToCloseDealIds).toEqual(["901"]);
    expect(debts?.overdue).toBe(3);

    const top = data.tasksByManager.get("147") ?? [];
    expect(top.map((t) => t.dealId)).toEqual(["903", "904", "902"]);

    const t902 = top.find((t) => t.dealId === "902");
    expect(t902?.passedPlanMonthNote).toBe("план на апрель прошёл");
    expect(t902?.contactedAfterDeadlineNote).toBe("связался — закрыть дело / поставить следующий шаг");
    expect(t902?.lastComment).toBe("Созвонились, ждём публикацию");

    const t903 = top.find((t) => t.dealId === "903");
    expect(t903?.contactedAfterDeadlineNote).toBe("связался — закрыть дело / поставить следующий шаг");

    const t904 = top.find((t) => t.dealId === "904");
    expect(t904?.contactedAfterDeadlineNote).toBeNull();
    expect(t904?.lastComment).toBe("Старый коммент до дедлайна");
  });
});
