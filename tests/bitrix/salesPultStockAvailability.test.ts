// Склад 1С на карточках Радара и Планов: только штуки по видам товара. Все данные выдуманные.
import { describe, expect, it } from "vitest";
import { buildFinanceInsights, isStockStagnant } from "../../src/bitrix/salesPult/finance/insights.js";
import { classifyKind, classifyProductGroup } from "../../src/bitrix/salesPult/radar/aggregate.js";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import { classifyStockName, stockDiagonal, stockKey } from "../../src/bitrix/salesPult/stock/classify.js";
import {
  buildStockAvailability, buildStockDemand, matchStock, parsePayloadStock, stockForViewer, withStockHints,
  type StockAvailability
} from "../../src/bitrix/salesPult/stock/availability.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import {
  STOCK_COMPANIES, STOCK_SUMS, STOCK_WAREHOUSES, stockFinance, stockPlanDeals, stockRadar, stockSheets
} from "../fixtures/sales-pult/stock.js";

const PANELS = "Интерактивные панели";
const plans = () => buildPlansMonitorView(stockPlanDeals(), { asOfDate: "2026-11-21" });
const availability = () => buildStockAvailability(stockFinance("2026-11-20"), "2026-11-21")!;

describe("диагональ и вид позиции склада", () => {
  it("берёт диагональ панели по маркеру дюйма или числу рядом со словом «панель»", () => {
    expect(stockDiagonal(PANELS, "Интерактивная панель Образец 75″")).toBe(75);
    expect(stockDiagonal(PANELS, "Панель интерактивная 86\"")).toBe(86);
    expect(stockDiagonal(PANELS, "Интерактивная панель 65 дюймов")).toBe(65);
    expect(stockDiagonal(PANELS, "Интерактивная панель 98-дюймовая")).toBe(98);
    expect(stockDiagonal(PANELS, "Интерактивная панель диагональ 110”")).toBe(110);
    expect(stockDiagonal(PANELS, "Панель интерактивная Тест 75 Pro")).toBe(75);
    expect(stockDiagonal(PANELS, "Интерактивная панель 100")).toBe(100);
    expect(stockDiagonal("Мониторы", "Монитор 55″ для ВКС")).toBe(55);
  });

  it("без уверенности диагонали нет", () => {
    expect(stockDiagonal(PANELS, "Интерактивная панель Демо")).toBeNull();
    // номер модели, размеры другого рода, две разные диагонали, штуки
    expect(stockDiagonal(PANELS, "Интерактивная панель IFP7502")).toBeNull();
    expect(stockDiagonal(PANELS, "Интерактивная панель 65/75")).toBeNull();
    expect(stockDiagonal(PANELS, "Интерактивная панель, 100 шт")).toBeNull();
    expect(stockDiagonal(PANELS, "Интерактивная панель 75 см")).toBeNull();
    expect(stockDiagonal(PANELS, "Интерактивная панель 3840x2160")).toBeNull();
    // монитор — только с маркером и только из списка диагоналей
    expect(stockDiagonal("Мониторы", "Монитор Пример 24")).toBeNull();
    expect(stockDiagonal("Мониторы", "Монитор 24″")).toBeNull();
    expect(stockDiagonal("Мониторы", "Монитор Пример 75")).toBeNull();
    // у остальных видов диагональ не берётся
    expect(stockDiagonal("Ноутбуки", "Ноутбук 15″")).toBeNull();
    expect(stockDiagonal("Учебные комплекты", "Учебный комплект с панелью 75″")).toBeNull();
  });

  it("раскладывает название функциями Радара и отбрасывает аксессуары", () => {
    expect(classifyStockName("Интерактивная панель Образец 75″")).toEqual({ group: "ИП", kind: PANELS, diagonal: 75 });
    expect(classifyStockName("Ноутбук Учебный 14")).toEqual({ group: "КТ", kind: "Ноутбуки", diagonal: null });
    expect(classifyStockName("Учебный комплект Тест")).toEqual({ group: "ИП", kind: "Учебные комплекты", diagonal: null });
    expect(classifyStockName("Кабель тестовый")).toBeNull();
    // «для панели» / «для принтера» — принадлежность к товару, а не товар
    expect(classifyStockName("Кронштейн для интерактивной панели")).toBeNull();
    expect(classifyStockName("Картридж для принтера Тест")).toBeNull();
    expect(classifyStockName("Стойка мобильная для панелей")).toBeNull();
    expect(classifyStockName("Пульт ДУ интерактивной панели")).toBeNull();
    expect(classifyStockName("Ноутбук для учителя")).toEqual({ group: "КТ", kind: "Ноутбуки", diagonal: null });
    expect(stockKey("ИП", PANELS, 75)).toBe("ИП|Интерактивные панели|75");
    expect(stockKey("КТ", "Ноутбуки", null)).toBe("КТ|Ноутбуки|");
  });
});

