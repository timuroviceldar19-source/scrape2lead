import { describe, it, expect } from "vitest";
import {
  loadMarketConfig,
  classifyCode,
  cleanEntityName,
  getMethodName,
  isExcludedStatus,
  requiresTextFilter
} from "../../src/kz/market/config.js";
import { filterContractUnits } from "../../src/kz/market/filterUnits.js";

describe("market config and classifyCode", () => {
  const cfg = loadMarketConfig();

  it("classifies IP codes correctly", () => {
    // Интерактивные панели
    const p = classifyCode("262030.100.000021", cfg);
    expect(p).toEqual({ group: "ИП", kind: "Интерактивные панели" });

    // Интерактивные доски
    const b = classifyCode("262030.100.000043", cfg);
    expect(b).toEqual({ group: "ИП", kind: "Интерактивные доски" });

    // Мультимедийные системы
    const m1 = classifyCode("262030.100.000011", cfg);
    expect(m1).toEqual({ group: "ИП", kind: "Мультимедийные системы" });
    const m2 = classifyCode("262030.100.000013", cfg);
    expect(m2).toEqual({ group: "ИП", kind: "Мультимедийные системы" });
  });

  it("classifies LCD panels (279020.100.*) only when text contains interactive keywords", () => {
    // ЖК-код и «интерактивная» в extra_description_ru -> «Интерактивные панели»
    expect(
      classifyCode("279020.100.000001", cfg, "Панель жидкокристаллическая (интерактивная)")
    ).toEqual({ group: "ИП", kind: "Интерактивные панели" });

    // ЖК-код с «интерактивті» -> попадает в «Интерактивные панели»
    expect(
      classifyCode("279020.100.000005", cfg, "Интерактивті сенсорлық панель")
    ).toEqual({ group: "ИП", kind: "Интерактивные панели" });

    // Английское interactive -> попадает
    expect(
      classifyCode("279020.100.000012", cfg, "Interactive display 75 inch")
    ).toEqual({ group: "ИП", kind: "Интерактивные панели" });

    // ЖК-код без этого слова -> не попадает в рынок
    expect(
      classifyCode("279020.100.000001", cfg, "Лед экран, размер модуля – 320×160 мм")
    ).toBeNull();

    // ЖК-код с пустым текстом -> не попадает
    expect(classifyCode("279020.100.000001", cfg, "")).toBeNull();
    expect(classifyCode("279020.100.000001", cfg)).toBeNull();

    // 262030.100.000021 без текста -> как раньше
    expect(classifyCode("262030.100.000021", cfg)).toEqual({
      group: "ИП",
      kind: "Интерактивные панели"
    });

    // Префикс в конфиге остаётся
    expect(cfg.groups["ИП"].prefixes).toContain("279020.100.");
  });

  it("identifies codes that require text filtering based on config", () => {
    // 279020.100.* has textPatterns defined
    expect(requiresTextFilter("279020.100.000001", cfg)).toBe(true);
    expect(requiresTextFilter("279020.100.000045", cfg)).toBe(true);

    // Standard IP without textPatterns
    expect(requiresTextFilter("262030.100.000021", cfg)).toBe(false);
    expect(requiresTextFilter("262030.100.000043", cfg)).toBe(false);

    // KT codes without textPatterns
    expect(requiresTextFilter("262011.100.000001", cfg)).toBe(false);
    expect(requiresTextFilter("262013.000.000011", cfg)).toBe(false);
  });

  it("classifies KT codes correctly", () => {
    // Компьютеры и моноблоки
    expect(classifyCode("262013.000.000011", cfg)).toEqual({ group: "КТ", kind: "Компьютеры и моноблоки" });
    expect(classifyCode("262013.000.000012", cfg)).toEqual({ group: "КТ", kind: "Компьютеры и моноблоки" });

    // Системные блоки
    expect(classifyCode("262040.000.000267", cfg)).toEqual({ group: "КТ", kind: "Системные блоки" });
    expect(classifyCode("262040.000.000268", cfg)).toEqual({ group: "КТ", kind: "Системные блоки" });

    // Ноутбуки
    expect(classifyCode("262011.100.000001", cfg)).toEqual({ group: "КТ", kind: "Ноутбуки" });

    // МФУ
    expect(classifyCode("262018.900.000006", cfg)).toEqual({ group: "КТ", kind: "МФУ" });

    // Принтеры
    expect(classifyCode("262016.300.000015", cfg)).toEqual({ group: "КТ", kind: "Принтеры" });
    expect(classifyCode("262016.300.000019", cfg)).toEqual({ group: "КТ", kind: "Принтеры" });

    // Мониторы
    expect(classifyCode("262017.100.000001", cfg)).toEqual({ group: "КТ", kind: "Мониторы" });
  });

  it("rejects non-target hardware (servers, UPS, cartridges, kiosks)", () => {
    expect(classifyCode("262013.000.000018", cfg)).toBeNull(); // Сервер
    expect(classifyCode("262040.000.000231", cfg)).toBeNull(); // ИБП
    expect(classifyCode("262040.000.000281", cfg)).toBeNull(); // Картридж
    expect(classifyCode("262030.100.000002", cfg)).toBeNull(); // Киоск
  });

  it("formats trade methods and cleans entity names", () => {
    expect(getMethodName(2, cfg)).toBe("Открытый конкурс");
    expect(getMethodName(60, cfg)).toBe("Электронный магазин");
    expect(getMethodName(999, cfg)).toBe("Способ 999");

    expect(cleanEntityName('ТОО   ""Компания""')).toBe('ТОО "Компания"');
  });

  it("checks excluded statuses", () => {
    expect(isExcludedStatus(455, cfg)).toBe(true);
    expect(isExcludedStatus(350, cfg)).toBe(true);
    expect(isExcludedStatus(340, cfg)).toBe(true);
    expect(isExcludedStatus(190, cfg)).toBe(false);
  });
});

