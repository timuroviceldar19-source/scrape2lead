import { describe, expect, it } from "vitest";
import { importEducationHistory, EDUCATION_CODE } from "../../src/kz/market/educationImport.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import type { MarketUnit } from "../../src/kz/market/types.js";
const unit: MarketUnit = { id: 1, unitIndex: 0, month: "2026-01", date: "2026-01-15", group: "ИП", kind: "Учебные комплекты", code: EDUCATION_CODE, sum: 1000000, qty: 1, price: 1000000, supplier: "170240035230", customer: "111111111111", supplierName: "Партнёр", customerName: "Школа", method: "Открытый конкурс", us: false };
const stored = { updatedAt: "2026-11-04", completeMonths: ["2026-01"], units: [{ ...unit, code: "262030.100.000021", kind: "Панель", sum: 2000000 }] };
const supplement = { code: EDUCATION_CODE, fromDate: "2026-01-01", toDate: "2026-11-05", units: [unit] };
describe("добавление комплектов в проверенную историю", () => {
  it("сохраняет старые категории, даты и завершённые месяцы, повторный импорт не удваивает суммы", () => {
    const cfg = loadMarketConfig();
    const a = importEducationHistory(stored, supplement, cfg);
    expect(a.units.reduce((s, u) => s + u.sum, 0)).toBe(3000000);
    expect(a.units.find(u => u.code === EDUCATION_CODE)!.us).toBe(true);
    expect(a.completeMonths).toEqual(stored.completeMonths);
    expect(a.updatedAt).toBe(stored.updatedAt);
    expect(importEducationHistory(a, supplement, cfg)).toEqual(a);
  });
  it("отклоняет неподтверждённые номера договоров и дубли вместо публикации неверных ссылок", () => {
    expect(() => importEducationHistory(stored, { ...supplement, units: [{ ...unit, id: 0 }] }, loadMarketConfig())).toThrow("Invalid education contract item");
    expect(() => importEducationHistory(stored, { ...supplement, units: [unit, unit] }, loadMarketConfig())).toThrow("Duplicate");
  });
});
