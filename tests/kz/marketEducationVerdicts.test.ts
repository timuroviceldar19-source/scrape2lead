import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEducationVerdicts, loadEducationVerdicts } from "../../src/kz/market/educationVerdicts.js";
import { EDUCATION_CODE } from "../../src/kz/market/educationImport.js";
import { buildMarketView } from "../../src/kz/market/aggregate.js";
import { loadMarketView } from "../../src/kz/market/load.js";
import { loadMarketConfig, marketConfigKey } from "../../src/kz/market/config.js";
import type { MarketUnit } from "../../src/kz/market/types.js";

const cfg = { ...loadMarketConfig(), ourBins: ["111111111111", "222222222222"], ourCompanyNames: { "111111111111": "Компания Альфа", "222222222222": "Компания Бета" } };
const unit = (id: number, sum: number, extra: Partial<MarketUnit> = {}): MarketUnit => ({
  id, sum, month: "2026-10", date: "2026-10-15", group: "ИП", code: EDUCATION_CODE,
  kind: "Учебные комплекты", qty: 1, price: sum, supplier: `supplier-${id}`, customer: `customer-${id}`,
  supplierName: `Поставщик ${id}`, customerName: `Заказчик ${id}`, method: `Канал ${id}`, us: false, ...extra
});
const verdicts = [{ id: "1", verdict: "Да", source: "договор" }, { id: "2", verdict: "Нет", source: "объявление" }, { id: "3", verdict: "Нет", source: "договор" }];
const dirs: string[] = [];
function files(units: MarketUnit[], decisions: unknown = verdicts, updatedAt?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-verdicts-")); dirs.push(dir);
  const unitsFilePath = path.join(dir, "units.json"), educationVerdictsFilePath = path.join(dir, "verdicts.json");
  fs.writeFileSync(unitsFilePath, JSON.stringify({ units, updatedAt }));
  fs.writeFileSync(educationVerdictsFilePath, JSON.stringify(decisions));
  return { unitsFilePath, educationVerdictsFilePath, todayAlmaty: "2026-11-06", cfg };
}
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });

