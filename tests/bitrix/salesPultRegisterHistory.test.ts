import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";
import {
  buildRegisterMonthSummary,
  matchPortalContracts1to1,
  detectRegisterDiscipline,
  getLastDayOfMonth,
  resolveGroupSupplierOrgIds,
  loadStoredRegisterHistory,
  saveRegisterHistory,
  buildFullRegisterHistory,
  searchOrganizationByBin,
  fetchPortalContractsForMonths,
  type PortalContractInput
} from "../../src/bitrix/salesPult/register/history.js";
import { fetchRegisterFilesFromDisk } from "../../src/bitrix/salesPult/register/diskClient.js";
import { recordRegisterHistoryAttempt, loadRegisterHistoryAttempt } from "../../src/bitrix/salesPult/register/crypto.js";
import type { RegisterRow } from "../../src/bitrix/salesPult/register/types.js";
import { groupRegisterContracts } from "../../src/bitrix/salesPult/register/matchCrm.js";
import { loadRegisterView } from "../../src/bitrix/salesPult/register/load.js";
import {
  renderPultHtml,
  renderRegisterHtml,
  type SalesPultPayload,
  type RegisterPagePayload
} from "../../src/bitrix/salesPult/site.js";
import type { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";

describe("getLastDayOfMonth", () => {
  it("returns exact calendar last day for each month", () => {
    expect(getLastDayOfMonth("2026-07")).toBe("2026-07-31");
    expect(getLastDayOfMonth("2026-08")).toBe("2026-08-31");
    expect(getLastDayOfMonth("2026-09")).toBe("2026-09-30");
    expect(getLastDayOfMonth("2026-10")).toBe("2026-10-31");
    expect(getLastDayOfMonth("2026-02")).toBe("2026-02-28");
  });
});

describe("resolveGroupSupplierOrgIds", () => {
  it("resolves org IDs from config and org cache without hardcoding", async () => {
    const orgsCache = { "54283": "061140003942", "42071": "130540000688" };
    const outcomesConfig = { ourBins: ["061140003942"], partnerBins: ["130540000688"] };
    const res = await resolveGroupSupplierOrgIds(outcomesConfig, orgsCache);
    expect(res.f3OrgId).toBe(54283);
    expect(res.partnerOrgIds).toContain(42071);
  });
});

describe("loadStoredRegisterHistory and saveRegisterHistory", () => {
  it("saves and loads history payload cleanly", () => {
    const origKey = process.env.REGISTER_HISTORY_KEY;
    process.env.REGISTER_HISTORY_KEY = "test-history-secret-key";
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-history-test-"));
      const filePath = path.join(tmpDir, "history.json");

      expect(loadStoredRegisterHistory(filePath)).toBeNull();

      const sample = {
        asOf: "2026-10-28",
        months: []
      };
      saveRegisterHistory(filePath, sample);

      const loaded = loadStoredRegisterHistory(filePath);
      expect(loaded?.asOf).toBe("2026-10-28");
      expect(loaded?.months).toEqual([]);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      process.env.REGISTER_HISTORY_KEY = origKey;
    }
  });
});

describe("buildRegisterMonthSummary", () => {
  it("calculates totals, margin, manager breakdown and plans from file", () => {
    const rows: RegisterRow[] = [
      {
        date: "2026-07-25",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "ТОО Тест Заказчик 1",
        product: "Интерактивная панель 75",
        qty: 2,
        cost: 1000000,
        sale: 1500000,
        val: 500000,
        bonusMop: 10000,
        bonusRop: 5000,
        manager: "Иван Иванов",
        note: null,
        group: "ИП",
        kind: "Панели",
        channel: "Электронный магазин"
      },
      {
        date: "2026-07-28",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "ТОО Тест Заказчик 2",
        product: "Моноблок 24",
        qty: 5,
        cost: 800000,
        sale: 1200000,
        val: 400000,
        bonusMop: 8000,
        bonusRop: 4000,
        manager: "Петр Петров",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Запрос ценовых предложений"
      }
    ];

    const plans = {
      "Иван Иванов": 2000000,
      "Петр Петров": 3000000
    };

    const summary = buildRegisterMonthSummary({
      month: "2026-07",
      fileName: "ОП 31.07.26.xlsx",
      rows,
      plans
    });

    expect(summary.month).toBe("2026-07");
    expect(summary.fileName).toBe("ОП 31.07.26.xlsx");
    expect(summary.sale).toBe(2700000);
    expect(summary.val).toBe(900000);
    expect(summary.margin).toBeCloseTo(900000 / 2700000);
    expect(summary.contracts).toBe(2);
    expect(summary.plan).toBe(5000000);
    expect(summary.planPct).toBeCloseTo((2700000 / 5000000) * 100);
    expect(summary.hasVal).toBe(true);
    expect(summary.byManager).toHaveLength(2);

    const ivan = summary.byManager.find((m) => m.name === "Иван Иванов");
    expect(ivan?.sale).toBe(1500000);
    expect(ivan?.plan).toBe(2000000);
    expect(ivan?.planPct).toBeCloseTo(75);
  });

  it("handles September format where val column is absent without guessing", () => {
    const rows: RegisterRow[] = [
      {
        date: "2026-09-15",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "КГУ Школа 1",
        product: "Панель 65",
        qty: 1,
        cost: 600000,
        sale: 900000,
        val: null,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Иван Иванов",
        note: null,
        group: "ИП",
        kind: "Панели",
        channel: "Из одного источника"
      }
    ];

    const summary = buildRegisterMonthSummary({
      month: "2026-09",
      fileName: "ОП 30.09.26.xlsx",
      rows,
      plans: { "Иван Иванов": 1000000 },
      hasValColumn: false
    });

    expect(summary.hasVal).toBe(false);
    expect(summary.val).toBeNull();
    expect(summary.margin).toBeNull();
    expect(summary.byManager[0].val).toBeNull();
    expect(summary.byManager[0].margin).toBeNull();
  });
});

