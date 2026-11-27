// Выдуманные книги ОПиУ («ОПиУ» + «Расш. ОПиУ») и 1С «Отчет о реализации» (Клиент-ТМЦ и ТМЦ-Клиент)
// для тестов. Все названия организаций, контрагентов, статей и товаров придуманы.
import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import type { RealizationKind } from "../../../src/bitrix/salesPult/finance/realizationTypes.js";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const f = (formula: string, result?: number) => (result === undefined ? { formula } : { formula, result });

export interface OpiuFixtureOptions {
  /** Добавить расхождение в расшифровке 013 для проверки сверки. */
  mismatchSelling?: boolean;
  /** Убрать формулы ссылок — проверить запасную привязку по названию раздела. */
  valuesOnly?: boolean;
  /** Добавить вторую компанию («ОПиУ_BETA» + «Расш. ОПиУ_BETA») в формате «Наименование организации: ... . Период: ...». */
  multiCompany?: boolean;
}

/** Создаёт выдуманную книгу ОПиУ (2025 + 9 мес. 2026) с 1- и 2-уровневыми расшифровками. */
export async function opiuWorkbookBuffer(options: OpiuFixtureOptions = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const opiu = wb.addWorksheet("ОПиУ");
  const rash = wb.addWorksheet("Расш. ОПиУ");

  // ---------- лист «Расш. ОПиУ» ----------
  rash.getCell("B1").value = "тенге без НДС";
  // Колонки: B=название, C..N = 2025-01..2025-12, P(16)=2025, R..AC(18..29) = 2026-01..2026-12, AE(31)=2026
  const rashMonths25 = Array.from({ length: 12 }, (_, i) => ({ c: 3 + i, d: d(`2025-${String(i + 1).padStart(2, "0")}-01`) }));
  const rashMonths26 = Array.from({ length: 12 }, (_, i) => ({ c: 18 + i, d: d(`2026-${String(i + 1).padStart(2, "0")}-01`) }));
  const setRashHeader = (r: number) => {
    rash.getCell(r, 2).value = "Наименование статьи";
    rash.getCell(r, 2).font = { bold: true };
    for (const m of rashMonths25) {
      rash.getCell(r, m.c).value = m.d;
      rash.getColumn(m.c).hidden = true;
    }
    rash.getCell(r, 16).value = "2025";
    for (const m of rashMonths26) {
      rash.getCell(r, m.c).value = m.d;
      rash.getColumn(m.c).hidden = true;
    }
    rash.getCell(r, 31).value = "2026";
  };

  const setRashRow = (
    r: number,
    label: string,
    opts: { bold?: boolean; m25?: Record<number, number>; m26?: Record<number, number> }
  ) => {
    rash.getCell(r, 2).value = label;
    if (opts.bold) rash.getCell(r, 2).font = { bold: true };
    let s25 = 0;
    for (const [m, val] of Object.entries(opts.m25 ?? {})) {
      rash.getCell(r, 2 + Number(m)).value = val;
      s25 += val;
    }
    rash.getCell(r, 16).value = s25 ? f(`SUM(C${r}:N${r})`, s25) : f(`SUM(C${r}:N${r})`);
    let s26 = 0;
    for (const [m, val] of Object.entries(opts.m26 ?? {})) {
      rash.getCell(r, 17 + Number(m)).value = val;
      s26 += val;
    }
    rash.getCell(r, 31).value = s26 ? f(`SUM(R${r}:AC${r})`, s26) : f(`SUM(R${r}:AC${r})`);
  };

  // Раздел 010: Выручка (1-уровневый) — строка итога 4
  setRashHeader(3);
  setRashRow(4, "Расшифровка Доходов (строка 010 ОПиУ)", { bold: true, m25: { 1: 50_000_000, 2: 70_000_000 }, m26: { 1: 40_000_000, 2: 60_000_000 } });
  setRashRow(5, "ТОО Заказчик Альфа Договор №1", { m25: { 1: 50_000_000 }, m26: { 1: 40_000_000 } });
  setRashRow(6, "ТОО Заказчик Бета Договор №2", { m25: { 2: 70_000_000 }, m26: { 2: 60_000_000 } });

  // Раздел 011: Себестоимость (1-уровневый) — строка итога 9
  setRashHeader(8);
  setRashRow(9, "Расшифровка Себестоимости (строка 011 ОПиУ)", { bold: true, m25: { 1: 30_000_000, 2: 40_000_000 }, m26: { 1: 25_000_000, 2: 35_000_000 } });
  setRashRow(10, "Панель тестовая 75", { m25: { 1: 30_000_000, 2: 40_000_000 }, m26: { 1: 25_000_000, 2: 35_000_000 } });

  // Раздел 013: Расходы по реализации (2-уровневый: жирные категории -> контрагенты/сотрудники) — строка итога 13
  setRashHeader(12);
  const sell26Extra = options.mismatchSelling ? 500_000 : 0;
  setRashRow(13, "Расшифровка Расходов по реализации (строка ОПиУ)", {
    bold: true,
    m25: { 1: 8_000_000, 2: 12_000_000 },
    m26: { 1: 6_000_000 + sell26Extra, 2: 9_000_000 }
  });
  // Жирная категория 1: Агентские услуги
  setRashRow(14, "Агентские услуги Реализация", { bold: true, m25: { 1: 5_000_000, 2: 7_000_000 }, m26: { 1: 3_500_000, 2: 5_500_000 } });
  setRashRow(15, "ТОО Партнёр Восток Договор №10", { m25: { 1: 5_000_000 }, m26: { 1: 3_500_000 } });
  setRashRow(16, "ИП Агент Запад Без договора", { m25: { 2: 7_000_000 }, m26: { 2: 5_500_000 } });
  // Жирная категория 2: Зарплата
  setRashRow(17, "Заработная плата Реализация", { bold: true, m25: { 1: 3_000_000, 2: 5_000_000 }, m26: { 1: 2_500_000, 2: 3_500_000 } });
  setRashRow(18, "Сотрудник Первый", { m25: { 1: 3_000_000 }, m26: { 1: 2_500_000 } });
  setRashRow(19, "Сотрудник Второй", { m25: { 2: 5_000_000 }, m26: { 2: 3_500_000 } });

  // Раздел 014: Административные расходы (2-уровневый) — строка итога 22
  setRashHeader(21);
  setRashRow(22, "Расшифровка Административных расходов (строка 014 ОПиУ)*", {
    bold: true,
    m25: { 1: 4_000_000, 2: 6_000_000 },
    m26: { 1: 5_000_000, 2: 5_000_000 }
  });
  setRashRow(23, "Аренда офиса АУП", { bold: true, m25: { 1: 4_000_000, 2: 6_000_000 }, m26: { 1: 5_000_000, 2: 5_000_000 } });
  setRashRow(24, "Бизнес-центр Тест Договор аренды", { m25: { 1: 4_000_000, 2: 6_000_000 }, m26: { 1: 5_000_000, 2: 5_000_000 } });

  // ---------- лист «ОПиУ» ----------
  opiu.getCell("D2").value = "Отчет о прибылях и убытках";
  opiu.getCell("D4").value = "Наименование организации";
  opiu.getCell("F4").value = "ТОО «Тест-ОПиУ»";

  // Шапка в строке 6: B=Наименование показателей, D=Код строки, E..P(5..16)=2025 мес., Q(17)=2025, R..AC(18..29)=2026 мес., AD(30)=9 мес. 2026
  opiu.getCell(6, 2).value = "Наименование показателей";
  opiu.getCell(6, 2).font = { bold: true };
  opiu.getCell(6, 4).value = "Код строки";
  opiu.getColumn(4).hidden = true;
  for (let i = 0; i < 12; i++) {
    opiu.getCell(6, 5 + i).value = d(`2025-${String(i + 1).padStart(2, "0")}-01`);
    opiu.getColumn(5 + i).hidden = true;
  }
  opiu.getCell(6, 17).value = "2025";
  for (let i = 0; i < 12; i++) {
    opiu.getCell(6, 18 + i).value = d(`2026-${String(i + 1).padStart(2, "0")}-01`);
    opiu.getColumn(18 + i).hidden = true;
  }
  opiu.getCell(6, 30).value = "9 мес. 2026";

  const addOpiuRow = (
    r: number,
    code: string,
    label: string,
    opts: {
      bold?: boolean;
      pct?: boolean;
      rashRow?: number;
      m25?: Record<number, number>;
      m26?: Record<number, number>;
      y25?: number;
      y26?: number;
    }
  ) => {
    opiu.getCell(r, 2).value = label;
    if (opts.bold) opiu.getCell(r, 2).font = { bold: true };
    opiu.getCell(r, 4).value = code;
    if (opts.pct) {
      opiu.getCell(r, 17).numFmt = "0%";
      opiu.getCell(r, 30).numFmt = "0%";
    }
    let s25 = 0;
    for (const [m, val] of Object.entries(opts.m25 ?? {})) {
      const col = 4 + Number(m);
      opiu.getCell(r, col).value =
        opts.rashRow && !options.valuesOnly && Number(m) === 1
          ? f(`'Расш. ОПиУ'!C${opts.rashRow}`, val)
          : val;
      s25 += val;
    }
    opiu.getCell(r, 17).value = opts.y25 ?? s25;

    let s26 = 0;
    for (const [m, val] of Object.entries(opts.m26 ?? {})) {
      opiu.getCell(r, 17 + Number(m)).value = val;
      s26 += val;
    }
    opiu.getCell(r, 30).value = opts.y26 ?? s26;
  };

  addOpiuRow(7, "010", "Выручка", { rashRow: 4, m25: { 1: 50_000_000, 2: 70_000_000 }, m26: { 1: 40_000_000, 2: 60_000_000 } });
  addOpiuRow(8, "011", "Себестоимость реализованных товаров и услуг", { rashRow: 9, m25: { 1: 30_000_000, 2: 40_000_000 }, m26: { 1: 25_000_000, 2: 35_000_000 } });
  addOpiuRow(9, "012", "Валовая прибыль", { bold: true, m25: { 1: 20_000_000, 2: 30_000_000 }, m26: { 1: 15_000_000, 2: 25_000_000 } });
  // Маржа: помесячно пустая (как в реальном файле), должна досчитаться парсером из 012/010
  addOpiuRow(10, "Маржа", "Маржа", { bold: true, pct: true, y25: 50 / 120, y26: 40 / 100 });
  addOpiuRow(11, "013", "Расходы по реализации", { rashRow: 13, m25: { 1: 8_000_000, 2: 12_000_000 }, m26: { 1: 6_000_000, 2: 9_000_000 } });
  addOpiuRow(12, "014", "Административные расходы", { rashRow: 22, m25: { 1: 4_000_000, 2: 6_000_000 }, m26: { 1: 5_000_000, 2: 5_000_000 } });
  addOpiuRow(13, "020", "Итого операционная прибыль (убыток)", { bold: true, m25: { 1: 8_000_000, 2: 12_000_000 }, m26: { 1: 4_000_000, 2: 11_000_000 } });
  addOpiuRow(14, "300", "Прибыль за год", { bold: true, m25: { 1: 6_400_000, 2: 9_600_000 }, m26: { 1: 3_200_000, 2: 8_800_000 } });

  if (options.multiCompany) {
    // Дополнительная компания в книге: идёт раньше основного листа в порядке вкладок,
    // но парсер должен ставить основной «ОПиУ» первым.
    const opiuBeta = wb.addWorksheet("ОПиУ_BETA");
    const rashBeta = wb.addWorksheet("Расш. ОПиУ_BETA");

    rashBeta.getCell("B1").value = "тенге без НДС";
    rashBeta.getCell(3, 2).value = "Наименование статьи";
    rashBeta.getCell(3, 3).value = d("2025-01-01");
    rashBeta.getCell(3, 4).value = "2025";
    rashBeta.getCell(3, 5).value = d("2026-01-01");
    rashBeta.getCell(3, 6).value = "2026";
    rashBeta.getCell(3, 7).value = "Всего";

    const setBetaRash = (r: number, label: string, v25: number, v26: number, bold = false) => {
      rashBeta.getCell(r, 2).value = label;
      if (bold) rashBeta.getCell(r, 2).font = { bold: true };
      rashBeta.getCell(r, 3).value = v25;
      rashBeta.getCell(r, 4).value = v25;
      rashBeta.getCell(r, 5).value = v26;
      rashBeta.getCell(r, 6).value = v26;
      rashBeta.getCell(r, 7).value = v25 + v26;
    };
    setBetaRash(4, "Расшифровка Доходов (строка 010 ОПиУ)", 20_000_000, 30_000_000, true);
    setBetaRash(5, "ТОО Покупатель Бета-Сервис", 20_000_000, 30_000_000);
    setBetaRash(7, "Расшифровка Административных расходов (строка 014 ОПиУ)", 5_000_000, 7_000_000, true);
    setBetaRash(8, "Подписки и ПО", 5_000_000, 7_000_000, true);
    setBetaRash(9, "Облачный сервис Тест", 5_000_000, 7_000_000);

    opiuBeta.getCell("B1").value = "Отчет о прибылях и убытках";
    opiuBeta.getCell("B2").value = "Наименование организации: ТОО Тест-Бета.kz. Период: январь 2025 – сентябрь 2026";
    opiuBeta.getCell(6, 2).value = "Наименование показателей";
    opiuBeta.getCell(6, 3).value = "Код строки";
    opiuBeta.getCell(6, 4).value = d("2025-01-01");
    opiuBeta.getCell(6, 5).value = "2025";
    opiuBeta.getCell(6, 6).value = d("2026-01-01");
    opiuBeta.getCell(6, 7).value = "2026";
    opiuBeta.getCell(6, 8).value = "Всего";

    const addBetaOpiu = (r: number, code: string, label: string, v25: number, v26: number, opts: { bold?: boolean; rashRow?: number } = {}) => {
      opiuBeta.getCell(r, 2).value = label;
      if (opts.bold) opiuBeta.getCell(r, 2).font = { bold: true };
      opiuBeta.getCell(r, 3).value = code;
      opiuBeta.getCell(r, 4).value = opts.rashRow ? f(`'Расш. ОПиУ_BETA'!C${opts.rashRow}`, v25) : v25;
      opiuBeta.getCell(r, 5).value = v25;
      opiuBeta.getCell(r, 6).value = opts.rashRow ? f(`'Расш. ОПиУ_BETA'!E${opts.rashRow}`, v26) : v26;
      opiuBeta.getCell(r, 7).value = v26;
      opiuBeta.getCell(r, 8).value = v25 + v26;
    };
    addBetaOpiu(7, "010", "Выручка", 20_000_000, 30_000_000, { rashRow: 4 });
    addBetaOpiu(8, "011", "Себестоимость реализованных товаров и услуг", 0, 0);
    addBetaOpiu(9, "012", "Валовая прибыль", 20_000_000, 30_000_000, { bold: true });
    addBetaOpiu(10, "014", "Административные расходы", 5_000_000, 7_000_000, { rashRow: 7 });
    addBetaOpiu(11, "020", "Итого операционная прибыль (убыток)", 15_000_000, 23_000_000, { bold: true });
    addBetaOpiu(12, "200", "Прибыль (убыток) после налогообложения", 12_000_000, 18_400_000, { bold: true });
    opiuBeta.getCell(14, 2).value = "Примечание: строка 011 не заполнена, так как компания оказывает услуги.";
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Создаёт выдуманный 1С-файл «Отчет о реализации товаров (услуг)» в разрезе Клиент-ТМЦ или ТМЦ-Клиент. */
export function realizationWorkbookBuffer(kind: RealizationKind): Buffer {
  const wb = XLSX.utils.book_new();

  // Данные: 2 клиента, 2 группы, 1 возврат
  // Клиент 1 («ТОО Покупатель Один»): Панели -> Панель Альфа (5 шт, 5 000 000, НДС 689 655.17, без НДС 4 310 344.83, себест 3 000 000, profit 1 310 344.83)
  // Клиент 1 («ТОО Покупатель Один»): Ноутбуки -> Ноутбук Бета (2 шт, 1 000 000, НДС 137 931.03, без НДС 862 068.97, себест 700 000, profit 162 068.97)
  // Клиент 2 («ТОО Покупатель Два»): Панели -> Панель Альфа (-1 шт возврат, -1 000 000, НДС -137 931.03, без НДС -862 068.97, себест -600 000, profit -262 068.97)
  const aoa: unknown[][] = [];
  const rowLevels: Array<{ level?: number }> = [];
  const push = (row: unknown[], level = 0) => {
    aoa.push(row);
    rowLevels.push(level > 0 ? { level } : {});
  };

  push(['ТОО "Тест-Компания"']);
  push(["Отчет о реализации товаров (услуг) за Ноябрь 2026 г."]);
  push([]);
  push(["Сортировка:", "Организация По возрастанию"]);
  push([]);

  if (kind === "client-tmc") {
    push([
      "Контрагент", "", "Количество реализации", "Количество возвратов", "Количество реализации (с возвратами)",
      "", "Сумма реализации", "Сумма возвратов", "Сумма реализации (с возвратами)", "Сумма акциза",
      "Сумма НДС", "Сумма без налогов", "Стоимость (без НДС)", "Profit (сумма)"
    ]);
    push(["Номенклатура.Номенклатурная группа"]);
    push(["Номенклатура"]);

    push(["ТОО Покупатель Один", "", 7, "", 7, "", 6_000_000, "", 6_000_000, "", 827_586.2, 5_172_413.8, 3_700_000, 1_472_413.8], 0);
    push(["Интерактивные панели", "", 5, "", 5, "", 5_000_000, "", 5_000_000, "", 689_655.17, 4_310_344.83, 3_000_000, 1_310_344.83], 1);
    push(["Панель Альфа 75", "", 5, "", 5, "", 5_000_000, "", 5_000_000, "", 689_655.17, 4_310_344.83, 3_000_000, 1_310_344.83], 2);
    push(["Ноутбуки", "", 2, "", 2, "", 1_000_000, "", 1_000_000, "", 137_931.03, 862_068.97, 700_000, 162_068.97], 1);
    push(["Ноутбук Бета 15", "", 2, "", 2, "", 1_000_000, "", 1_000_000, "", 137_931.03, 862_068.97, 700_000, 162_068.97], 2);

    push(["ТОО Покупатель Два", "", "", -1, -1, "", "", -1_000_000, -1_000_000, "", -137_931.03, -862_068.97, -600_000, -262_068.97], 0);
    push(["Интерактивные панели", "", "", -1, -1, "", "", -1_000_000, -1_000_000, "", -137_931.03, -862_068.97, -600_000, -262_068.97], 1);
    push(["Панель Альфа 75", "", "", -1, -1, "", "", -1_000_000, -1_000_000, "", -137_931.03, -862_068.97, -600_000, -262_068.97], 2);

    push(["Итого", "", 7, -1, 6, "", 6_000_000, -1_000_000, 5_000_000, "", 689_655.17, 4_310_344.83, 3_100_000, 1_210_344.83], 0);
  } else {
    push([
      "Номенклатура.Номенклатурная группа", "", "Количество реализации", "Количество возвратов", "Количество реализации (с возвратами)",
      "Сумма реализации", "", "Сумма возвратов", "Сумма реализации (с возвратами)", "Сумма акциза",
      "Сумма НДС", "Сумма без налогов", "Стоимость (без НДС)", "Profit (сумма)"
    ]);
    push(["Номенклатура"]);
    push(["Контрагент"]);

    push(["Интерактивные панели", "", 5, -1, 4, 5_000_000, "", -1_000_000, 4_000_000, "", 551_724.14, 3_448_275.86, 2_400_000, 1_048_275.86], 0);
    push(["Панель Альфа 75", "", 5, -1, 4, 5_000_000, "", -1_000_000, 4_000_000, "", 551_724.14, 3_448_275.86, 2_400_000, 1_048_275.86], 1);
    push(["ТОО Покупатель Один", "", 5, "", 5, 5_000_000, "", "", 5_000_000, "", 689_655.17, 4_310_344.83, 3_000_000, 1_310_344.83], 2);
    push(["ТОО Покупатель Два", "", "", -1, -1, "", "", -1_000_000, -1_000_000, "", -137_931.03, -862_068.97, -600_000, -262_068.97], 2);

    push(["Ноутбуки", "", 2, "", 2, 1_000_000, "", "", 1_000_000, "", 137_931.03, 862_068.97, 700_000, 162_068.97], 0);
    push(["Ноутбук Бета 15", "", 2, "", 2, 1_000_000, "", "", 1_000_000, "", 137_931.03, 862_068.97, 700_000, 162_068.97], 1);
    push(["ТОО Покупатель Один", "", 2, "", 2, 1_000_000, "", "", 1_000_000, "", 137_931.03, 862_068.97, 700_000, 162_068.97], 2);

    push(["Итого", "", 7, -1, 6, 6_000_000, "", -1_000_000, 5_000_000, "", 689_655.17, 4_310_344.83, 3_100_000, 1_210_344.83], 0);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!rows"] = rowLevels;
  XLSX.utils.book_append_sheet(wb, ws, "Лист_1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
