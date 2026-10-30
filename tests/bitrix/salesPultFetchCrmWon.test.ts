import { describe, it, expect, vi } from "vitest";
import {
  fetchCrmWonDealsForRegister,
  fetchCrmWonDealsForMonths
} from "../../src/bitrix/salesPult/register/fetchCrmWon.js";
import { reconcileRegisterWithCrmAcrossMonths } from "../../src/bitrix/salesPult/register/history.js";
import type { RegisterRow, RegisterMonthSummary, CrmWonDeal } from "../../src/bitrix/salesPult/register/types.js";
import type { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";
import type { StageTransition } from "../../src/bitrix/salesPult/metrics.js";
import type { UserProfileInfo } from "../../src/bitrix/salesPult/collect.js";
import { matchRegisterWithCrm } from "../../src/bitrix/salesPult/register/matchCrm.js";
import type { RegisterContract } from "../../src/bitrix/salesPult/register/types.js";

describe("fetchCrmWonDealsForRegister", () => {
  it("returns empty array when transitions are empty", async () => {
    const mockClient = { call: vi.fn(), listAllBatched: vi.fn() } as unknown as ReadOnlyBitrixClient;
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
      }),
      listAllBatched: vi.fn()
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

describe("fetchCrmWonDealsForMonths (Block 09 reconciliation)", () => {
  it("fetches > 50 won deals using listAllBatched and stages.contracts without 50-limit capping", async () => {
    // Generate 75 transitions into C9:WON
    const historyItems = Array.from({ length: 75 }, (_, i) => ({
      ID: i + 1,
      OWNER_ID: 1000 + i,
      STAGE_ID: "C9:WON",
      CREATED_TIME: "2026-10-10T12:00:00+05:00"
    }));

    const mockDeals = historyItems.map((h) => ({
      ID: String(h.OWNER_ID),
      TITLE: `Сделка ${h.OWNER_ID}`,
      OPPORTUNITY: 1000000 + (h.OWNER_ID % 10) * 10000,
      COMPANY_ID: "2001",
      ASSIGNED_BY_ID: "147",
      CLOSEDATE: "2026-10-10"
    }));

    const mockClient = {
      listAllBatched: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.stagehistory.list") {
          if (params.filter?.STAGE_ID === "C9:WON") return Promise.resolve(historyItems);
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
      call: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.deal.list") {
          const ids: string[] = params.filter?.ID || [];
          return Promise.resolve(mockDeals.filter((d) => ids.includes(d.ID)));
        }
        if (method === "crm.company.list") {
          return Promise.resolve([{ ID: "2001", TITLE: "КГУ Школа Тест" }]);
        }
        return Promise.resolve([]);
      })
    } as unknown as ReadOnlyBitrixClient;

    const userProfiles = new Map<string, UserProfileInfo>([
      ["147", { id: "147", name: "Бахтияр", active: true }]
    ]);

    const result = await fetchCrmWonDealsForMonths(
      mockClient,
      userProfiles,
      ["2026-10"],
      { contractStages: ["C9:WON", "C41:WON", "C43:WON"] }
    );

    const octDeals = result.get("2026-10") || [];
    expect(octDeals.length).toBe(75);
    expect(octDeals.length).toBeGreaterThan(50);
  });

  it("ignores transitions into stages not in stages.contracts (e.g. C1:WON, C29:WON)", async () => {
    const requestedStages: string[] = [];
    const mockClient = {
      listAllBatched: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.stagehistory.list") {
          requestedStages.push(params.filter?.STAGE_ID);
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
      call: vi.fn().mockResolvedValue([])
    } as unknown as ReadOnlyBitrixClient;

    await fetchCrmWonDealsForMonths(
      mockClient,
      new Map(),
      ["2026-10"],
      { contractStages: ["C9:WON", "C41:WON", "C43:WON"] }
    );

    expect(requestedStages).toEqual(["C9:WON", "C41:WON", "C43:WON"]);
    expect(requestedStages).not.toContain("C1:WON");
    expect(requestedStages).not.toContain("C29:WON");
  });

  it("throws an error when crm.stagehistory.list fails for any stage", async () => {
    const mockClient = {
      listAllBatched: vi.fn().mockRejectedValue(new Error("Network timeout")),
      call: vi.fn().mockResolvedValue([])
    } as unknown as ReadOnlyBitrixClient;

    await expect(
      fetchCrmWonDealsForMonths(mockClient, new Map(), ["2026-10"], { contractStages: ["C9:WON"] })
    ).rejects.toThrow("Ошибка загрузки выигрышей CRM по стадии C9:WON: Network timeout");
  });

  it("deal from October whose amount is close to September contract goes to October when October contract exists", async () => {
    const transitions = [
      {
        ID: 1,
        OWNER_ID: 9001,
        STAGE_ID: "C9:WON",
        CREATED_TIME: "2026-10-02T10:00:00+05:00"
      }
    ];

    const mockClient = {
      listAllBatched: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.stagehistory.list" && params.filter?.STAGE_ID === "C9:WON") {
          return Promise.resolve(transitions);
        }
        return Promise.resolve([]);
      }),
      call: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.deal.list") {
          return Promise.resolve([
            {
              ID: "9001",
              TITLE: "Договор на поставку интерактивных панелей",
              OPPORTUNITY: 2240000,
              COMPANY_ID: "3001",
              ASSIGNED_BY_ID: "147",
              CLOSEDATE: "2026-10-02"
            }
          ]);
        }
        if (method === "crm.company.list") {
          return Promise.resolve([{ ID: "3001", TITLE: "КГУ Школа №30" }]);
        }
        return Promise.resolve([]);
      })
    } as unknown as ReadOnlyBitrixClient;

    const userProfiles = new Map<string, UserProfileInfo>([
      ["147", { id: "147", name: "Бахтияр", active: true }]
    ]);

    const wonByMonth = await fetchCrmWonDealsForMonths(
      mockClient,
      userProfiles,
      ["2026-09", "2026-10"],
      { contractStages: ["C9:WON"] }
    );

    // Deal won on 2026-10-02 belongs to 2026-10 pool
    expect(wonByMonth.get("2026-09") || []).toHaveLength(0);
    expect((wonByMonth.get("2026-10") || []).map((d) => d.id)).toContain("9001");

    // Both September and October have a contract for КГУ Школа №30
    const sepRow: RegisterRow = {
      date: "2026-09-30",
      customer: "КГУ Школа №30",
      manager: "Бахтияр",
      sale: 2000000, // 2,000,000 * 1.12 = 2,240,000
      cost: 1500000,
      extras: 0,
      portal: 2240000,
      val: 500000,
      bonusMop: 0,
      bonusRop: 0,
      qty: 1,
      product: "Панель",
      type: "ом",
      channel: "Запрос",
      group: "ИП",
      kind: "Панели",
      note: null
    };

    const octRow: RegisterRow = {
      date: "2026-10-02",
      customer: "КГУ Школа №30",
      manager: "Бахтияр",
      sale: 2000000,
      cost: 1500000,
      extras: 0,
      portal: 2240000,
      val: 500000,
      bonusMop: 0,
      bonusRop: 0,
      qty: 1,
      product: "Панель",
      type: "ом",
      channel: "Запрос",
      group: "ИП",
      kind: "Панели",
      note: null
    };

    const months: RegisterMonthSummary[] = [
      {
        month: "2026-09",
        label: "Сентябрь 2026",
        fileName: "Реестр 30.09.2026.xlsx",
        sale: 2000000,
        val: 500000,
        margin: 25,
        contracts: 1,
        plan: 0,
        planPct: null,
        hasVal: true,
        byManager: [],
        missingCrm: [],
        reconciliationPerformed: false
      },
      {
        month: "2026-10",
        label: "Октябрь 2026",
        fileName: "Реестр 31.10.2026.xlsx",
        sale: 2000000,
        val: 500000,
        margin: 25,
        contracts: 1,
        plan: 0,
        planPct: null,
        hasVal: true,
        byManager: [],
        missingCrm: [],
        reconciliationPerformed: false
      }
    ];

    const parsedFiles = [
      { fileName: "Реестр 30.09.2026.xlsx", rows: [sepRow] },
      { fileName: "Реестр 31.10.2026.xlsx", rows: [octRow] }
    ];

    reconcileRegisterWithCrmAcrossMonths(months, parsedFiles, wonByMonth);

    // October contract got deal 9001 in Pass 1!
    expect(months[1].missingCrm).toHaveLength(0);
    // September contract could not take deal 9001 because October claimed it
    expect(months[0].missingCrm).toHaveLength(1);
    expect(months[0].missingCrm?.[0].customer).toBe("КГУ Школа №30");
  });

  it("deal from 02.10 closes contract from 30.09 if no October contract exists", async () => {
    const transitions = [
      {
        ID: 1,
        OWNER_ID: 9001,
        STAGE_ID: "C9:WON",
        CREATED_TIME: "2026-10-02T10:00:00+05:00"
      }
    ];

    const mockClient = {
      listAllBatched: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.stagehistory.list" && params.filter?.STAGE_ID === "C9:WON") {
          return Promise.resolve(transitions);
        }
        return Promise.resolve([]);
      }),
      call: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.deal.list") {
          return Promise.resolve([
            {
              ID: "9001",
              TITLE: "Договор на поставку интерактивных панелей",
              OPPORTUNITY: 2240000,
              COMPANY_ID: "3001",
              ASSIGNED_BY_ID: "147",
              CLOSEDATE: "2026-10-02"
            }
          ]);
        }
        if (method === "crm.company.list") {
          return Promise.resolve([{ ID: "3001", TITLE: "КГУ Школа №30" }]);
        }
        return Promise.resolve([]);
      })
    } as unknown as ReadOnlyBitrixClient;

    const userProfiles = new Map<string, UserProfileInfo>([
      ["147", { id: "147", name: "Бахтияр", active: true }]
    ]);

    const wonByMonth = await fetchCrmWonDealsForMonths(
      mockClient,
      userProfiles,
      ["2026-09", "2026-10"],
      { contractStages: ["C9:WON"] }
    );

    const sepRow: RegisterRow = {
      date: "2026-09-30",
      customer: "КГУ Школа №30",
      manager: "Бахтияр",
      sale: 2000000,
      cost: 1500000,
      extras: 0,
      portal: 2240000,
      val: 500000,
      bonusMop: 0,
      bonusRop: 0,
      qty: 1,
      product: "Панель",
      type: "ом",
      channel: "Запрос",
      group: "ИП",
      kind: "Панели",
      note: null
    };

    const months: RegisterMonthSummary[] = [
      {
        month: "2026-09",
        label: "Сентябрь 2026",
        fileName: "Реестр 30.09.2026.xlsx",
        sale: 2000000,
        val: 500000,
        margin: 25,
        contracts: 1,
        plan: 0,
        planPct: null,
        hasVal: true,
        byManager: [],
        missingCrm: [],
        reconciliationPerformed: false
      },
      {
        month: "2026-10",
        label: "Октябрь 2026",
        fileName: "Реестр 31.10.2026.xlsx",
        sale: 0,
        val: 500000,
        margin: 25,
        contracts: 1,
        plan: 0,
        planPct: null,
        hasVal: true,
        byManager: [],
        missingCrm: [],
        reconciliationPerformed: false
      }
    ];

    const parsedFiles = [
      { fileName: "Реестр 30.09.2026.xlsx", rows: [sepRow] },
      { fileName: "Реестр 31.10.2026.xlsx", rows: [] }
    ];

    reconcileRegisterWithCrmAcrossMonths(months, parsedFiles, wonByMonth);

    // Pass 2 matched September contract with October deal 9001 because October had no contracts claiming it!
    expect(months[0].missingCrm).toHaveLength(0);
  });

  it("matches contracts of month M with deals of month M+1 even when month M+1 has no register file yet (Block 09)", () => {
    // In early days of M+1, there is no file for M+1 on Disk yet.
    // Contracts of month M (2026-09) must still see won deals of M+1 (2026-10) in Pass 2.
    const sepRow: RegisterRow = {
      date: "2026-09-30",
      type: "ом",
      extras: 0,
      portal: 0,
      customer: "ТОО Тестовый Заказчик",
      product: "Ноутбуки",
      qty: 1,
      cost: 1500000,
      sale: 2000000,
      val: 500000,
      bonusMop: 0,
      bonusRop: 0,
      manager: "Иванов Иван",
      note: null,
      group: "КТ",
      kind: "Ноутбуки",
      channel: "Запрос"
    };

    const octWonDeal: CrmWonDeal = {
      id: "9002",
      title: "Поставка ноутбуков для ТОО Тестовый Заказчик",
      amount: 2000000,
      company: "ТОО Тестовый Заказчик",
      manager: "Иванов Иван",
      date: "2026-10-02"
    };

    const wonByMonth = new Map<string, CrmWonDeal[]>();
    wonByMonth.set("2026-09", []); // No deals in September
    wonByMonth.set("2026-10", [octWonDeal]); // Deal won on Oct 2nd

    // Only month 2026-09 exists in summaries and parsedFiles; NO file or summary for 2026-10!
    const months: RegisterMonthSummary[] = [
      {
        month: "2026-09",
        label: "Сентябрь 2026",
        fileName: "Реестр 30.09.2026.xlsx",
        sale: 2000000,
        val: 500000,
        margin: 25,
        contracts: 1,
        plan: 0,
        planPct: null,
        hasVal: true,
        byManager: [],
        missingCrm: [],
        reconciliationPerformed: false
      }
    ];

    const parsedFiles = [
      { fileName: "Реестр 30.09.2026.xlsx", rows: [sepRow] }
    ];

    reconcileRegisterWithCrmAcrossMonths(months, parsedFiles, wonByMonth);

    // Pass 2 must match September contract against October deal even without October register file
    expect(months[0].missingCrm).toHaveLength(0);
  });

    it("gives identical matching result for October as block 04 when given October transitions", async () => {
    const octTransitions: StageTransition[] = [
      { id: "1", dealId: "101", stageId: "C9:WON", createdTime: "2026-10-05T10:00:00+05:00" },
      { id: "2", dealId: "102", stageId: "C9:WON", createdTime: "2026-10-12T14:00:00+05:00" }
    ];

    const mockDeals = [
      {
        ID: "101",
        TITLE: "Интерактивная доска",
        OPPORTUNITY: 1120000,
        COMPANY_ID: "501",
        ASSIGNED_BY_ID: "147",
        CLOSEDATE: "2026-10-05"
      },
      {
        ID: "102",
        TITLE: "Моноблоки",
        OPPORTUNITY: 2240000,
        COMPANY_ID: "502",
        ASSIGNED_BY_ID: "559",
        CLOSEDATE: "2026-10-12"
      }
    ];

    const mockClient = {
      listAllBatched: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.stagehistory.list" && params.filter?.STAGE_ID === "C9:WON") {
          return Promise.resolve(
            octTransitions.map((t) => ({
              ID: Number(t.id),
              OWNER_ID: Number(t.dealId),
              STAGE_ID: t.stageId,
              CREATED_TIME: t.createdTime
            }))
          );
        }
        return Promise.resolve([]);
      }),
      call: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === "crm.deal.list") {
          const ids: string[] = params.filter?.ID || [];
          return Promise.resolve(mockDeals.filter((d) => ids.includes(d.ID)));
        }
        if (method === "crm.company.list") {
          return Promise.resolve([
            { ID: "501", TITLE: "КГУ Школа 1" },
            { ID: "502", TITLE: "ГККП Колледж 2" }
          ]);
        }
        return Promise.resolve([]);
      })
    } as unknown as ReadOnlyBitrixClient;

    const userProfiles = new Map<string, UserProfileInfo>([
      ["147", { id: "147", name: "Бахтияр", active: true }],
      ["559", { id: "559", name: "Эльмира", active: true }]
    ]);

    // Block 04 way:
    const block04WonDeals = await fetchCrmWonDealsForRegister(mockClient, octTransitions, userProfiles);

    // New way:
    const wonByMonth = await fetchCrmWonDealsForMonths(
      mockClient,
      userProfiles,
      ["2026-10"],
      { contractStages: ["C9:WON"] }
    );
    const newWonDeals = wonByMonth.get("2026-10") || [];

    const contracts: RegisterContract[] = [
      {
        date: "2026-10-05",
        customer: "КГУ Школа 1",
        manager: "Бахтияр",
        sale: 1000000,
        val: 200000,
        bonusMop: 0,
        bonusRop: 0,
        lines: 1,
        products: ["Панель"],
        type: "ом",
        channel: "Запрос ценовых предложений",
        group: "ИП",
        kind: "Панели",
        qty: 1
      },
      {
        date: "2026-10-20",
        customer: "КГУ Ненайденный Заказчик",
        manager: "Бахтияр",
        sale: 500000,
        val: 100000,
        bonusMop: 0,
        bonusRop: 0,
        lines: 1,
        products: ["Компьютер"],
        type: "ом",
        channel: "Запрос ценовых предложений",
        group: "КТ",
        kind: "Компьютеры",
        qty: 1
      }
    ];

    const match04 = matchRegisterWithCrm(contracts, block04WonDeals);
    const matchNew = matchRegisterWithCrm(contracts, newWonDeals);

    expect(matchNew.matched.length).toBe(match04.matched.length);
    expect(matchNew.missing.length).toBe(match04.missing.length);
    expect(matchNew.missing.map((c) => c.customer)).toEqual(match04.missing.map((c) => c.customer));
  });
});
