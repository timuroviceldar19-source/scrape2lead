import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAnnounceAwards,
  parseAnnounceRepresentative,
  parseCustomerLots
} from "../../src/kz/goszakupDossierParser.js";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "gz-dossier");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

describe("parseCustomerLots", () => {
  it("reads server-rendered lot rows that leave <td> unclosed", () => {
    const lots = parseCustomerLots(fixture("lots-search.html"));

    expect(lots).toHaveLength(2);
    expect(lots[0]).toEqual({
      lotNumber: "81335611-ЗЦП2",
      lotName: "Компьютер",
      lotId: "41146356",
      announceId: "16744298",
      announceNumber: "16744298-1",
      announceName: "16744298-1 Приобретение компьютеров в комплекте (моноблок)",
      customer: 'ГКП на праве хозяйственного ведения "Алматы тазалық" акимата города Алматы',
      quantity: 40,
      amount: 22_332_800,
      method: "Запрос ценовых предложений",
      status: "Закупка состоялась"
    });
  });

  it("keeps failed purchases so repeat attempts stay visible", () => {
    const lots = parseCustomerLots(fixture("lots-search.html"));
    expect(lots[1].status).toBe("Закупка не состоялась");
    expect(lots[1].announceId).toBe("16714116");
  });

  it("returns an empty list when the result table is absent", () => {
    expect(parseCustomerLots("<html><body>Ничего не найдено</body></html>")).toEqual([]);
  });
});

describe("parseAnnounceRepresentative", () => {
  it("extracts the procurement officer behind the announcement", () => {
    expect(parseAnnounceRepresentative(fixture("announce-general.html"))).toEqual({
      fullName: "ТУРГАМБЕКОВА НАЗИРА ОМАРКЫЗЫ",
      position: "Специалист отдела государственных закупок и обеспечения",
      email: "tazalyk.almaty@mail.ru"
    });
  });

  it("returns null when the announcement carries no representative", () => {
    expect(parseAnnounceRepresentative("<table><tr><th>Сумма закупки</th><td>100</td></tr></table>")).toBeNull();
  });
});

describe("parseAnnounceAwards", () => {
  it("reads winner, planned amount and contracted amount per lot", () => {
    const awards = parseAnnounceAwards(fixture("announce-contracts.html"));

    expect(awards).toHaveLength(2);
    expect(awards[0]).toEqual({
      lotId: "41146356",
      lotNumber: "81335611-ЗЦП2",
      lotName: "Компьютер",
      contractNumber: "031040002509/260231/00",
      contractKind: "Основной договор",
      contractStatus: "Изменен",
      plannedAmount: 22_332_800,
      contractAmount: 14_284_920,
      supplierName: 'ТОО "Steppe System Security"',
      supplierBin: "190140006079",
      winnerStatus: "Первый победитель"
    });
    expect(awards[1].contractKind).toBe("Доп.соглашение");
  });

  it("returns an empty list for an announcement without contracts yet", () => {
    expect(parseAnnounceAwards("<div class='tab-content'></div>")).toEqual([]);
  });
});
