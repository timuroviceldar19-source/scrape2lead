// Выдуманный склад 1С, лоты Радара и открытые планы для проверки «склада на карточках».
// Компании, склады, товары, суммы и номера придуманы.
import type { FinanceReport, FinanceStock, FinanceStockItem, FinanceView } from "../../../src/bitrix/salesPult/finance/types.js";
import { parseFinanceWorkbook } from "../../../src/bitrix/salesPult/finance/parseReport.js";
import type { NormalizedPlanDeal } from "../../../src/bitrix/salesPult/plans/types.js";
import type { RadarCard, RadarView } from "../../../src/bitrix/salesPult/radar/types.js";
import { financeWorkbook } from "./financeWorkbook.js";

export const STOCK_COMPANIES = ["ТОО «Склад-Тест Север»", "ТОО «Склад-Тест Юг»"];
export const STOCK_WAREHOUSES = ["Склад Образцовый", "Склад Резервный-Тест", "Витрина Учебная"];
/** Суммы позиций: ни одна не должна попасть на карточки и в вид менеджера. */
export const STOCK_SUMS = [12_345_678, 8_765_432, 7_654_321, 1_234_567, 456_789, 54_321, 6_543_210, 5_432_109, 3_210_987];

function item(name: string, endQty: number, endSum: number, extra: Partial<FinanceStockItem> = {}): FinanceStockItem {
  return { name, startQty: endQty, startSum: endSum, inQty: 0, outQty: 0, endQty, endSum, ...extra };
}

/**
 * Классифицируются: панели 75″ (40 без расхода + 29), 86″ (10 без расхода), панель без диагонали (4),
 * ноутбуки (25), компьютеры (30 без расхода), моноблоки (7, ведомость без движения).
 * Не входят: кронштейн (аксессуар), кабель (не ИП/КТ), монитор с нулевым остатком.
 */
export function stockSheets(): FinanceStock[] {
  return [
    {
      company: STOCK_COMPANIES[0], period: "Ноябрь 2026", hasMoves: true,
      warehouses: [
        {
          name: STOCK_WAREHOUSES[0], sums: { start: 30_000_000, end: 30_000_000 },
          items: [
            item("Интерактивная панель Образец 75″", 40, 12_345_678),
            item("Панель интерактивная Тест 75 Pro", 29, 8_765_432, { startQty: 34, outQty: 5, outSum: 1_500_000 }),
            item("Интерактивная панель Пример 86\"", 10, 7_654_321),
            item("Интерактивная панель Демо", 4, 1_234_567, { startQty: 6, outQty: 2, outSum: 600_000 }),
            item("Кронштейн для интерактивной панели", 50, 456_789),
            item("Кабель тестовый", 100, 54_321, { unit: "м" })
          ]
        },
        {
          name: STOCK_WAREHOUSES[1], sums: { start: 12_000_000, end: 12_000_000 },
          items: [
            item("Ноутбук Учебный 14", 25, 6_543_210, { startQty: 30, outQty: 5, outSum: 1_300_000 }),
            item("Компьютер Тестовый i5", 30, 5_432_109),
            item("Монитор Пример 24", 0, 0, { startQty: 5, startSum: 500_000, outQty: 5, outSum: 500_000 })
          ]
        }
      ],
      total: { start: 42_000_000, end: 42_000_000 }
    },
    {
      company: STOCK_COMPANIES[1], hasMoves: false,
      warehouses: [{
        name: STOCK_WAREHOUSES[2], sums: { start: 3_210_987, end: 3_210_987 },
        items: [{ name: "Моноблок Образец 24", startQty: 7, startSum: 3_210_987, endQty: 7, endSum: 3_210_987 }]
      }],
      total: { start: 3_210_987, end: 3_210_987 }
    }
  ];
}

/** Полный отчёт выдуманного финансиста (рендерится на fin.html) с выдуманным складом. */
export function stockReport(dataDate = "2026-11-20"): FinanceReport {
  const base = parseFinanceWorkbook(financeWorkbook({ stockSheets: true }));
  return { ...base, dataDate, stock: stockSheets() };
}

export function stockFinance(dataDate = "2026-11-20"): FinanceView {
  return { report: stockReport(dataDate), snapshots: [] };
}

