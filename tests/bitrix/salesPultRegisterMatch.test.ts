import { describe, it, expect } from "vitest";
import { groupRegisterContracts, matchRegisterWithCrm, extractEntityNumbers, hasConflictingEntityNumbers } from "../../src/bitrix/salesPult/register/matchCrm.js";
import type { RegisterRow, CrmWonDeal } from "../../src/bitrix/salesPult/register/types.js";

describe("groupRegisterContracts", () => {
  it("groups rows with the same date, customer, and manager into one contract", () => {
    const rows: RegisterRow[] = [
      {
        date: "2026-10-02",
        type: "ом",
        customer: "ГУ Аппарат",
        qty: 1,
        product: "моноблок",
        cost: 300000,
        extras: 0,
        sale: 400000,
        portal: 400000,
        val: 100000,
        bonusMop: 3000,
        bonusRop: 500,
        manager: "Бекзат",
        note: null,
        group: "КТ",
        kind: "Моноблоки",
        channel: "Электронный магазин"
      },
      {
        date: "2026-10-02",
        type: "ом",
        customer: "ГУ Аппарат",
        qty: 1,
        product: "мфу",
        cost: 90000,
        extras: 0,
        sale: 160000,
        portal: 160000,
        val: 70000,
        bonusMop: 2100,
        bonusRop: 350,
        manager: "Бекзат",
        note: null,
        group: "КТ",
        kind: "МФУ и принтеры",
        channel: "Электронный магазин"
      },
      {
        date: "2026-10-05",
        customer: "КГУ Школа",
        manager: "Эльмира",
        sale: 1000000,
        val: 200000,
        bonusMop: 6000,
        bonusRop: 1000,
        qty: 1,
        cost: 800000,
        extras: 0,
        portal: 1000000,
        type: "зцп",
        product: "панель",
        group: "ИП",
        kind: "Интерактивные панели",
        channel: "Запрос ценовых предложений",
        note: null
      }
    ];

    const contracts = groupRegisterContracts(rows);
    expect(contracts).toHaveLength(2);

    const bekzatContract = contracts.find((c) => c.manager === "Бекзат");
    expect(bekzatContract).toBeDefined();
    expect(bekzatContract!.sale).toBe(560000);
    expect(bekzatContract!.val).toBe(170000);
    expect(bekzatContract!.lines).toBe(2);
    expect(bekzatContract!.products).toEqual(["моноблок", "мфу"]);
  });
});

describe("matchRegisterWithCrm", () => {
  it("matches contracts with CRM deals by similarity, VAT range, and manager", () => {
    const contracts = groupRegisterContracts([
      {
        date: "2026-10-02",
        type: "ом",
        customer: "КГУ Отдел образования города Сатпаев",
        qty: 1,
        product: "моноблок",
        cost: 1000000,
        extras: 0,
        sale: 1600000, // with VAT 16% ~ 1,856,000
        portal: 1600000,
        val: 600000,
        bonusMop: 18000,
        bonusRop: 3000,
        manager: "Бахтияр",
        note: null,
        group: "КТ",
        kind: "Компьютеры",
        channel: "Электронный магазин"
      },
      {
        date: "2026-10-10",
        type: "зцп",
        customer: "НАО Университет медицины",
        qty: 1,
        product: "ноутбук",
        cost: 5000000,
        extras: 0,
        sale: 7000000,
        portal: 7000000,
        val: 2000000,
        bonusMop: 60000,
        bonusRop: 10000,
        manager: "Ерболат", // Not in CRM
        note: null,
        group: "КТ",
        kind: "Ноутбуки",
        channel: "Открытый конкурс"
      }
    ]);

    const deals: CrmWonDeal[] = [
      {
        id: "101",
        title: "Поставка моноблоков для Отдел образования Сатпаев",
        amount: 1856000,
        company: "ГУ Отдел образования Сатпаев",
        manager: "Бахтияр И."
      },
      {
        id: "102",
        title: "Другая сделка",
        amount: 500000,
        company: "ТОО Другое",
        manager: "Жанат"
      }
    ];

    const res = matchRegisterWithCrm(contracts, deals);
    expect(res.matched).toHaveLength(1);
    expect(res.matched[0].contract.customer).toBe("КГУ Отдел образования города Сатпаев");
    expect(res.matched[0].deal.id).toBe("101");

    expect(res.missing).toHaveLength(1);
    expect(res.missing[0].manager).toBe("Ерболат");

    expect(res.extra).toHaveLength(1);
    expect(res.extra[0].id).toBe("102");
  });

  it("does not match when both customer and deal have institution numbers that do not match (e.g. Ясли-сад №5 vs Ясли-сад №14)", () => {
    const contracts = groupRegisterContracts([
      {
        date: "2026-10-07",
        type: "ГЗ",
        customer: "Коммунальное государственное казенное предприятие Ясли-сад №5 Астана",
        qty: 1,
        product: "Бумага",
        cost: 400000,
        extras: 0,
        sale: 600000,
        portal: 600000,
        val: 200000,
        bonusMop: 6000,
        bonusRop: 1000,
        manager: "Алихан",
        note: null,
        group: "ИП" as const,
        kind: "Конкурсные закупки",
        channel: "Закупки методом конкурса"
      }
    ]);

    const deals = [
      {
        id: "77777",
        title: "Поставка товаров для Ясли-сад №14 Астана",
        company: "КГКП Ясли-сад №14 Астана",
        amount: 600000,
        manager: "Алихан"
      }
    ];

    const res = matchRegisterWithCrm(contracts, deals);
    expect(res.matched).toHaveLength(0);
    expect(res.missing).toHaveLength(1);
    expect(res.extra).toHaveLength(1);
  });
});


