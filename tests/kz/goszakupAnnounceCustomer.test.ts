import { describe, expect, it } from "vitest";
import { parseAnnounceCustomer } from "../../src/kz/goszakupAnnounceCustomer.js";

const ANNOUNCE_HTML = `
<table>
  <tr><th>Организатор</th><td>020840001842 Государственное коммунальное предприятие "Школа-гимназия № 17"</td></tr>
  <tr><th>Юр. адрес организатора</th><td>КАЗАХСТАН, 711510000, г.Астана, ул. Кабанбай батыра, д. 9</td></tr>
  <tr><th>Кол-во лотов в объявлении</th><td>1</td></tr>
</table>`;

describe("parseAnnounceCustomer", () => {
  it("extracts BIN, name and legal address from the organizer row", () => {
    const result = parseAnnounceCustomer(ANNOUNCE_HTML);
    expect(result).toEqual({
      bin: "020840001842",
      name: 'Государственное коммунальное предприятие "Школа-гимназия № 17"',
      legalAddress: "КАЗАХСТАН, 711510000, г.Астана, ул. Кабанбай батыра, д. 9"
    });
  });

  it("returns null when there is no organizer row", () => {
    expect(parseAnnounceCustomer("<table><tr><th>Сумма</th><td>100</td></tr></table>")).toBeNull();
  });

  it("returns null when the organizer row has no 12-digit BIN", () => {
    expect(parseAnnounceCustomer("<tr><th>Организатор</th><td>Наименование без БИН</td></tr>")).toBeNull();
  });
});
