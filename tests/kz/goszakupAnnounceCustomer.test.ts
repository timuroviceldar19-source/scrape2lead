import { describe, expect, it } from "vitest";
import { parseAnnounceCustomer, parseAnnounceRepresentative } from "../../src/kz/goszakupAnnounceCustomer.js";

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

const REPRESENTATIVE_HTML = `
<div class="panel-heading"><b>Информация об организаторе </b></div>
<table class="table table-bordered">
  <tr>
    <th class="col-md-4">ФИО представителя</th>
    <td>ИВАНОВ ИВАН ИВАНОВИЧ</td>
  </tr>
  <tr>
    <th>Должность</th>
    <td>Главный эксперт-закупщик</td>
  </tr>
  <tr>
    <th>E-Mail</th>
    <td> Zakup.Ivanov@Example.KZ </td>
  </tr>
  <!--                <tr>-->
  <!--                    <th>Телефон</th>-->
  <!--                    <td>+7 700 000 00 00</td>-->
  <!--                </tr>-->
</table>`;

describe("parseAnnounceRepresentative", () => {
  it("extracts name, position and a normalized e-mail from the organizer block", () => {
    expect(parseAnnounceRepresentative(REPRESENTATIVE_HTML)).toEqual({
      fullName: "ИВАНОВ ИВАН ИВАНОВИЧ",
      position: "Главный эксперт-закупщик",
      email: "zakup.ivanov@example.kz"
    });
  });

  it("returns null when the page has none of the three fields", () => {
    expect(parseAnnounceRepresentative(ANNOUNCE_HTML)).toBeNull();
  });

  it("keeps what is present when a field is missing", () => {
    const html = "<tr><th>ФИО представителя</th><td>ПЕТРОВ ПЕТР</td></tr><tr><th>Должность</th><td>Директор</td></tr>";

    expect(parseAnnounceRepresentative(html)).toEqual({ fullName: "ПЕТРОВ ПЕТР", position: "Директор", email: null });
  });

  it("ignores rows that are commented out in the HTML", () => {
    const html = "<!-- <tr><th>E-Mail</th><td>old@example.kz</td></tr> --><tr><th>Должность</th><td>Директор</td></tr>";

    expect(parseAnnounceRepresentative(html)).toEqual({ fullName: null, position: "Директор", email: null });
  });

  it("drops a value that is not an e-mail address", () => {
    const html = "<tr><th>ФИО представителя</th><td>СИДОРОВ С.</td></tr><tr><th>E-Mail</th><td>-</td></tr>";

    expect(parseAnnounceRepresentative(html)).toEqual({ fullName: "СИДОРОВ С.", position: null, email: null });
  });
});
