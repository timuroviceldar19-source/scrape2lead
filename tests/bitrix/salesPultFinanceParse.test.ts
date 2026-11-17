import { describe, expect, it } from "vitest";
import { financeSnapshot, FinanceParseError, parseFinanceExcel, parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import { DEFAULT_DEBTORS, FIN_COMPANIES, financeWorkbook, financeWorkbookBuffer } from "../fixtures/sales-pult/financeWorkbook.js";

// Все данные выдуманные (tests/fixtures/sales-pult/financeWorkbook.ts).

describe("финансы: разбор ежедневного отчёта", () => {
  it("находит дату, период, компании и считает прибыль по счетам", () => {
    const r = parseFinanceWorkbook(financeWorkbook());
    expect(r.dataDate).toBe("2026-11-16");
    expect(r.periodLabel).toBe("01.11. - 16.11.2026");
    expect(r.companies).toEqual(FIN_COMPANIES);
    expect(r.pnl.current).toMatchObject({
      date: "2026-11-16",
      revenue: { values: [6_000_000, 0, 0], total: 6_000_000 },
      cost: { total: 4_000_000 },
      expenses: { values: [600_000, 10_000, 5_000], total: 615_000 },
      profit: { values: [1_400_000, -10_000, -5_000], total: 1_385_000 }
    });
    expect(r.pnl.previous).toMatchObject({
      date: "2026-10-31",
      revenue: { total: 10_500_000 },
      cost: { total: 6_300_000 },
      expenses: { values: [1_500_000, 50_000, 50_000], total: 1_600_000 },
      profit: { total: 2_600_000 }
    });
    expect(r.balances.map((b) => [b.code, b.total])).toEqual([["1210", 10_100_000], ["3310", 4_100_000]]);
    expect(r.tax).toEqual({ date: "2026-11-11", label: "КПН", values: [600_000, 20_000, 0], total: 620_000 });
    expect(r.rates).toEqual([{ label: "Курс покупки USD", value: 450.5 }]);
    expect(r.warnings).toEqual([]);
  });

  it("деньги по банкам, ТМЦ и движение денег за день", () => {
    const r = parseFinanceWorkbook(financeWorkbook());
    expect(r.cash.banks).toEqual(["Банк Один", "Банк Два", "Касса"]);
    expect(r.cash.rows.map((x) => x.company)).toEqual(["Альфа", "Бета", "Гамма"]);
    expect(r.cash.rows[0]).toEqual({ company: "Альфа", byBank: [1_000_000, 200_000, 0], total: 1_200_000, inventory: 9_000_000 });
    expect(r.cash.total).toBeCloseTo(1_550_000.27, 2);
    expect(r.cash.inventory).toBe(10_000_000);
    expect(r.cashFlow).toEqual({ prevDate: "2026-11-16", prev: 2_000_000, today: 1_550_000.27, withoutIncoming: 700_000.27, spent: 1_299_999.73 });
  });

  it("поступления: плательщики в колонках, компании в строках", () => {
    const r = parseFinanceWorkbook(financeWorkbook());
    expect(r.incoming).toEqual([
      { payer: "Плательщик Один", company: "Альфа", amount: 700_000 },
      { payer: "Плательщик Два", company: "Альфа", amount: 100_000 },
      { payer: "Плательщик Два", company: "Гамма", amount: 50_000 }
    ]);
    expect(r.incomingTotal).toBe(850_000);
  });

  it("дебиторы, проблемные долги, кредиторка и кредит", () => {
    const r = parseFinanceWorkbook(financeWorkbook());
    expect(r.debtors.companies).toEqual(["Альфа", "Бета"]);
    expect(r.debtors.rows).toEqual([
      { name: "Школа Тест №1", company: "Альфа", amount: 5_000_000, saleDate: "2026-11-05" },
      { name: "Колледж Пример", company: "Альфа", amount: 3_000_000, saleDate: "2026-09-01" },
      { name: "Учреждение Образец", company: "Бета", amount: 2_000_000, saleDate: "2026-06-01", note: "претензия 01.09.2026" }
    ]);
    expect(r.debtors.totals).toEqual([8_000_000, 2_000_000]);
    expect(r.problemDebts?.rows.map((x) => [x.name, x.company, x.amount, x.note ?? ""])).toEqual([
      ["ТОО Должник", "Альфа", 400_000, "Решение суда 01.04.2025"],
      ["ИП Пропавший", "Бета", 300_000, ""]
    ]);
    expect(r.liabilities).toEqual([
      { label: "Кредиторы", values: [4_000_000, 100_000], total: 4_100_000 },
      { label: "Кредит Банк Один", values: [12_000_000, 0], total: 12_000_000 }
    ]);
  });

  it("платёжный календарь, прочие платежи и «Топ» со своим итогом; блок КПН пропускается", () => {
    const r = parseFinanceWorkbook(financeWorkbook());
    expect(r.payments.map((l) => [l.label, l.items.length, l.total])).toEqual([
      ["Календарь платежей", 2, 2_200_000],
      ["Прочие платежи", 2, 1_200_000],
      ["Топ-3 расходов с бюджета", 2, 70_000]
    ]);
    expect(r.payments[0].items[0]).toEqual({ tag: "А1", payee: "Поставщик Север", amount: 1_500_000, basis: "ТМЦ" });
    expect(r.payments[2].items[0].payee).toBe("Подрядчик Один Договор №1");
  });

  it("длинный список дебиторов сдвигает блоки ниже — они всё равно находятся", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `Должник ${i + 1}`, company: (i % 2) as 0 | 1, amount: 100_000 + i, date: "2026-10-01" }));
    const r = parseFinanceWorkbook(financeWorkbook({ debtors: [...DEFAULT_DEBTORS, ...many] }));
    expect(r.debtors.rows).toHaveLength(43);
    expect(r.problemDebts?.rows).toHaveLength(2);
    expect(r.liabilities.map((x) => x.label)).toEqual(["Кредиторы", "Кредит Банк Один"]);
    expect(r.payments.map((l) => l.total)).toEqual([2_200_000, 1_200_000, 70_000]);
    expect(r.warnings).toEqual([]);
  });

  it("итог в файле не сходится со строками — предупреждение, разбор продолжается", () => {
    const r = parseFinanceWorkbook(financeWorkbook({ alphaDebtorsTotal: 7_000_000 }));
    expect(r.debtors.totals[0]).toBe(8_000_000);
    expect(r.warnings).toHaveLength(1);
    // Intl ru-RU разделяет разряды неразрывным пробелом.
    expect(r.warnings[0].replace(/\s/g, " ")).toMatch(/^Дебиторы, Альфа: итог в файле 7 000 000 ₸, сумма строк 8 000 000 ₸$/);
  });

  it("остаток в блоке движения денег не равен деньгам на счетах — блок не показывается", () => {
    const r = parseFinanceWorkbook(financeWorkbook({ cashFlowToday: 9 }));
    expect(r.cashFlow).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/Движение денег за день/);
  });

  it("пропал обязательный блок или лист — понятная ошибка без сумм и названий из файла", () => {
    const cases: Array<[Parameters<typeof financeWorkbook>[0], RegExp]> = [
      [{ omitDebtors: true }, /не найден блок «Дебиторы»/],
      [{ omitCash: true }, /не найден блок денег/],
      [{ sheetName: "Лист1" }, /нет листа «Ежед\.»/]
    ];
    for (const [options, message] of cases) {
      let error: unknown;
      try {
        parseFinanceWorkbook(financeWorkbook(options));
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(FinanceParseError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toMatch(/\d{4,}|Альфа|Банк/);
    }
  });

  it("читает файл .xlsx целиком (формулы — по сохранённым значениям) и даёт запись дня", async () => {
    const r = await parseFinanceExcel(await financeWorkbookBuffer());
    expect(r.dataDate).toBe("2026-11-16");
    expect(financeSnapshot(r)).toEqual({
      dataDate: "2026-11-16",
      cash: r.cash.total,
      inventory: 10_000_000,
      debtors: 10_000_000,
      problemDebts: 700_000,
      payables: 4_100_000,
      loans: 12_000_000,
      paymentsDue: 2_200_000,
      revenue: 6_000_000,
      profit: 1_385_000
    });
    await expect(parseFinanceExcel(Buffer.from("not a zip"))).rejects.toThrow(/не читается как \.xlsx/);
  });
});