function card(id: string, extra: Partial<RadarCard>): RadarCard {
  return {
    id, dealUrl: `https://example.invalid/crm/deal/details/${id}/`, sourceType: "lot", lotNumber: `${id}-ЗЦП1`, planNumber: id,
    lotUrl: "", announceUrl: "", title: extra.itemName ?? "", itemName: "", qty: 1, sum: 1_000_000, method: "Запрос ценовых предложений",
    status: "Опубликован (прием заявок)", group: "ИП", kind: "Интерактивные панели", customerName: `КГУ «Школа ${id}»`, customerBin: "000000000000",
    managerId: "s", managerName: "Алия Тестовая", startAt: "2026-11-20 10:00", endAt: "2026-11-24 18:00", hoursLeft: 70,
    isToday: false, isWithin48h: false, column: "submitToday", ...extra
  };
}

const kpis = { totalCount: 0, totalSum: 0, submitCount: 0, submitSum: 0, discussionCount: 0, discussionSum: 0, secondChanceCount: 0, secondChanceSum: 0 };

/** Лоты: 5101 — панель 75″ (на 10 шт, номер плана 70001), 5102 — 86″ на 20 шт, 5103 — панель без диагонали,
 *  5104 — доска (склада нет), 5105 — второй шанс 75″ (в спрос не входит), 5106 — компьютеры, 5107 — ноутбуки. */
export function stockRadar(): RadarView {
  return {
    asOf: "2026-11-21",
    ip: {
      group: "ИП", kpis,
      submitToday: [
        card("5101", { itemName: "Интерактивная панель 75", qty: 10, planNumber: "70001" }),
        card("5102", { itemName: "Интерактивная панель 86", qty: 20, managerId: "t", managerName: "Борис Тестовый" })
      ],
      discussion: [
        card("5103", { itemName: "Интерактивная панель", qty: 6, column: "discussion", status: "Опубликован" }),
        card("5104", { itemName: "Интерактивная доска", qty: 8, kind: "Интерактивные и спец. доски", column: "discussion", status: "Опубликован" })
      ],
      secondChance: [
        card("5105", { itemName: "Интерактивная панель 75", qty: 3, column: "secondChance", status: "Закупка не состоялась", managerId: "t", managerName: "Борис Тестовый" })
      ]
    },
    kt: {
      group: "КТ", kpis,
      submitToday: [
        card("5106", { itemName: "Компьютер Core i7", qty: 30, group: "КТ", kind: "Компьютеры и системные блоки", managerId: "t", managerName: "Борис Тестовый" })
      ],
      discussion: [
        card("5107", { itemName: "Ноутбук для учителя", qty: 40, group: "КТ", kind: "Ноутбуки", column: "discussion", status: "Опубликован" })
      ],
      secondChance: []
    }
  };
}

function planDeal(id: string, extra: Partial<NormalizedPlanDeal>): NormalizedPlanDeal {
  return {
    id, dealUrl: `https://example.invalid/crm/deal/details/${id}/`, planNumber: id, planUrl: "https://example.invalid/plan",
    month: "2026-11", customerName: `КГУ «Гимназия ${id}»`, customerBin: "000000000001", itemName: "Панель интерактивная 75″",
    truCode: "262030.100.000021", kind: "Интерактивные панели", qty: 1, price: 600_000, sum: 600_000, method: "Запрос ценовых предложений",
    portalStatus: "Утвержден", managerName: "Алия Тестовая", isNewStage: false, outcomeCategory: "open", group: "ИП", managerId: "s",
    dateCreate: "2026-11-01T10:00:00+05:00", outcomeKey: "", isOpen: true, isWonCrm: false, isLostCrm: false, ...extra
  };
}

/** Планы: 6101 — 75″ на 8 шт (Алия), 6102 — тот же план 70001, что лот 5101 (в спросе один раз), 6103 — МФУ (склада нет). */
export function stockPlanDeals(): NormalizedPlanDeal[] {
  return [
    planDeal("6101", { qty: 8, sum: 4_800_000 }),
    planDeal("6102", { qty: 5, sum: 3_000_000, planNumber: "70001", managerId: "t", managerName: "Борис Тестовый" }),
    planDeal("6103", { itemName: "Многофункциональное устройство", truCode: "", group: "КТ", kind: "МФУ и принтеры", qty: 2, sum: 400_000, managerId: "t", managerName: "Борис Тестовый" })
  ];
}