describe("вердикты учебных комплектов", () => {
  it("удаляет Нет из всех срезов, доли, места и YTD, оставляя Да целиком", () => {
    const yes = unit(1, 40, { supplier: "111111111111" });
    const no = unit(2, 100, { kind: "Исключаемый вид" });
    const partnerNo = unit(3, 200, { supplier: "222222222222" });
    const panel = unit(4, 60, { code: "262030.100.000021", kind: "Панели" });
    const previous = unit(2, 80, { month: "2026-09", date: "2026-09-15" });
    const input = [yes, no, partnerNo, panel, previous];
    const opts = files(input);
    const view = loadMarketView(opts);
    const expected = buildMarketView([yes, panel], opts.todayAlmaty, cfg);
    expect(view.ip).toEqual(expected.ip);
    const oct = view.ip!.monthViews!["2026-10"];
    expect(oct.total.sum).toBe(100);
    expect(oct.kinds.find(k => k.kind === "Учебные комплекты")!.sum).toBe(40);
    expect(oct.us).toMatchObject({ sum: 40, share: .4, rank: 2 });
    expect(oct.ytd).toMatchObject({ totalSum: 100, sum: 40, share: .4, rank: 2 });
    expect(oct.ytd!.companies.find(c => c.bin === "222222222222")!.sum).toBe(0);
    expect(view.ip!.months).toHaveLength(1);
    expect(oct.lost.map(x => x.id)).toEqual([4]);
    const before = buildMarketView(input, opts.todayAlmaty, cfg).ip!.monthViews!["2026-10"];
    expect(before.us.rank).toBe(1);
    expect(before.us.share).toBe(.6);
    expect(fs.readFileSync(opts.unitsFilePath, "utf8")).toBe(JSON.stringify({ units: input }));
  });

  it("применяет вердикт ко всем позициям кода; другие коды и вся КТ неизменны", () => {
    const hardware = ["262030.100.000021", "262030.100.000043", "262030.100.000011", "262030.100.000013", "279020.100.000001"].map((code, i) => unit(2, 10 + i, { code, kind: `Техника ${i}` }));
    const kt = unit(2, 500, { code: "262013.000.000011", group: "КТ", kind: "Компьютеры" });
    const kits = [unit(1, 20, { unitIndex: 0 }), unit(1, 30, { unitIndex: 1 }), unit(2, 70), unit(2, 80, { unitIndex: 1 })];
    const opts = files([...kits, ...hardware, kt]);
    const original = structuredClone([...kits, ...hardware, kt]);
    const filtered = applyEducationVerdicts(original, loadEducationVerdicts(opts.educationVerdictsFilePath));
    expect(filtered.units).toEqual([...kits.slice(0, 2), ...hardware, kt]);
    expect(filtered.excludedContracts).toBe(1);
    expect(original).toEqual([...kits, ...hardware, kt]);
    expect(loadMarketView(opts).kt).toEqual(buildMarketView(original, opts.todayAlmaty, cfg).kt);
  });

  it("неизвестный договор не входит в суммы; по месяцам сумма позиций и уникальные id", () => {
    const unknown = [unit(7, 10), unit(7, 20, { unitIndex: 1 }), unit(8, 40, { month: "2026-09", date: "2026-09-01" })];
    const opts = files([unit(1, 50), ...unknown]);
    const view = loadMarketView(opts);
    expect(view.educationPending).toEqual({
      "2026-09": { contracts: 1, sum: 40, ids: [8] },
      "2026-10": { contracts: 1, sum: 30, ids: [7] }
    });
    expect(view.ip!.monthViews!["2026-10"].total.sum).toBe(50);
    expect(view.ip!.monthViews!["2026-09"].total.sum).toBe(0);
    expect(view.ip!.monthViews!["2026-09"].ytd!.totalSum).toBe(0);
  });

  it("показывает месяц только с ожидающими проверки и не меняет дату обновления", () => {
    const opts = files([unit(7, 25, { month: "2026-11", date: "2026-11-05" })], verdicts, "2026-11-05");
    expect(loadMarketView(opts)).toMatchObject({ updatedAt: "2026-11-05", educationPending: { "2026-11": { contracts: 1, sum: 25, ids: [7] } } });
    expect(loadMarketView(opts).ip!.total.sum).toBe(0);
    expect(loadMarketView(opts).ip!.monthViews!["2026-11"]).toBeDefined();
  });

  it("не меняет дату даже когда последняя позиция исключена; лог содержит только числа договоров", () => {
    const opts = files([unit(2, 7654321), unit(7, 1234567)], verdicts, "2026-11-04");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(loadMarketView(opts).updatedAt).toBe("2026-11-04");
    expect(log.mock.calls.flat().filter(s => String(s).includes("Учебные комплекты"))).toEqual(["[Рынок] Учебные комплекты: исключено договоров: 1, на проверке: 1"]);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/7654321|1234567|Поставщик|Заказчик/);
  });

  it("maxDate берётся до фильтра, если метаданных даты нет; полностью исключённый кэш даёт нули", () => {
    const input = [unit(2, 500, { month: "2026-11", date: "2026-11-05" })];
    const opts = files(input);
    vi.spyOn(fs, "statSync").mockImplementation(() => { throw new Error("Нет даты файла"); });
    const view = loadMarketView(opts);
    expect(view.updatedAt).toBe("2026-11-05");
    expect(view.ip!.total.sum).toBe(0);
    expect(view.kt).toEqual(buildMarketView(input, opts.todayAlmaty, cfg).kt);
  });

  it.each([
    [{ ...verdicts[0], verdict: "Спорно" }], [{ ...verdicts[0], source: "другое" }],
    [verdicts[0], verdicts[0]], [{ ...verdicts[0], sum: 123 }],
    [{ ...verdicts[0], id: "01" }], [{ ...verdicts[0], id: 1 }], [{ id: "1", verdict: "Да" }], {}, null
  ].map(decisions => ({ decisions })))("не принимает некорректный файл %#", ({ decisions }) => {
    const opts = files([unit(1, 10)], decisions);
    expect(() => loadEducationVerdicts(opts.educationVerdictsFilePath)).toThrow();
    expect(() => loadMarketView(opts)).toThrow();
  });

  it("падает без файла и при повреждённом JSON, даже при пустом кэше", () => {
    const opts = files([]);
    fs.writeFileSync(opts.educationVerdictsFilePath, "{");
    expect(() => loadMarketView(opts)).toThrow();
    fs.unlinkSync(opts.educationVerdictsFilePath);
    expect(() => loadMarketView(opts)).toThrow();
  });

  it("реальный файл содержит все решения, уникальные id и только три поля; ключ рынка прежний", () => {
    const originalConfig = fs.readFileSync("config/market-monitor.json", "utf8");
    const key = marketConfigKey(loadMarketConfig());
    expect(key).toBe("8828053341ebd421");
    const rows = loadEducationVerdicts();
    // Новые договоры дописываются по мере проверки (06.11 — 192, 12.11 — ещё 14).
    expect(rows.length).toBeGreaterThanOrEqual(206);
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
    expect(rows.every(r => Object.keys(r).sort().join(",") === "id,source,verdict")).toBe(true);
    expect(rows.every(r => ["Да", "Нет"].includes(r.verdict) && ["договор", "объявление"].includes(r.source))).toBe(true);
    loadMarketView(files([unit(1, 100)]));
    expect(fs.readFileSync("config/market-monitor.json", "utf8")).toBe(originalConfig);
    expect(marketConfigKey(loadMarketConfig())).toBe(key);
  });
});
