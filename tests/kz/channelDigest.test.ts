import { describe, expect, it } from "vitest";
import { formatChannelDigest, formatCompanyShort } from "../../src/kz/channelDigest.js";
import type { OutreachWinner } from "../../src/kz/outreachDigest.js";

function sampleWinner(overrides: Partial<OutreachWinner> = {}): OutreachWinner {
  return {
    bin: "140940001692",
    company_name: 'ТОО "Lion\'s group"',
    director: "Иванов И.И.",
    phone: "+77771234567",
    email: "test@mail.kz",
    gis_phone: "",
    contract_number: "CT-1",
    contract_name: "Разработка ПСД по строительству уличного освещения города Алатау",
    customer_name: "ГУ Акимата",
    amount: 4_310_344.83,
    amount_raw: "4310344.83",
    contract_date: "2026-06-01",
    status: "Действует",
    url: "https://www.goszakup.gov.kz/ru/announce/index/16806628?tab=winners",
    ...overrides
  };
}

describe("formatCompanyShort", () => {
  it("убирает ТОО и длинную форму", () => {
    expect(formatCompanyShort('ТОО "Lion\'s group"')).toBe("Lion's group");
    expect(formatCompanyShort("ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «Альфа»")).toBe("Альфа");
  });
});

describe("formatChannelDigest", () => {
  it("возвращает null для пустого списка", () => {
    expect(formatChannelDigest([])).toBeNull();
  });

  it("не включает телефоны и email в публичный пост", () => {
    const text = formatChannelDigest([sampleWinner()], { nicheLabel: "ПСД / освещение" });
    expect(text).not.toBeNull();
    expect(text).not.toContain("+7777");
    expect(text).not.toContain("test@mail.kz");
    expect(text).toContain("ПСД / освещение");
    expect(text).toContain("Lion");
    expect(text).toContain("4,3 млн ₸");
    expect(text).toContain("goszakup");
    expect(text).toContain("instagram.com/ai.leads.kz");
    expect(text).toContain("threads.com/@ai.leads.kz");
    expect(text).toContain("ГУ Акимата");
    expect(text).toContain("────────────────");
  });

  it("ограничивает число строк maxRows", () => {
    const winners = Array.from({ length: 15 }, (_, i) =>
      sampleWinner({ company_name: `Компания ${i + 1}`, bin: String(100000000000 + i) })
    );
    const text = formatChannelDigest(winners, { maxRows: 5 })!;
    expect(text).toContain("Показано 5 из 15");
    expect(text).toContain("Компания 1");
    expect(text).not.toContain("Компания 6");
  });
});
