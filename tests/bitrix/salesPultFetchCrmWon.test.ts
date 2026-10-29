import { describe, it, expect, vi } from "vitest";
import { fetchCrmWonDealsForRegister } from "../../src/bitrix/salesPult/register/fetchCrmWon.js";
import type { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import type { StageTransition } from "../../src/bitrix/salesPult/metrics.js";
import type { UserProfileInfo } from "../../src/bitrix/salesPult/collect.js";

describe("fetchCrmWonDealsForRegister", () => {
  it("returns empty array when transitions are empty", async () => {
    const mockClient = { call: vi.fn() } as unknown as ReadOnlyBitrixClient;
    const res = await fetchCrmWonDealsForRegister(mockClient, [], new Map());
    expect(res).toEqual([]);
    expect(mockClient.call).not.toHaveBeenCalled();
  });

  it("fetches deals and companies and joins manager profiles", async () => {
    const transitions: StageTransition[] = [
      { id: "1", dealId: "101", stageId: "WON", createdTime: "2026-10-15T10:00:00+05:00" },
      { id: "2", dealId: "102", stageId: "WON", createdTime: "2026-10-16T11:00:00+05:00" }
    ];

    const userProfiles = new Map<string, UserProfileInfo>([
      ["147", { id: "147", name: "Бахтияр", active: true }],
      ["559", { id: "559", name: "Эльмира", active: true }]
    ]);

    const mockClient = {
      call: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.deal.list") {
          return Promise.resolve([
            {
              ID: "101",
              TITLE: "Поставка панелей для школы №5",
              OPPORTUNITY: 2500000,
              COMPANY_ID: "501",
              ASSIGNED_BY_ID: "147",
              CLOSEDATE: "2026-10-15"
            },
            {
              ID: "102",
              TITLE: "Компьютеры для колледжа",
              OPPORTUNITY: 1800000,
              COMPANY_ID: "502",
              ASSIGNED_BY_ID: "559",
              CLOSEDATE: "2026-10-16"
            }
          ]);
        }
        if (method === "crm.company.list") {
          return Promise.resolve([
            { ID: "501", TITLE: "КГУ Школа №5" },
            { ID: "502", TITLE: "ГККП Высший колледж" }
          ]);
        }
        return Promise.resolve([]);
      })
    } as unknown as ReadOnlyBitrixClient;

    const res = await fetchCrmWonDealsForRegister(mockClient, transitions, userProfiles);
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({
      id: "101",
      title: "Поставка панелей для школы №5",
      company: "КГУ Школа №5",
      amount: 2500000,
      manager: "Бахтияр",
      date: "2026-10-15"
    });
    expect(res[1]).toEqual({
      id: "102",
      title: "Компьютеры для колледжа",
      company: "ГККП Высший колледж",
      amount: 1800000,
      manager: "Эльмира",
      date: "2026-10-16"
    });
  });
});
