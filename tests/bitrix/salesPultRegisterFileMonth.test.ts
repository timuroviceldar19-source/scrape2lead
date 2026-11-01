import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { loadRegisterView } from "../../src/bitrix/salesPult/register/load.js";
import type { ReadOnlyBitrixClient } from "../../src/bitrix/reporting/readOnlyClient.js";

// Все данные — выдуманные.
async function writeRegister(dir: string, fileName: string, rows: Array<[string, string, number]>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Лист1");
  ws.getRow(1).values = [null, "Дата договора", "Тип продажи", "Контрагент", "Кол-во", "Товар", "Сумма без НДС", "Сумма продажи без НДС", "ИТОГО вал", "Менеджер"];
  rows.forEach(([date, customer, sale], i) => {
    ws.getRow(2 + i).values = [null, date, "ом", customer, 1, "моноблок", sale * 0.7, sale, sale * 0.3, "Менеджер 1"];
  });
  const summaryRow = 3 + rows.length;
  ws.getRow(summaryRow).values = [null, null, "Менеджер", "Сумма продажи без НДС", "Вал", "Бонусы", "План на месяц", "% выполнения"];
  ws.getRow(summaryRow + 1).values = [null, null, "Менеджер 1", 350000, 105000, 1000, 1000000, 0.35];
  const filePath = path.join(dir, fileName);
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

function mockReader(history: Array<{ dealId: string; time: string }>) {
  const deals = [
    { ID: "10", TITLE: "ТОО Альфатех", OPPORTUNITY: 174000, ASSIGNED_BY_ID: "7" },
    { ID: "11", TITLE: "ГУ Бетагрупп", OPPORTUNITY: 232000, ASSIGNED_BY_ID: "7" }
  ];
  return {
    listAllBatched: vi.fn(async (method: string) => method === "crm.stagehistory.list"
      ? history.map((h, i) => ({ ID: i + 1, OWNER_ID: h.dealId, STAGE_ID: "C9:WON", CREATED_TIME: h.time }))
      : []),
    call: vi.fn(async (method: string, params: { filter: { ID: string[] } }) => method === "crm.deal.list"
      ? deals.filter((d) => params.filter.ID.includes(d.ID))
      : [])
  };
}

const profiles = new Map([["7", { id: "7", name: "Менеджер 1", active: true }]]);

describe("register file month vs CRM wins", () => {
  it("matches last month's file against that month's wins in the first days of a new month", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-file-month-"));
    try {
      const filePath = await writeRegister(dir, "ОП 30.10.26.xlsx", [
        ["2026-10-20", "ТОО Альфатех", 150000],
        ["2026-10-30", "ГУ Бетагрупп", 200000]
      ]);
      const reader = mockReader([
        { dealId: "10", time: "2026-10-20T10:00:00+05:00" },
        // Договор подписан 30-го, а сделку закрыли уже в новом месяце.
        { dealId: "11", time: "2026-11-02T10:00:00+05:00" }
      ]);
      const view = await loadRegisterView({
        reader: reader as unknown as ReadOnlyBitrixClient,
        registerFilePath: filePath,
        todayAlmaty: "2026-11-02",
        contractTransitions: [],
        userProfiles: profiles,
        contractStages: ["C9:WON"],
        historyCachePath: path.join(dir, "history.json")
      });
      expect(view.error).toBeUndefined();
      expect(view.month).toBe("2026-10");
      expect(view.missing).toEqual([]);
      expect(view.crmExtra).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps using the pult's own transitions for the current month's file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-file-month-"));
    try {
      const filePath = await writeRegister(dir, "ОП 28.10.26.xlsx", [["2026-10-20", "ТОО Альфатех", 150000]]);
      const reader = mockReader([]);
      const view = await loadRegisterView({
        reader: reader as unknown as ReadOnlyBitrixClient,
        registerFilePath: filePath,
        todayAlmaty: "2026-10-28",
        contractTransitions: [{ id: "1", dealId: "10", stageId: "C9:WON", createdTime: "2026-10-20T10:00:00+05:00" }],
        userProfiles: profiles,
        contractStages: ["C9:WON"],
        historyCachePath: path.join(dir, "history.json")
      });
      expect(view.missing).toEqual([]);
      expect(reader.listAllBatched.mock.calls.some(([method]) => method === "crm.stagehistory.list")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
