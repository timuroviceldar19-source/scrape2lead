import { describe, it, expect } from "vitest";
import { groupRegisterContracts, matchRegisterWithCrm } from "../../src/bitrix/salesPult/register/matchCrm.js";
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
        manager: "Мухаметжан", // Not in CRM
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
    expect(res.missing[0].manager).toBe("Мухаметжан");

    expect(res.extra).toHaveLength(1);
    expect(res.extra[0].id).toBe("102");
  });
});