describe("buildStockAvailability", () => {
  it("агрегирует штуки по (группа, вид, диагональ) без сумм, компаний, складов и номенклатуры", () => {
    const av = availability();
    expect(av.asOf).toBe("2026-11-20");
    expect(av.stale).toBe(false);
    expect(av.rows).toEqual([
      { key: "ИП|Интерактивные панели|", group: "ИП", kind: PANELS, diagonal: null, qty: 4, stagnantQty: 0 },
      { key: "ИП|Интерактивные панели|75", group: "ИП", kind: PANELS, diagonal: 75, qty: 69, stagnantQty: 40 },
      { key: "ИП|Интерактивные панели|86", group: "ИП", kind: PANELS, diagonal: 86, qty: 10, stagnantQty: 10 },
      { key: "КТ|Компьютеры и системные блоки|", group: "КТ", kind: "Компьютеры и системные блоки", diagonal: null, qty: 30, stagnantQty: 30 },
      { key: "КТ|Моноблоки|", group: "КТ", kind: "Моноблоки", diagonal: null, qty: 7, stagnantQty: 0 },
      { key: "КТ|Ноутбуки|", group: "КТ", kind: "Ноутбуки", diagonal: null, qty: 25, stagnantQty: 0 }
    ]);
    const json = JSON.stringify(av);
    for (const secret of [...STOCK_COMPANIES, ...STOCK_WAREHOUSES, "Образец", "Пример", "Демо", "Кронштейн", "Кабель"]) expect(json, secret).not.toContain(secret);
    for (const sum of STOCK_SUMS) expect(json).not.toContain(String(sum));
    expect(json).not.toMatch(/Sum|company|warehouse|name/);
  });

  it("сумма штук по строкам равна сумме конечных остатков классифицированных позиций", () => {
    const items = stockSheets().flatMap((s) => s.warehouses.flatMap((w) => w.items.map((item) => ({ item, hasMoves: s.hasMoves }))));
    const classified = items.filter(({ item }) => item.endQty > 0 && classifyStockName(item.name));
    expect(availability().rows.reduce((s, r) => s + r.qty, 0)).toBe(classified.reduce((s, { item }) => s + item.endQty, 0));
    expect(availability().rows.reduce((s, r) => s + r.stagnantQty, 0))
      .toBe(classified.filter(({ item, hasMoves }) => isStockStagnant(hasMoves, item)).reduce((s, { item }) => s + item.endQty, 0));
    // классификация — те же функции Радара
    for (const { item } of classified) {
      const group = classifyProductGroup("", item.name)!;
      expect(classifyStockName(item.name)?.kind).toBe(classifyKind(group, "", item.name));
    }
  });

  it("отчёт старше 3 дней помечается устаревшим", () => {
    expect(buildStockAvailability(stockFinance("2026-11-18"), "2026-11-21")!.stale).toBe(false);
    expect(buildStockAvailability(stockFinance("2026-11-17"), "2026-11-21")!.stale).toBe(true);
  });

  it("нет финансов, отчёта или склада — null", () => {
    expect(buildStockAvailability(undefined, "2026-11-21")).toBeNull();
    expect(buildStockAvailability({ snapshots: [], error: "нет" }, "2026-11-21")).toBeNull();
    const finance = stockFinance();
    expect(buildStockAvailability({ ...finance, report: { ...finance.report!, stock: undefined } }, "2026-11-21")).toBeNull();
    expect(buildStockAvailability({ ...finance, report: { ...finance.report!, stock: [] } }, "2026-11-21")).toBeNull();
  });
});

describe("matchStock", () => {
  it("точно по диагонали из названия карточки, иначе итог по виду с approx", () => {
    const av = availability();
    expect(matchStock(av, { group: "ИП", kind: PANELS, itemName: "Интерактивная панель 75" })).toEqual({ qty: 69, diagonal: 75, approx: false });
    expect(matchStock(av, { group: "ИП", kind: PANELS, itemName: "Панель интерактивная 86\"" })).toEqual({ qty: 10, diagonal: 86, approx: false });
    // диагональ в названии без склада такого размера — только панели неизвестного размера, приблизительно
    expect(matchStock(av, { group: "ИП", kind: PANELS, itemName: "Интерактивная панель 65" })).toEqual({ qty: 4, diagonal: null, approx: true });
    expect(matchStock(av, { group: "ИП", kind: PANELS, itemName: "Интерактивная панель" })).toEqual({ qty: 83, diagonal: null, approx: true });
    expect(matchStock(av, { group: "КТ", kind: "Ноутбуки", itemName: "Ноутбук для учителя" })).toEqual({ qty: 25, diagonal: null, approx: true });
    expect(matchStock(av, { group: "ИП", kind: "Интерактивные и спец. доски", itemName: "Интерактивная доска" })).toBeNull();
    expect(matchStock(av, { group: "КТ", kind: "МФУ и принтеры", itemName: "МФУ" })).toBeNull();
    expect(matchStock(null, { group: "ИП", kind: PANELS, itemName: "Интерактивная панель 75" })).toBeNull();
    const only75: StockAvailability = { ...av, rows: av.rows.filter((r) => r.diagonal === 75) };
    expect(matchStock(only75, { group: "ИП", kind: PANELS, itemName: "Интерактивная панель 65" })).toBeNull();
  });
});