describe("filterContractUnits", () => {
  const cfg = loadMarketConfig();

  it("drops excluded statuses, prices < 10000, and non-target codes", () => {
    const rawContracts = [
      {
        id: 1,
        signDate: "2026-10-15T12:00:00",
        refContractStatusId: 190,
        faktTradeMethodsId: 60,
        supplierBiin: "061140003942", // Us
        customerBin: "123456789012",
        Supplier: { nameRu: 'ТОО ""F3.kz""' },
        Customer: { nameRu: "КГУ Школа" },
        ContractUnits: [
          {
            refEnstruCode: ["262030.100.000021"],
            quantity: 2,
            itemPrice: 500000,
            totalSum: 1000000
          },
          {
            // Dropped: unit price < 10,000 (error)
            refEnstruCode: ["262011.100.000001"],
            quantity: 100,
            itemPrice: 5,
            totalSum: 500
          }
        ]
      },
      {
        // Dropped: status 455
        id: 2,
        signDate: "2026-10-16T12:00:00",
        refContractStatusId: 455,
        faktTradeMethodsId: 2,
        supplierBiin: "999999999999",
        customerBin: "123456789012",
        Supplier: { nameRu: "ТОО Другой" },
        Customer: { nameRu: "КГУ Школа" },
        ContractUnits: [
          {
            refEnstruCode: ["262030.100.000021"],
            quantity: 1,
            itemPrice: 600000,
            totalSum: 600000
          }
        ]
      }
    ];

    const units = filterContractUnits(rawContracts, cfg);
    expect(units).toHaveLength(1);
    expect(units[0].id).toBe(1);
    expect(units[0].group).toBe("ИП");
    expect(units[0].kind).toBe("Интерактивные панели");
    expect(units[0].sum).toBe(1000000);
    expect(units[0].qty).toBe(2);
    expect(units[0].us).toBe(true);
    expect(units[0].supplierName).toBe('ТОО "F3.kz"');
  });

  it("filters LCD units by plan item text: keeps interactive, drops others", () => {
    const rawContracts = [
      {
        id: 101,
        signDate: "2026-10-10T10:00:00",
        refContractStatusId: 190,
        faktTradeMethodsId: 60,
        supplierBiin: "121212121212",
        customerBin: "343434343434",
        Supplier: { nameRu: "ТОО ТестПоставщик" },
        Customer: { nameRu: "Школа Тест" },
        ContractUnits: [
          {
            // Kept: LCD with interactive keyword in extraDescRu
            refEnstruCode: ["279020.100.000001"],
            quantity: 1,
            itemPrice: 750000,
            totalSum: 750000,
            Plans: {
              nameRu: "Панель жидкокристаллическая",
              extraDescRu: "Панель интерактивная 75 дюймов",
              extraDescKz: ""
            }
          },
          {
            // Dropped: LCD without interactive keyword
            refEnstruCode: ["279020.100.000002"],
            quantity: 2,
            itemPrice: 500000,
            totalSum: 1000000,
            Plans: {
              nameRu: "Панель жидкокристаллическая",
              extraDescRu: "LED экран модульный",
              extraDescKz: ""
            }
          },
          {
            // Dropped: LCD with empty text
            refEnstruCode: ["279020.100.000003"],
            quantity: 1,
            itemPrice: 600000,
            totalSum: 600000
          }
        ]
      }
    ];

    const units = filterContractUnits(rawContracts, cfg);
    expect(units).toHaveLength(1);
    expect(units[0].id).toBe(101);
    expect(units[0].code).toBe("279020.100.000001");
    expect(units[0].kind).toBe("Интерактивные панели");
    expect(units[0].sum).toBe(750000);
  });
});

import { mergeMarketUnits } from "../../src/kz/market/fetchMarket.js";

describe("mergeMarketUnits", () => {
  it("retains older units before cutoffDate and replaces units from cutoffDate onwards", () => {
    const olderUnit = {
      id: 10,
      month: "2026-08",
      date: "2026-08-15",
      group: "КТ" as const,
      code: "262011.100.000001",
      kind: "Ноутбуки",
      sum: 500000,
      qty: 1,
      price: 500000,
      supplier: "1",
      customer: "2",
      supplierName: "Поставщик",
      customerName: "Заказчик",
      method: "ОК",
      us: false
    };

    const staleUnit = {
      id: 20,
      month: "2026-10",
      date: "2026-10-05",
      group: "ИП" as const,
      code: "262030.100.000021",
      kind: "Интерактивные панели",
      sum: 800000,
      qty: 1,
      price: 800000,
      supplier: "1",
      customer: "2",
      supplierName: "Поставщик",
      customerName: "Заказчик",
      method: "ОК",
      us: false
    };

    const freshUnit = {
      ...staleUnit,
      sum: 850000,
      price: 850000
    };

    const merged = mergeMarketUnits([olderUnit, staleUnit], [freshUnit], "2026-09-01");
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(10);
    expect(merged[1].id).toBe(20);
    expect(merged[1].sum).toBe(850000);
  });
});