describe("managerAliases matching", () => {
  it("matches a register name to a CRM name that differs in one letter when an alias is configured", () => {
    const contracts = groupRegisterContracts([
      {
        date: "2026-10-12",
        type: "зцп",
        customer: "НАО Тестовый университет",
        qty: 10,
        product: "моноблок",
        cost: 10000000,
        extras: 0,
        sale: 12000000,
        portal: 12000000,
        val: 2000000,
        bonusMop: 60000,
        bonusRop: 10000,
        manager: "Ерболат",
        note: null,
        group: "КТ",
        kind: "Моноблоки",
        channel: "Запрос ценовых предложений"
      }
    ]);

    const deals: CrmWonDeal[] = [
      {
        id: "9001",
        title: "НАО Тестовый университет — Моноблоки",
        amount: 13440000,
        company: "НАО Тестовый университет",
        manager: "Ербөлат Тестов"
      }
    ];

    const withoutAlias = matchRegisterWithCrm(contracts, deals);
    expect(withoutAlias.matched).toHaveLength(0);
    expect(withoutAlias.missing).toHaveLength(1);

    const withAlias = matchRegisterWithCrm(contracts, deals, {
      managerAliases: { Ерболат: "Ербөлат" }
    });
    expect(withAlias.matched).toHaveLength(1);
    expect(withAlias.missing).toHaveLength(0);
  });
});

describe("extractEntityNumbers and entity conflict checks", () => {
  it("extracts institution number from named entity without № symbol (e.g. школа 5)", () => {
    const nums = extractEntityNumbers("КГУ Средняя общеобразовательная школа 5 города Павлодара");
    expect(Array.from(nums)).toContain("5");
  });

  it("extracts institution number with №, N, or # symbol", () => {
    expect(Array.from(extractEntityNumbers("Ясли-сад №14"))).toContain("14");
    expect(Array.from(extractEntityNumbers("Ясли-сад N 14"))).toContain("14");
    expect(Array.from(extractEntityNumbers("Ясли-сад N14"))).toContain("14");
    expect(Array.from(extractEntityNumbers("Школа #5"))).toContain("5");
  });

  it("does not treat latin lowercase n in words or 'n 2026' as entity number", () => {
    expect(Array.from(extractEntityNumbers("договор n 2026 поставка"))).not.toContain("2026");
    expect(Array.from(extractEntityNumbers("plan 2026 test"))).not.toContain("2026");
    expect(Array.from(extractEntityNumbers("main 123"))).not.toContain("123");
  });

  it("detects entity number conflicts correctly (школа 5 vs школа 14 without №)", () => {
    expect(
      hasConflictingEntityNumbers(
        "КГУ Средняя школа 5 города Павлодара",
        "Поставка панелей для Школа 14"
      )
    ).toBe(true);

    expect(
      hasConflictingEntityNumbers(
        "КГУ Средняя школа 5 города Павлодара",
        "Поставка панелей для Школа 5"
      )
    ).toBe(false);
  });
});