describe("matchPortalContracts1to1", () => {
  it("matches portal contracts strictly 1-to-1 without reusing register rows", () => {
    const portalContracts: PortalContractInput[] = [
      {
        id: 101,
        contract_number: "CN-001",
        sign_date: "2026-10-10",
        customer_organization_name: "ГКП на ПХВ Городская больница №1",
        contract_price_with_vat: 1120000,
        purchase_method_name: "Из одного источника",
        supplier: "F3"
      },
      {
        id: 102,
        contract_number: "CN-002",
        sign_date: "2026-10-10",
        customer_organization_name: "ГКП на ПХВ Городская больница №1",
        contract_price_with_vat: 1120000,
        purchase_method_name: "Из одного источника",
        supplier: "F3"
      },
      {
        id: 103,
        contract_number: "CN-003",
        sign_date: "2026-10-12",
        customer_organization_name: "КГУ Средняя школа №15",
        contract_price_with_vat: 500000,
        purchase_method_name: "Запрос ценовых предложений",
        supplier: "F3"
      }
    ];

    const registerRows: RegisterRow[] = [
      {
        date: "2026-10-10",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "Городская больница №1",
        product: "Мониторы",
        qty: 2,
        cost: 800000,
        sale: 1000000,
        val: 200000,
        bonusMop: 5000,
        bonusRop: 2000,
        manager: "Тест Менеджер",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Из одного источника"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, registerRows);
    expect(res.matchedCount).toBe(1);
    expect(res.missingContracts).toHaveLength(2);
    expect(res.missingContracts.map((c) => c.contractNumber)).toContain("CN-002");
    expect(res.missingContracts.map((c) => c.contractNumber)).toContain("CN-003");
  });
});

describe("detectRegisterDiscipline", () => {
  it("detects missing working days, lagged rows, sales below cost and retro changes", () => {
    const holidays = new Set(["2026-10-25"]);

    const rowsInOct6: RegisterRow[] = [
      {
        date: "2026-10-01",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "Заказчик А",
        product: "Товар 1",
        qty: 1,
        cost: 100000,
        sale: 150000,
        val: 50000,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Менеджер Л",
        note: null,
        group: "ИП",
        kind: "Панели",
        channel: "Запрос ценовых предложений"
      },
      {
        date: "2026-10-06",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "Заказчик Б",
        product: "Товар 2",
        qty: 1,
        cost: 200000,
        sale: 180000,
        val: -20000,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Менеджер М",
        note: null,
        group: "КТ",
        kind: "Моноблоки",
        channel: "Запрос ценовых предложений"
      }
    ];

    const fileEntries = [
      { fileName: "ОП 01.10.26.xlsx", dateKey: "2026-10-01", rows: [] },
      { fileName: "ОП 02.10.26.xlsx", dateKey: "2026-10-02", rows: [] },
      { fileName: "ОП 06.10.26.xlsx", dateKey: "2026-10-06", rows: rowsInOct6 }
    ];

    const discipline = detectRegisterDiscipline({
      startDate: "2026-10-01",
      endDate: "2026-10-06",
      holidays,
      fileEntries
    });

    expect(discipline.missingWorkingDays).toContain("2026-10-05");
    expect(discipline.laggedRowsCount).toBe(1);
    expect(discipline.laggedByManager[0].manager).toBe("Менеджер Л");
    expect(discipline.salesBelowCost).toHaveLength(1);
    expect(discipline.salesBelowCost[0].manager).toBe("Менеджер М");
  });
});

describe("buildFullRegisterHistory", () => {
  it("builds multi-month history, discipline and CRM missing from synthetic files", async () => {
    const wb1 = new ExcelJS.Workbook();
    const ws1 = wb1.addWorksheet("Лист1");
    ws1.getRow(1).values = [null, "Дата договора", "Тип продажи", "Контрагент", "Кол-во", "Товар", "Сумма без НДС", "Сумма продажи без НДС", "ИТОГО вал", "Менеджер"];
    ws1.getRow(2).values = [null, "2026-07-25", "ом", "ТОО Синтетик 1", 1, "моноблок", 100000, 150000, 50000, "Менеджер 1"];
    ws1.getRow(4).values = [null, null, "Менеджер", "Сумма продажи без НДС", "Вал", "Бонусы", "План на месяц", "% выполнения"];
    ws1.getRow(5).values = [null, null, "Менеджер 1", 150000, 50000, 1000, 1000000, 0.15];
    const buf1 = Buffer.from(await wb1.xlsx.writeBuffer());

    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("Лист1");
    ws2.getRow(1).values = [null, "Дата подписания договора", "Тип продажи", "Контрагент", "Кол-во", "Товар", "Сумма без НДС", "Сумма продажи без НДС", "Менеджер"];
    ws2.getRow(2).values = [null, "2026-09-20", "зцп", "КГУ Синтетик 2", 2, "панель", 200000, 300000, "Менеджер 2"];
    ws2.getRow(4).values = [null, null, "Менеджер", "Сумма продажи без НДС", "План на месяц", "% выполнения"];
    ws2.getRow(5).values = [null, null, "Менеджер 2", 300000, 2000000, 0.15];
    const buf2 = Buffer.from(await wb2.xlsx.writeBuffer());

    const history = await buildFullRegisterHistory({
      files: [
        { fileName: "ОП 31.07.26.xlsx", buffer: buf1, updateTime: "2026-07-31T18:00:00" },
        { fileName: "ОП 30.09.26.xlsx", buffer: buf2, updateTime: "2026-09-30T18:00:00" }
      ],
      todayAlmaty: "2026-10-01",
      fetchPortal: false
    });

    expect(history.months).toHaveLength(2);
    expect(history.months[0].month).toBe("2026-07");
    expect(history.months[0].sale).toBe(150000);
    expect(history.months[0].hasVal).toBe(true);
    expect(history.months[0].plan).toBe(1000000);

    expect(history.months[1].month).toBe("2026-09");
    expect(history.months[1].sale).toBe(300000);
    expect(history.months[1].hasVal).toBe(false);
    expect(history.months[1].val).toBeNull();
    expect(history.months[1].margin).toBeNull();
  });
});

describe("loadRegisterView with history & payload isolation", () => {
  it("attaches cached history to RegisterView when cache file exists", async () => {
    const origKey = process.env.REGISTER_HISTORY_KEY;
    process.env.REGISTER_HISTORY_KEY = "test-history-secret-key";
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-load-test-"));
      const cachePath = path.join(tmpDir, "history.json");

      const sampleHistory = {
        asOf: "2026-10-28",
        months: [
          {
            month: "2026-07",
            label: "Июль 2026",
            fileName: "ОП 31.07.26.xlsx",
            sale: 100000000,
            val: 30000000,
            margin: 0.3,
            contracts: 25,
            plan: 120000000,
            planPct: 83.3,
            hasVal: true,
            byManager: []
          }
        ]
      };
      saveRegisterHistory(cachePath, sampleHistory);

      // Create synthetic file for today's register
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Лист1");
      ws.getRow(1).values = [null, "Дата договора", "Тип продажи", "Контрагент", "Кол-во", "Товар", "Сумма без НДС", "Сумма продажи без НДС", "ИТОГО вал", "Менеджер"];
      ws.getRow(2).values = [null, "2026-10-28", "ом", "ТОО Синтетик", 1, "моноблок", 100000, 150000, 50000, "Менеджер 1"];
      ws.getRow(4).values = [null, null, "Менеджер", "Сумма продажи без НДС", "Вал", "Бонусы", "План на месяц", "% выполнения"];
      ws.getRow(5).values = [null, null, "Менеджер 1", 150000, 50000, 1000, 1000000, 0.15];
      const filePath = path.join(tmpDir, "ОП 28.10.26.xlsx");
      await wb.xlsx.writeFile(filePath);

      const mockReader = {
        call: vi.fn().mockResolvedValue([]),
        listAllBatched: vi.fn().mockResolvedValue([])
      } as unknown as ReadOnlyBitrixClient;

      const view = await loadRegisterView({
        reader: mockReader,
        registerFilePath: filePath,
        todayAlmaty: "2026-10-28",
        contractTransitions: [],
        userProfiles: new Map(),
        historyCachePath: cachePath
      });

      expect(view.error).toBeUndefined();
      expect(view.total?.sale).toBe(150000);
      expect(view.history).toBeDefined();
      expect(view.history?.months).toHaveLength(1);
      expect(view.history?.months[0].month).toBe("2026-07");

      fs.rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      process.env.REGISTER_HISTORY_KEY = origKey;
    }
  });

  it("strictly enforces payload isolation: pult.html never contains register, reg.html does", () => {
    const syntheticView = {
      file: "ОП 28.10.26.xlsx",
      asOf: "2026-10-28",
      month: "2026-10",
      total: {
        sale: 1000000,
        val: 300000,
        margin: 0.3,
        bonusMop: 10000,
        bonusRop: 5000,
        contracts: 5,
        plan: 2000000,
        b2bPlan: 0,
        b2bSale: 0
      },
      daily: [],
      managers: [],
      mix: [],
      channels: [],
      groups: [],
      missing: [],
      crmExtra: 0,
      rows: [],
      history: {
        asOf: "2026-10-28",
        months: [
          {
            month: "2026-07",
            label: "Июль 2026",
            fileName: "ОП 31.07.26.xlsx",
            sale: 100000000,
            val: 30000000,
            margin: 0.3,
            contracts: 25,
            plan: 120000000,
            planPct: 83.3,
            hasVal: true,
            byManager: []
          }
        ]
      }
    };

    const basePultPayload: SalesPultPayload = JSON.parse(
      fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8")
    );
    const pultPayload: SalesPultPayload & { register?: unknown } = {
      ...basePultPayload,
      // accidental leakage of register in pult payload:
      register: syntheticView
    };

    const pultHtml = renderPultHtml(pultPayload);
    // renderPultHtml must strip register from payload
    expect(pultHtml).not.toContain("ОП 31.07.26.xlsx");
    expect(pultHtml).not.toContain("ОП 28.10.26.xlsx");

    const regPayload: RegisterPagePayload = {
      asOfDate: "2026-10-28",
      generatedAt: "2026-10-28 12:00 (UTC+5)",
      portal: "test.bitrix24.kz",
      pultUrl: "https://example.com/pult",
      register: syntheticView
    };

    const regHtml = renderRegisterHtml(regPayload);
    expect(regHtml).toContain("ОП 31.07.26.xlsx");
    expect(regHtml).toContain("ОП 28.10.26.xlsx");
  });

  it("does not treat config holiday 2026-10-26 as a missing working day", () => {
    const holidays = new Set(["2026-10-25", "2026-10-26"]);
    const fileEntries = [
      { fileName: "ОП 23.10.26.xlsx", dateKey: "2026-10-23", rows: [] },
      { fileName: "ОП 27.10.26.xlsx", dateKey: "2026-10-27", rows: [] }
    ];
    const discipline = detectRegisterDiscipline({
      startDate: "2026-10-23",
      endDate: "2026-10-27",
      holidays,
      fileEntries
    });
    expect(discipline.missingWorkingDays).not.toContain("2026-10-26");
    expect(discipline.missingWorkingDays).not.toContain("2026-10-25"); // Sunday
  });

  it("performs strict 1-to-1 matching for retro changes with multiple identical (customer, product) rows", () => {
    const row1: RegisterRow = {
      date: "2026-10-01",
      type: "ом",
      extras: 0,
      portal: 0,
      customer: "Больница 1",
      product: "Монитор",
      qty: 1,
      cost: 100000,
      sale: 150000,
      val: 50000,
      bonusMop: 0,
      bonusRop: 0,
      manager: "Менеджер А",
      note: null,
      group: "КТ",
      kind: "Мониторы",
      channel: "Запрос"
    };

    const row2: RegisterRow = {
      date: "2026-10-01",
      type: "ом",
      extras: 0,
      portal: 0,
      customer: "Больница 1",
      product: "Монитор",
      qty: 2,
      cost: 200000,
      sale: 300000,
      val: 100000,
      bonusMop: 0,
      bonusRop: 0,
      manager: "Менеджер А",
      note: null,
      group: "КТ",
      kind: "Мониторы",
      channel: "Запрос"
    };

    // Next day row2 sale is modified from 300000 to 350000
    const row2Modified: RegisterRow = {
      ...row2,
      sale: 350000
    };

    const fileEntries = [
      { fileName: "ОП 01.10.26.xlsx", dateKey: "2026-10-01", rows: [row1, row2] },
      { fileName: "ОП 02.10.26.xlsx", dateKey: "2026-10-02", rows: [row1, row2Modified] }
    ];

    const discipline = detectRegisterDiscipline({
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      holidays: new Set(),
      fileEntries
    });

    // Exactly 1 row changed (row2), row1 was matched 1-to-1 and remained unchanged
    expect(discipline.retroChanges).toHaveLength(1);
    expect(discipline.retroChanges[0].type).toBe("modified");
    expect(discipline.retroChanges[0].diff?.sale?.before).toBe(300000);
    expect(discipline.retroChanges[0].diff?.sale?.after).toBe(350000);
  });

  it("ignores 0 / 0 row in salesBelowCost and does not treat it as a loss", () => {
    const zeroRow: RegisterRow = {
      date: "2026-10-01",
      type: "ом",
      extras: 0,
      portal: 0,
      customer: "Заказчик Ноль",
      product: "Услуга",
      qty: 1,
      cost: 0,
      sale: 0,
      val: 0,
      bonusMop: 0,
      bonusRop: 0,
      manager: "Менеджер З",
      note: null,
      group: "КТ",
      kind: "Прочее",
      channel: "Запрос"
    };

    const discipline = detectRegisterDiscipline({
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      holidays: new Set(),
      fileEntries: [{ fileName: "ОП 01.10.26.xlsx", dateKey: "2026-10-01", rows: [zeroRow] }]
    });

    expect(discipline.salesBelowCost).toHaveLength(0);
  });

  it("handles reconciliationPerformed flag: displays message when not performed and never claims 'все сопоставлено'", () => {
    const viewWithUnperformed = {
      file: "ОП 28.10.26.xlsx",
      asOf: "2026-10-28",
      month: "2026-10",
      total: { sale: 1000, val: 300, margin: 0.3, bonusMop: 0, bonusRop: 0, contracts: 1, plan: 2000, b2bPlan: 0, b2bSale: 0 },
      daily: [],
      managers: [],
      mix: [],
      channels: [],
      groups: [],
      missing: [],
      crmExtra: 0,
      rows: [],
      history: {
        asOf: "2026-10-28",
        months: [
          {
            month: "2026-08",
            label: "Август 2026",
            fileName: "ОП 31.08.26.xlsx",
            sale: 100000,
            val: 30000,
            margin: 0.3,
            contracts: 1,
            plan: 200000,
            planPct: 50,
            hasVal: true,
            byManager: [],
            reconciliationPerformed: false
          }
        ]
      }
    };

    const payload: RegisterPagePayload = {
      asOfDate: "2026-10-28",
      generatedAt: "2026-10-28 12:00 (UTC+5)",
      portal: "test.bitrix24.kz",
      pultUrl: "https://example.com/pult",
      register: viewWithUnperformed
    };

    const html = renderRegisterHtml(payload);
    expect(html).toContain("Сверка с CRM за прошлые месяцы не выполнялась");
    expect(html).not.toContain("все договоры реестра сопоставлены");
  });

  it("matches portal contracts with neighbor month register contracts without multiplying sums", () => {
    // Portal contract signed on Sept 02 with sum 1.12M
    const portalContracts: PortalContractInput[] = [
      {
        id: 201,
        contract_number: "CN-SEP-01",
        sign_date: "2026-09-02",
        customer_organization_name: "ГКП Поликлиника №5",
        contract_price_with_vat: 1120000,
        purchase_method_name: "Из одного источника",
        supplier: "F3"
      },
      {
        id: 202,
        contract_number: "CN-SEP-02",
        sign_date: "2026-09-15",
        customer_organization_name: "Неизвестный Заказчик На Портале",
        contract_price_with_vat: 5000000,
        purchase_method_name: "Открытый конкурс",
        supplier: "F3"
      }
    ];

    // August register file has the matching contract for Polyclinic 5
    const augRows: RegisterRow[] = [
      {
        date: "2026-08-30",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "Поликлиника №5",
        product: "Компьютеры",
        qty: 2,
        cost: 800000,
        sale: 1000000, // 1M + 12% VAT = 1.12M
        val: 200000,
        bonusMop: 5000,
        bonusRop: 2000,
        manager: "Тест",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Запрос"
      }
    ];

    // Grouping individually per month
    const allFinalContracts = groupRegisterContracts(augRows);
    const res = matchPortalContracts1to1(portalContracts, allFinalContracts);

    expect(res.matchedCount).toBe(1);
    expect(res.matchedPairs[0].portal.contract_number).toBe("CN-SEP-01");
    expect(res.missingContracts).toHaveLength(1);
    expect(res.missingContracts[0].contractNumber).toBe("CN-SEP-02");
  });

  it("rejects portal contract match when amount deviation is > 3% even with high name similarity", () => {
    const portalContracts: PortalContractInput[] = [
      {
        id: 301,
        contract_number: "CN-005",
        sign_date: "2026-10-10",
        customer_organization_name: "ГКП на ПХВ Городская больница №1",
        contract_price_with_vat: 1120000,
        purchase_method_name: "Из одного источника",
        supplier: "F3"
      }
    ];

    const registerRows: RegisterRow[] = [
      {
        date: "2026-10-10",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "ГКП на ПХВ Городская больница №1",
        product: "Мониторы",
        qty: 2,
        cost: 800000,
        sale: 1200000, // 1.2M * 1.12 = 1.344M, deviation is > 16% from 1.12M
        val: 200000,
        bonusMop: 5000,
        bonusRop: 2000,
        manager: "Тест",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Из одного источника"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, registerRows);
    expect(res.matchedCount).toBe(0);
    expect(res.missingContracts).toHaveLength(1);
  });

  it("rejects portal contract match when register row is 2 months apart", () => {
    const portalContracts: PortalContractInput[] = [
      {
        id: 302,
        contract_number: "CN-006",
        sign_date: "2026-10-15",
        customer_organization_name: "ГКП на ПХВ Городская больница №1",
        contract_price_with_vat: 1120000,
        purchase_method_name: "Из одного источника",
        supplier: "F3"
      }
    ];

    const registerRows: RegisterRow[] = [
      {
        date: "2026-07-20", // 3 months before October
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "ГКП на ПХВ Городская больница №1",
        product: "Мониторы",
        qty: 2,
        cost: 800000,
        sale: 1000000, // exact 1.12M price
        val: 200000,
        bonusMop: 5000,
        bonusRop: 2000,
        manager: "Тест",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Из одного источника"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, registerRows);
    expect(res.matchedCount).toBe(0);
    expect(res.missingContracts).toHaveLength(1);
  });

  it("prioritizes exact amount match over less accurate pair for same customer", () => {
    const portalContracts: PortalContractInput[] = [
      {
        id: 401,
        contract_number: "CN-A",
        sign_date: "2026-10-10",
        customer_organization_name: "КГУ Школа №10",
        contract_price_with_vat: 1120000, // matches 1,000,000 * 1.12 exactly
        purchase_method_name: "Из одного источника",
        supplier: "F3"
      },
      {
        id: 402,
        contract_number: "CN-B",
        sign_date: "2026-10-15",
        customer_organization_name: "КГУ Школа №10",
        contract_price_with_vat: 2240000, // matches 2,000,000 * 1.12 exactly
        purchase_method_name: "Из одного источника",
        supplier: "F3"
      }
    ];

    const registerRows: RegisterRow[] = [
      {
        date: "2026-10-10",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "КГУ Школа №10",
        product: "Мониторы",
        qty: 2,
        cost: 800000,
        sale: 1000000,
        val: 200000,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Тест",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Запрос"
      },
      {
        date: "2026-10-15",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "КГУ Школа №10",
        product: "Панели",
        qty: 2,
        cost: 1600000,
        sale: 2000000,
        val: 400000,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Тест",
        note: null,
        group: "ИП",
        kind: "Панели",
        channel: "Запрос"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, registerRows);
    expect(res.matchedCount).toBe(2);
    expect(res.missingContracts).toHaveLength(0);

    const pairA = res.matchedPairs.find((p) => p.portal.id === 401);
    const pairB = res.matchedPairs.find((p) => p.portal.id === 402);
    expect(pairA?.registerKey).toContain("1000000");
    expect(pairB?.registerKey).toContain("2000000");
  });

  it("does not count rows from the very first history file as lagged rows", () => {
    const fileEntries = [
      {
        fileName: "ОП 23.07.26.xlsx",
        dateKey: "2026-07-23",
        rows: [
          {
            date: "2026-07-05", // 18 days ago, but this is the FIRST file of history
            type: "ом",
            extras: 0,
            portal: 0,
            customer: "Заказчик Ранний",
            product: "Товар 1",
            qty: 1,
            cost: 100000,
            sale: 150000,
            val: 50000,
            bonusMop: 0,
            bonusRop: 0,
            manager: "Менеджер А",
            note: null,
            group: "ИП" as const,
            kind: "Панели",
            channel: "Запрос"
          }
        ]
      },
      {
        fileName: "ОП 24.07.26.xlsx",
        dateKey: "2026-07-24",
        rows: []
      }
    ];

    const discipline = detectRegisterDiscipline({
      startDate: "2026-07-23",
      endDate: "2026-07-24",
      holidays: new Set(),
      fileEntries,
      firstFileBaseline: true,
      currentMonth: "2026-07"
    });

    expect(discipline.laggedRowsCount).toBe(0);
  });

  it("does not count edited rows with modified sale or cost as late rows", () => {
    const rowV1: RegisterRow = {
      date: "2026-10-01",
      type: "ом",
      extras: 0,
      portal: 0,
      customer: "Заказчик Редактируемый",
      product: "Товар Тест",
      qty: 1,
      cost: 100000,
      sale: 150000,
      val: 50000,
      bonusMop: 0,
      bonusRop: 0,
      manager: "Менеджер Б",
      note: null,
      group: "ИП",
      kind: "Панели",
      channel: "Запрос"
    };

    const rowV2: RegisterRow = {
      ...rowV1,
      cost: 110000,
      sale: 160000,
      val: 50000
    };

    const fileEntries = [
      { fileName: "ОП 01.10.26.xlsx", dateKey: "2026-10-01", rows: [rowV1] },
      { fileName: "ОП 15.10.26.xlsx", dateKey: "2026-10-15", rows: [rowV2] }
    ];

    const discipline = detectRegisterDiscipline({
      startDate: "2026-10-01",
      endDate: "2026-10-15",
      holidays: new Set(),
      fileEntries,
      currentMonth: "2026-10"
    });

    expect(discipline.laggedRowsCount).toBe(0);
  });

  it("only counts lagged rows for the current and previous month", () => {
    const julyRow: RegisterRow = {
      date: "2026-07-02",
      type: "ом",
      extras: 0,
      portal: 0,
      customer: "Заказчик Июльский",
      product: "Товар Старый",
      qty: 1,
      cost: 100000,
      sale: 150000,
      val: 50000,
      bonusMop: 0,
      bonusRop: 0,
      manager: "Менеджер С",
      note: null,
      group: "ИП",
      kind: "Панели",
      channel: "Запрос"
    };

    const fileEntries = [
      { fileName: "ОП 23.07.26.xlsx", dateKey: "2026-07-23", rows: [] },
      { fileName: "ОП 25.07.26.xlsx", dateKey: "2026-07-25", rows: [julyRow] }
    ];

    const discipline = detectRegisterDiscipline({
      startDate: "2026-07-23",
      endDate: "2026-10-25",
      holidays: new Set(),
      fileEntries,
      currentMonth: "2026-10" // July is before previous month (September)
    });

    expect(discipline.laggedRowsCount).toBe(0);
  });

  it("sorts multiple files on the same date by update time, then revision", () => {
    const fileA = { fileName: "ОП 31.07.26 (1).xlsx", dateKey: "2026-07-31", updateTime: "2026-07-31T14:00:00" };
    const fileB = { fileName: "ОП 31.07.26.xlsx", dateKey: "2026-07-31", updateTime: "2026-07-31T10:00:00" };

    const sorted = [fileA, fileB].sort((a, b) => {
      if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey);
      const timeA = a.updateTime || "";
      const timeB = b.updateTime || "";
      if (timeA !== timeB) return timeA.localeCompare(timeB);
      return a.fileName.localeCompare(b.fileName);
    });

    expect(sorted[0].fileName).toBe("ОП 31.07.26.xlsx");
    expect(sorted[1].fileName).toBe("ОП 31.07.26 (1).xlsx");
  });
});

describe("matchPortalContracts1to1 - customer sum matching & similarity (Block 07)", () => {
  it("closes two portal contracts against one register row when their sum equals row * 1.16", () => {
    // Synthetic data: 2 portal contracts for 580,000 each = 1,160,000 against 1 row with sale = 1,000,000 (1,000,000 * 1.16 = 1,160,000)
    const portalContracts: PortalContractInput[] = [
      {
        id: 701,
        contract_number: "CN-701",
        sign_date: "2026-10-10",
        customer_organization_name: "ГККП Городской парк культуры и отдыха",
        contract_price_with_vat: 580000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      },
      {
        id: 702,
        contract_number: "CN-702",
        sign_date: "2026-10-12",
        customer_organization_name: "ГККП Городской парк культуры и отдыха",
        contract_price_with_vat: 580000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      }
    ];

    const registerRows: RegisterRow[] = [
      {
        date: "2026-10-11",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "ГККП Городской парк культуры и отдыха",
        product: "Компьютеры",
        qty: 2,
        cost: 800000,
        sale: 1000000,
        val: 200000,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Тест",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Запрос"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, registerRows);
    expect(res.matchedCount).toBe(2);
    expect(res.matched1to1Count).toBe(0);
    expect(res.matchedByCustomerSumCount).toBe(2);
    expect(res.missingContracts).toHaveLength(0);
  });

  it("leaves customer portal contracts unmatched when their sum is outside 3% tolerance", () => {
    const portalContracts: PortalContractInput[] = [
      {
        id: 703,
        contract_number: "CN-703",
        sign_date: "2026-10-10",
        customer_organization_name: "ГККП Городской парк культуры и отдыха",
        contract_price_with_vat: 580000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      },
      {
        id: 704,
        contract_number: "CN-704",
        sign_date: "2026-10-12",
        customer_organization_name: "ГККП Городской парк культуры и отдыха",
        contract_price_with_vat: 580000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      }
    ];

    // Register row sale 900,000 (1.16 is 1,044,000; portal sum 1,160,000 is ~11% off)
    const registerRows: RegisterRow[] = [
      {
        date: "2026-10-11",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "ГККП Городской парк культуры и отдыха",
        product: "Компьютеры",
        qty: 2,
        cost: 700000,
        sale: 900000,
        val: 200000,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Тест",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Запрос"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, registerRows);
    expect(res.matchedCount).toBe(0);
    expect(res.missingContracts).toHaveLength(2);
  });

  it("prioritizes customer sum match over next-month 1-to-1 match (Block 07 Pass Order)", () => {
    // Register row from 15.09 equals three 16.09 contracts of same customer * 1.16.
    // Next month contract (13.10) matches the row within 1.3% deviation (x1.12).
    // Correct pass order: row closes the three 16.09 contracts in Pass 2;
    // next-month contract remains unmatched for Pass 3 / its own pass.
    const septemberRow: RegisterRow = {
      date: "2026-09-15",
      type: "ом",
      extras: 0,
      portal: 0,
      customer: "ГКП Тепловые сети",
      product: "Трубы",
      qty: 3,
      cost: 400000,
      sale: 500000, // 500,000 * 1.16 = 580,000
      val: 100000,
      bonusMop: 0,
      bonusRop: 0,
      manager: "Тест",
      note: null,
      group: "Прочее",
      kind: "Трубы",
      channel: "Запрос"
    };

    const portalContracts: PortalContractInput[] = [
      // 3 contracts from 16.09, total sum = 580,000 = row * 1.16
      {
        id: 801,
        contract_number: "CN-801",
        sign_date: "2026-09-16",
        customer_organization_name: "ГКП Тепловые сети",
        contract_price_with_vat: 100000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      },
      {
        id: 802,
        contract_number: "CN-802",
        sign_date: "2026-09-16",
        customer_organization_name: "ГКП Тепловые сети",
        contract_price_with_vat: 280000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      },
      {
        id: 803,
        contract_number: "CN-803",
        sign_date: "2026-09-16",
        customer_organization_name: "ГКП Тепловые сети",
        contract_price_with_vat: 200000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      },
      // 1 contract from next month (13.10) with 553,000 (500,000 * 1.12 = 560,000, deviation 1.25%)
      {
        id: 804,
        contract_number: "CN-804",
        sign_date: "2026-10-13",
        customer_organization_name: "ГКП Тепловые сети",
        contract_price_with_vat: 553000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, [septemberRow]);

    // The 3 September contracts must be closed by the September row
    expect(res.matchedCount).toBe(3);
    expect(res.matched1to1Count).toBe(0);
    expect(res.matchedByCustomerSumCount).toBe(3);

    // The next-month contract (804) must NOT steal the September row; it remains missing / for its own pass
    expect(res.missingContracts).toHaveLength(1);
    expect(res.missingContracts[0].id).toBe(804);
  });

  it("does not group or sum contracts of different customers even if sum matches", () => {
    const portalContracts: PortalContractInput[] = [
      {
        id: 705,
        contract_number: "CN-705",
        sign_date: "2026-10-10",
        customer_organization_name: "КГУ Школа №1 Астана",
        contract_price_with_vat: 500000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      },
      {
        id: 706,
        contract_number: "CN-706",
        sign_date: "2026-10-12",
        customer_organization_name: "ГККП Детский сад №2 Алматы",
        contract_price_with_vat: 500000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      }
    ];

    const registerRows: RegisterRow[] = [
      {
        date: "2026-10-11",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "КГУ Школа №1 Астана",
        product: "Компьютеры",
        qty: 1,
        cost: 800000,
        sale: 1000000, // Sum of two contracts (1,000,000) matches this row sale, but they are from different customers!
        val: 200000,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Тест",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Запрос"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, registerRows);
    // They should not sum together across different customers
    expect(res.matchedByCustomerSumCount).toBe(0);
    // Neither should match 1-to-1 because 500,000 != 1,000,000
    expect(res.matched1to1Count).toBe(0);
    expect(res.missingContracts).toHaveLength(2);
  });

  it("does not match in Pass 1 when customer name similarity is below 0.5", () => {
    const portalContracts: PortalContractInput[] = [
      {
        id: 707,
        contract_number: "CN-707",
        sign_date: "2026-10-10",
        customer_organization_name: "ГККП Спортивный клуб бокса Барыс",
        contract_price_with_vat: 1120000,
        purchase_method_name: "Запрос",
        supplier: "F3"
      }
    ];

    // Different sports organization with similarity around 0.35-0.45 (< 0.5)
    const registerRows: RegisterRow[] = [
      {
        date: "2026-10-10",
        type: "ом",
        extras: 0,
        portal: 0,
        customer: "КГУ Специализированная школа высшего спортивного мастерства по водным видам спорта",
        product: "Спорт",
        qty: 1,
        cost: 800000,
        sale: 1000000, // 1,000,000 * 1.12 = 1,120,000
        val: 200000,
        bonusMop: 0,
        bonusRop: 0,
        manager: "Тест",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Запрос"
      }
    ];

    const res = matchPortalContracts1to1(portalContracts, registerRows);
    expect(res.matchedCount).toBe(0);
    expect(res.missingContracts).toHaveLength(1);
  });
});

describe("detectRegisterDiscipline - intermediate files condition (Block 08)", () => {
  it("does not flag row as late when files for intermediate working days are missing and row first appears later", () => {
    // Row dated 2026-10-14 (Wednesday).
    // Files for 14th and 15th are missing.
    // Row first appears in file of 2026-10-16.
    const fileEntries = [
      {
        fileName: "ОП 13.10.26.xlsx",
        dateKey: "2026-10-13",
        rows: []
      },
      // 14th and 15th missing
      {
        fileName: "ОП 16.10.26.xlsx",
        dateKey: "2026-10-16",
        rows: [
          {
            date: "2026-10-14",
            type: "ом",
            extras: 0,
            portal: 0,
            customer: "Заказчик 14-го",
            product: "Товар А",
            qty: 1,
            cost: 100000,
            sale: 150000,
            val: 50000,
            bonusMop: 0,
            bonusRop: 0,
            manager: "Менеджер А",
            note: null,
            group: "ИП" as const,
            kind: "Панели",
            channel: "Запрос"
          }
        ]
      }
    ];

    const discipline = detectRegisterDiscipline({
      startDate: "2026-10-13",
      endDate: "2026-10-16",
      holidays: new Set(),
      fileEntries,
      currentMonth: "2026-10"
    });

    // Lag working days between 14th and 16th is 2, but because NO file existed on the 15th, there is no proof of delay!
    expect(discipline.laggedRowsCount).toBe(0);
  });

  it("flags row as late when an intermediate working day file exists and row was absent in it", () => {
    // Row dated 2026-10-14 (Wednesday).
    // File of 2026-10-15 exists and DOES NOT contain this row.
    // Row first appears in file of 2026-10-16.
    const fileEntries = [
      {
        fileName: "ОП 13.10.26.xlsx",
        dateKey: "2026-10-13",
        rows: []
      },
      {
        fileName: "ОП 15.10.26.xlsx",
        dateKey: "2026-10-15",
        rows: [] // Row of 14th is absent here!
      },
      {
        fileName: "ОП 16.10.26.xlsx",
        dateKey: "2026-10-16",
        rows: [
          {
            date: "2026-10-14",
            type: "ом",
            extras: 0,
            portal: 0,
            customer: "Заказчик 14-го",
            product: "Товар А",
            qty: 1,
            cost: 100000,
            sale: 150000,
            val: 50000,
            bonusMop: 0,
            bonusRop: 0,
            manager: "Менеджер А",
            note: null,
            group: "ИП" as const,
            kind: "Панели",
            channel: "Запрос"
          }
        ]
      }
    ];

    const discipline = detectRegisterDiscipline({
      startDate: "2026-10-13",
      endDate: "2026-10-16",
      holidays: new Set(),
      fileEntries,
      currentMonth: "2026-10"
    });

    expect(discipline.laggedRowsCount).toBe(1);
    expect(discipline.laggedByManager[0].manager).toBe("Менеджер А");
  });
});

describe("Error handling & reliability (Block 07, 08, 09, load.ts, diskClient)", () => {
  it("searchOrganizationByBin matches exact BIN only, returns null on inexact match without taking results[0]", async () => {
    const data = {
      results: [
        { id: 99999, bin: "999999999999", name_ru: "Чужая Организация" },
        { id: 12345, bin: "061140003942", name_ru: "Точная Организация" }
      ]
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data),
      json: async () => data
    } as unknown as Response);

    // Exact match found in array
    const exactId = await searchOrganizationByBin("061140003942", { fetchFn: mockFetch as any });
    expect(exactId).toBe(12345);

    // When requested BIN is not in results, never take results[0]!
    const inexactId = await searchOrganizationByBin("111111111111", { fetchFn: mockFetch as any });
    expect(inexactId).toBeNull();
  });

  it("fetchPortalContractsForMonths throws an exception when contract statuses dictionary fails to load", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("contract_status")) {
        return Promise.reject(new Error("502 Bad Gateway"));
      }
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) });
    });

    await expect(
      fetchPortalContractsForMonths({
        supplierOrgIds: [{ orgId: 100, supplierName: "F3" }],
        months: ["2026-10"],
        fetchFn: mockFetch as any
      })
    ).rejects.toThrow("Не удалось загрузить справочник статусов договоров с портала zakup.gov.kz");
  });

  it("fetchRegisterFilesFromDisk captures candidate files without DOWNLOAD_URL into failedFiles", async () => {
    const mockClient = {
      listAllBatched: vi.fn().mockResolvedValue([
        {
          ID: "1",
          NAME: "ОП 20.10.26.xlsx",
          TYPE: "file",
          UPDATE_TIME: "2026-10-20T10:00:00",
          DOWNLOAD_URL: "" // Missing DOWNLOAD_URL
        }
      ])
    };

    const res = await fetchRegisterFilesFromDisk(mockClient as any, 123);
    expect(res).toHaveLength(0);
    expect(res.failedFiles).toHaveLength(1);
    expect(res.failedFiles[0]).toEqual({
      fileName: "ОП 20.10.26.xlsx",
      reason: "Отсутствует DOWNLOAD_URL"
    });
  });

  it("loadRegisterView: does not overwrite cache when CRM/portal throws, records attempt as failed, and shows old cache with error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-load-err-test-"));
    const cachePath = path.join(tmpDir, "history.json");
    const attemptPath = path.join(tmpDir, "last_attempt.json");
    const regFilePath = path.join(tmpDir, "ОП 26.10.26.xlsx");
    const secretKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    try {
      // Create minimal valid xlsx
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Лист1");
      ws.addRow(["№", "Менеджер", "Дата договора", "Заказчик", "Товар", "Кол-во", "Себестоимость", "Продажа", "Вал"]);
      ws.addRow([1, "Менеджер А", "2026-10-26", "Заказчик А", "Товар 1", 1, 100000, 150000, 50000]);
      await wb.xlsx.writeFile(regFilePath);

      // Pre-populate cache with previous valid payload
      const initialPayload = {
        asOf: "2026-10-25",
        months: [
          {
            month: "2026-10",
            monthName: "Октябрь 2026",
            fileName: "ОП 25.10.26.xlsx",
            asOf: "2026-10-25",
            totalSales: 1000000,
            totalVal: 200000,
            totalBonusMop: 0,
            totalBonusRop: 0,
            contractCount: 1,
            crmWonCount: 1,
            missingCrmCount: 0,
            reconciliationPerformed: true
          }
        ]
      };
      saveRegisterHistory(cachePath, initialPayload as any, secretKey);

      // Mock client where CRM throws
      const mockClient = {
        listAllBatched: vi.fn().mockImplementation((method: string) => {
          if (method === "disk.folder.getchildren") {
            return Promise.resolve([
              {
                ID: "101",
                NAME: "ОП 26.10.26.xlsx",
                TYPE: "file",
                UPDATE_TIME: "2026-10-26T12:00:00",
                DOWNLOAD_URL: "https://example.com/download"
              }
            ]);
          }
          if (method === "crm.stagehistory.list") {
            return Promise.reject(new Error("CRM service unavailable"));
          }
          return Promise.resolve([]);
        }),
        call: vi.fn().mockResolvedValue([])
      };

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("example.com")) {
          const buf = fs.readFileSync(regFilePath);
          return Promise.resolve({
            ok: true,
            status: 200,
            arrayBuffer: async () => buf.buffer
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ results: [] }) });
      }) as any;

      try {
        const view = await loadRegisterView({
          reader: mockClient as any,
          registerFilePath: regFilePath,
          diskFolderId: 10,
          secretKey,
          cachePath,
          attemptPath,
          refreshHistory: true
        });

        // Cache was NOT overwritten
        expect(view.history?.months).toHaveLength(1);
        expect(view.history?.asOf).toBe("2026-10-25");
        // Shows error with cache notice
        expect(view.history?.error).toContain("Ошибка построения истории: Ошибка загрузки выигрышей CRM по стадии");
        expect(view.history?.error).toContain("(отображается кэш)");

        // last_attempt.json recorded failure
        const attempt = loadRegisterHistoryAttempt(attemptPath);
        expect(attempt?.success).toBe(false);
        expect(attempt?.error).toContain("Ошибка загрузки выигрышей CRM по стадии");
      } finally {
        global.fetch = originalFetch;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadRegisterView: displays error from last_attempt.json when retry is suppressed (< 1 hour)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-load-suppress-test-"));
    const cachePath = path.join(tmpDir, "history.json");
    const attemptPath = path.join(tmpDir, "last_attempt.json");
    const regFilePath = path.join(tmpDir, "ОП 26.10.26.xlsx");
    const secretKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    try {
      // Create minimal valid xlsx
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Лист1");
      ws.addRow(["№", "Менеджер", "Дата договора", "Заказчик", "Товар", "Кол-во", "Себестоимость", "Продажа", "Вал"]);
      ws.addRow([1, "Менеджер А", "2026-10-26", "Заказчик А", "Товар 1", 1, 100000, 150000, 50000]);
      await wb.xlsx.writeFile(regFilePath);

      // Pre-populate cache
      const initialPayload = {
        asOf: "2026-10-25",
        months: []
      };
      saveRegisterHistory(cachePath, initialPayload as any, secretKey);

      // Pre-populate last_attempt.json with failed attempt 10 minutes ago
      recordRegisterHistoryAttempt(attemptPath, {
        success: false,
        error: "Предыдущий сбой сети портала",
        timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString()
      });

      const mockClient = {
        listAllBatched: vi.fn().mockResolvedValue([]),
        call: vi.fn().mockResolvedValue([])
      };

      const view = await loadRegisterView({
        reader: mockClient as any,
        registerFilePath: regFilePath,
        diskFolderId: 10,
        secretKey,
        cachePath,
        attemptPath,
        refreshHistory: false
      });

      // Error from last_attempt.json is displayed on payload
      expect(view.history?.error).toBe("Ошибка построения истории: Предыдущий сбой сети портала (отображается кэш)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("calculates default todayAlmaty in Asia/Almaty (UTC+5) rather than UTC", async () => {
    // 2026-10-30T22:30:00Z in UTC is 2026-10-30, but in Almaty (+5h) it is 2026-10-31 03:30:00
    const lateUtcDate = new Date("2026-10-30T22:30:00Z");
    const { getAlmatyToday } = await import("../../src/bitrix/salesPult/register/load.js");
    expect(getAlmatyToday(lateUtcDate)).toBe("2026-10-31");
  });
});