describe("подсказки на карточки и спрос", () => {
  it("подсказки сгруппированы по результату и привязаны к ID лотов и планов", () => {
    const av = withStockHints(availability(), stockRadar(), plans());
    const byId = new Map(av.hints!.flatMap((h) => h.ids.map((id) => [id, { qty: h.qty, diagonal: h.diagonal, approx: h.approx }])));
    expect(Object.fromEntries(byId)).toEqual({
      5101: { qty: 69, diagonal: 75, approx: false },
      5105: { qty: 69, diagonal: 75, approx: false },
      6101: { qty: 69, diagonal: 75, approx: false },
      6102: { qty: 69, diagonal: 75, approx: false },
      5102: { qty: 10, diagonal: 86, approx: false },
      5103: { qty: 83, diagonal: null, approx: true },
      5106: { qty: 30, diagonal: null, approx: true },
      5107: { qty: 25, diagonal: null, approx: true }
    });
    expect(av.hints!.length).toBe(5);
    expect(withStockHints(availability(), null, null).hints).toEqual([]);
  });

  it("спрос: открытые лоты Радара (подать и обсуждение) и открытые планы, план с лотом — один раз", () => {
    const demand = buildStockDemand(availability(), stockRadar(), plans());
    expect(demand).toEqual([
      { key: "ИП|Интерактивные панели|", lots: 1, qty: 6, approxLots: 1 },
      // 5101 (10 шт) + 6101 (8 шт) + 5103 без диагонали (6 шт); 6102 — тот же план 70001, что лот 5101; 5105 — второй шанс
      { key: "ИП|Интерактивные панели|75", lots: 3, qty: 24, approxLots: 1 },
      { key: "ИП|Интерактивные панели|86", lots: 2, qty: 26, approxLots: 1 },
      { key: "КТ|Компьютеры и системные блоки|", lots: 1, qty: 30, approxLots: 0 },
      { key: "КТ|Ноутбуки|", lots: 1, qty: 40, approxLots: 0 }
    ]);
    expect(buildStockDemand(null, stockRadar(), plans())).toEqual([]);
    expect(buildStockDemand(availability(), null, { asOf: "2026-11-21", error: "нет" })).toEqual([]);
  });

  it("у позиций без расхода на «Финансах» есть ключ склада для строки спроса", () => {
    const insights = buildFinanceInsights(stockFinance(), "2026-11-21");
    expect(insights.stock.top5.map((x) => [x.name, x.stockKey])).toEqual([
      ["Интерактивная панель Образец 75″", "ИП|Интерактивные панели|75"],
      ["Интерактивная панель Пример 86\"", "ИП|Интерактивные панели|86"],
      ["Компьютер Тестовый i5", "КТ|Компьютеры и системные блоки|"],
      ["Кронштейн для интерактивной панели", null],
      ["Кабель тестовый", null]
    ]);
  });
});

describe("payload.stock при чтении и в виде менеджера", () => {
  it("zod пропускает верный склад и отбрасывает битый с числом ошибок", () => {
    const av = withStockHints(availability(), stockRadar(), plans());
    expect(parsePayloadStock(JSON.parse(JSON.stringify(av)))).toEqual({ ok: true, stock: av });
    expect(parsePayloadStock(undefined)).toEqual({ ok: true, stock: undefined });
    expect(parsePayloadStock(null)).toEqual({ ok: true, stock: null });
    const broken = [
      { ...av, stale: "нет" },
      { ...av, rows: [{ ...av.rows[0], qty: "69" }] },
      { ...av, rows: [{ ...av.rows[0], endSum: 12_345_678 }] },
      { ...av, company: STOCK_COMPANIES[0] },
      { ...av, asOf: "20.11.2026" },
      { ...av, hints: [{ qty: 5, diagonal: null, approx: false, ids: [5101] }] },
      "склад", []
    ];
    for (const value of broken) {
      const result = parsePayloadStock(value);
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(result.issues).toBeGreaterThan(0);
    }
  });

  it("в виде оставляет подсказки только для своих карточек и планов", () => {
    const av = withStockHints(availability(), stockRadar(), plans());
    const own = buildPlansMonitorView(stockPlanDeals().filter((d) => d.managerId === "s"), { asOfDate: "2026-11-21" });
    const viewer = { plans: own, radar: null } as Pick<SalesPultPayload, "plans" | "radar">;
    const filtered = stockForViewer(av, viewer)!;
    expect(filtered.rows).toEqual(av.rows);
    expect(filtered.hints).toEqual([{ qty: 69, diagonal: 75, approx: false, ids: ["6101"] }]);
    expect(stockForViewer(null, viewer)).toBeNull();
    expect(stockForViewer(undefined, viewer)).toBeUndefined();
  });
});
