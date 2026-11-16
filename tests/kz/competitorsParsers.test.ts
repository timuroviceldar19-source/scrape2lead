import { describe, expect, it } from "vitest";
import { loadCompetitorsConfig } from "../../src/kz/competitors/config.js";
import {
  classifyCompetitorLot,
  dedupeLatestLotVersions,
  extractFailureReason,
  extractSoftwareMentions,
  normalizeCompetitorLotAndBids,
  parseAnnounceGeneral,
  parseProtocolsTab,
  parseSearchLotsPage,
  parseSubpriceoffer,
  parseItogiHtml
} from "../../src/kz/competitors/parsers.js";

// Все названия, БИН и суммы в этом файле выдуманные.

describe("competitors HTML parsers", () => {
  it("parses search lots page rows and total count, including omitted closing <td> tags", () => {
    const html = `
      <div>Показано с 1 по 2 из 42 записей</div>
      <table id="search-result">
        <thead><tr><th>№ лота</th><th>Объявление</th><th>Лот</th><th>Кол-во</th><th>Сумма</th><th>Способ</th><th>Статус</th></tr></thead>
        <tbody>
          <tr>
            <td><strong>90001001-ОК1</strong>
            <td>
              <a href="/ru/announce/index/19001001"><strong>19001001-1 Панель интерактивная 75</strong></a><br>
              Заказчик: КГУ "Тестовая школа №1"
            </td>
            <td><a href="https://procurement.gov.kz/ru/subpriceoffer/index/19001001/50001">Панель интерактивная</a> История</td>
            <td>2</td>
            <td>2 400 000.00</td>
            <td>Открытый конкурс</td>
            <td>Закупка состоялась</td>
          </tr>
          <tr>
            <td>Ничего не найдено</td><td></td><td></td><td></td><td></td><td></td><td></td>
          </tr>
        </tbody>
      </table>
    `;

    const res = parseSearchLotsPage(html);
    expect(res.total).toBe(42);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      lotNumber: "90001001-ОК1",
      annoId: "19001001",
      annoNumber: "19001001-1",
      annoName: "Панель интерактивная 75",
      annoUrl: "https://procurement.gov.kz/ru/announce/index/19001001",
      lotUrl: "https://procurement.gov.kz/ru/subpriceoffer/index/19001001/50001",
      customerNameSearch: 'КГУ "Тестовая школа №1"',
      qtySearch: 2,
      plannedSumSearch: 2400000,
      statusSearch: "Закупка состоялась"
    });
  });

  it("parses subpriceoffer including combined -ОЛ- sub-items and general fallback", () => {
    const subHtml = `
      <table>
        <tr><th>Лот №</th><td>90001002-ОЛ-ОК1 История</td></tr>
        <tr><th>Статус лота</th><td>Закупка состоялась</td></tr>
        <tr><th>Дата начала приема заявок</th><td>2026-04-10 09:00:00</td></tr>
        <tr><th>Дата окончания приема заявок</th><td>2026-04-18 18:00:00</td></tr>
        <tr><th>БИН заказчика</th><td>111111111111</td></tr>
        <tr><th>Наименование заказчика</th><td>ГККП "Тестовый колледж"</td></tr>
        <tr><th>Код ТРУ</th><td>262030.100.000021</td></tr>
        <tr><th>Наименование ТРУ</th><td>Панель интерактивная</td></tr>
        <tr><th>Краткая характеристика</th><td>Диагональ 75 дюймов</td></tr>
        <tr><th>Дополнительная характеристика</th><td>Сенсорная панель</td></tr>
        <tr><th>Цена за единицу</th><td>1 500 000,00</td></tr>
        <tr><th>Единица измерения</th><td>Штука</td></tr>
        <tr><th>Количество</th><td>2</td></tr>
        <tr><th>Запланированная сумма</th><td>3 000 000,00</td></tr>
      </table>
      <table>
        <tr><th>№</th><th>Номер пункта плана</th><th>Заказчик</th><th>Наименование</th><th>Доп. характ.</th><th>Цена</th><th>Кол-во</th><th>Ед.</th><th>Сумма</th></tr>
        <tr><td>1</td><td>101</td><td>Колледж</td><td>Панель 75"</td><td>75 дюймов</td><td>1 200 000</td><td>2</td><td>Шт</td><td>2 400 000</td></tr>
        <tr><td>2</td><td>102</td><td>Колледж</td><td>Стойка</td><td>Мобильная</td><td>300 000</td><td>2</td><td>Шт</td><td>600 000</td></tr>
      </table>
    `;
    const parsed = parseSubpriceoffer(subHtml);
    expect(parsed.lotNumberPage).toBe("90001002-ОЛ-ОК1");
    expect(parsed.startDate).toBe("2026-04-10 09:00:00");
    expect(parsed.customerBin).toBe("111111111111");
    expect(parsed.unitPrice).toBe(1500000);
    expect(parsed.plannedSum).toBe(3000000);
    expect(parsed.subItems).toHaveLength(2);
    expect(parsed.subItems[0].planPoint).toBe("101");

    const genHtml = `
      <label>Номер объявления</label><input value="19001002-1">
      <label>Срок начала приема заявок</label><input value="2026-04-10 09:00:00">
      <table><tr><th>Организатор</th><td>222222222222 Управление закупок</td></tr></table>
    `;
    const gen = parseAnnounceGeneral(genHtml);
    expect(gen.annoNumberPage).toBe("19001002-1");
    expect(gen.startDate).toBe("2026-04-10 09:00:00");
    expect(gen.organizerBin).toBe("222222222222");
  });

  it("parses protocols tab links and classifies protocol kinds", () => {
    const html = `
      <div class="panel">
        <div class="panel-heading">Протокол итогов</div>
        <table>
          <tr><th>Протокол итогов</th><th>Статус</th></tr>
          <tr>
            <td><a href="https://v3bl.goszakup.gov.kz/files/download_file/111/222/">Просмотреть протокол</a></td>
            <td>Действительный</td>
          </tr>
          <tr>
            <td><a href="https://v3bl.goszakup.gov.kz/files/download_file/111/221/">Просмотреть протокол</a></td>
            <td>Отменен</td>
          </tr>
        </table>
      </div>
      <div>
        <table>
          <tr><th>Обсуждение</th></tr>
          <tr><td><a href="https://v3bl.goszakup.gov.kz/files/download_file/111/220/">prot_pod_111.pdf</a></td><td>Действительный</td></tr>
        </table>
      </div>
    `;
    const list = parseProtocolsTab(html);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ kind: "itogi", status: "Действительный" });
    expect(list[1]).toMatchObject({ kind: "itogi", status: "Отменен" });
    expect(list[2]).toMatchObject({ kind: "discussion", status: "Действительный" });
  });

  it("parses Russian section of itogi HTML, distinguishes unit vs total price, combined -ОЛ- price, OTP/KTP and rejections", () => {
    const html = `<!doctype html><html><body>
      <p>Қорытынды хаттама (казахская часть игнорируется)</p>
      <table><tr><th>Лот №</th><th>Атауы</th></tr><tr><td>90001001-ОК1</td><td>Интерактивті панель</td></tr></table>
      <table><tr><th>БИН</th><th>Бағасы</th></tr><tr><td>333333333333</td><td>1000</td></tr></table>

      <p>ПРОТОКОЛ ОБ ИТОГАХ</p>
      <table>
        <tr><th>№</th><th>№ лота</th><th>Наименование лота</th><th>Кол-во</th><th>Цена за ед.</th><th>Выделенная сумма</th></tr>
        <tr><td>1</td><td>90001001-ОК1</td><td>Панель интерактивная</td><td>2</td><td>1 200 000</td><td>2 400 000</td></tr>
        <tr><td>2</td><td>90001002-ОЛ-ОК1</td><td>Комплект панелей (ОЛ)</td><td>1</td><td>3 000 000</td><td>3 000 000</td></tr>
      </table>

      <p>№ лота 90001001-ОК1 Наименование лота Панель интерактивная</p>
      <table>
        <tr><th>№</th><th>Наименование</th><th>БИН</th><th>Дата и время представления</th></tr>
        <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td><td>2026-04-12 10:00:00</td></tr>
        <tr><td>2</td><td>ТОО «Бета Тест»</td><td>444444444444</td><td>2026-04-12 11:00:00</td></tr>
        <tr><td>3</td><td>ТОО «Гамма Отклонена»</td><td>555555555555</td><td>2026-04-12 12:00:00</td></tr>
      </table>
      <table>
        <tr><th>№ п/п</th><th>Наименование потенциального поставщика</th><th>Комиссия</th><th>Решение</th><th>Причина</th><th>Подробное описание</th></tr>
        <tr><td>1</td><td colspan="5">ТОО «Гамма Отклонена» (555555555555)</td></tr>
        <tr><td>1</td><td>Иванов И.</td><td>Член</td><td>Отклонена</td><td>Несоответствие требованиям конкурсной документации</td><td>Не представлено авторизационное письмо на ПО файловой системы</td></tr>
      </table>
      <table>
        <tr><th>№</th><th>Наименование</th><th>БИН</th></tr>
        <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td></tr>
        <tr><td>2</td><td>ТОО «Бета Тест»</td><td>444444444444</td></tr>
      </table>
      <table>
        <tr><th colspan="14">Условные скидки</th></tr>
        <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td><td>1.0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>2.0</td><td>3.0</td></tr>
        <tr><td>2</td><td>ТОО «Бета Тест»</td><td>444444444444</td><td>1.0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>1.0</td></tr>
      </table>
      <table>
        <tr><th>Место</th><th>Наименование</th><th>БИН</th><th>Выделенная сумма</th><th>Цена поставщика</th><th>Сумма ст.13</th><th>Условная скидка, %</th><th>Условная цена</th><th>Фин. уст.</th><th>Договоры сумма</th><th>Договоры шт</th><th>Дата и время подачи заявки</th></tr>
        <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td><td>2 400 000</td><td>1 100 000</td><td>0</td><td>3.0</td><td>2 134 000</td><td>1</td><td>100</td><td>1</td><td>2026-04-12 10:00:00</td></tr>
        <tr><td>2</td><td>ТОО «Бета Тест»</td><td>444444444444</td><td>2 400 000</td><td>2 150 000</td><td>0</td><td>1.0</td><td>2 128 500</td><td>1</td><td>50</td><td>1</td><td>2026-04-12 11:00:00</td></tr>
      </table>
      <table>
        <tr><th>№</th><th>Наименование потенциального поставщика</th><th>БИН</th><th>Сведения бенефициарного владельца</th></tr>
        <tr><td>1</td><td>ТОО «Бета Тест»</td><td>444444444444</td><td>Петров П.П.</td></tr>
      </table>
      <table>
        <tr><th>№</th><th>Наименование поставщика, занявшего второе место</th><th>БИН</th></tr>
        <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td></tr>
      </table>
      <p>Признать государственную закупку по лоту № 90001001-ОК1 состоявшейся.</p>

      <p>№ лота 90001002-ОЛ-ОК1 Наименование лота Комплект панелей</p>
      <table>
        <tr><th>Место</th><th>Наименование</th><th>БИН</th><th>Выделенная сумма</th><th>Цена поставщика</th><th>Сумма ст.13</th><th>Условная скидка, %</th><th>Условная цена</th></tr>
        <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td><td>3 000 000</td><td>1 400 000</td><td>0</td><td>5.0</td><td>2 850 000</td></tr>
      </table>
      <table>
        <tr><th>№</th><th>Наименование потенциального поставщика</th><th>БИН</th><th>Сведения бенефициарного владельца</th></tr>
        <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td><td>Иванов И.И.</td></tr>
      </table>
    </body></html>`;

    const parsed = parseItogiHtml(html, new Set(["90001001-ОК1", "90001002-ОЛ-ОК1"]));
    expect(Object.keys(parsed).sort()).toEqual(["90001001-ОК1", "90001002-ОЛ-ОК1"]);

    const lot1 = parsed["90001001-ОК1"];
    expect(lot1.winner?.bin).toBe("444444444444");
    expect(lot1.second?.bin).toBe("333333333333");
    expect(lot1.condDisc["333333333333"]?.otpKtpPct).toBe(2);
    expect(lot1.votingRej["555555555555"]?.short).toContain("Несоответствие требованиям конкурсной документации");

    const cfg = loadCompetitorsConfig();
    const norm1 = normalizeCompetitorLotAndBids({
      annoId: "19001001",
      annoNumber: "19001001-1",
      annoName: "Панель",
      lotNumber: "90001001-ОК1",
      lotName: "Панель интерактивная",
      enstruCode: "262030.100.000021",
      group: "ИП",
      kind: "Интерактивная панель",
      diagonal: '75"',
      cpu: "",
      isCombinedLot: false,
      isKit: false,
      status: "Закупка состоялась",
      startDate: "2026-04-10",
      endDate: "2026-04-18",
      customerBin: "111111111111",
      customerName: 'КГУ "Тестовая школа №1"',
      qty: 2,
      plannedUnitPriceNoVat: 1200000,
      plannedSumNoVat: 2400000,
      hasTechspec: true,
      techspecUrl: "https://v3bl.goszakup.gov.kz/files/download_file/1/2/",
      protocolUrl: "https://v3bl.goszakup.gov.kz/files/download_file/111/222/",
      parsedItogi: lot1,
      cfg
    });

    const alpha = norm1.bids.find((b) => b.bidderBin === "333333333333")!;
    const beta = norm1.bids.find((b) => b.bidderBin === "444444444444")!;
    const gamma = norm1.bids.find((b) => b.bidderBin === "555555555555")!;
    // Alpha submitted unit price 1_100_000 (2 * 1_100_000 * 0.97 = 2_134_000)
    expect(alpha.bidUnitPriceNoVat).toBe(1100000);
    expect(alpha.bidTotalPriceNoVat).toBe(2200000);
    expect(alpha.otpKtpPct).toBe(2);
    expect(alpha.isSecondPlace).toBe(true);
    // Beta submitted total price 2_150_000 (2_150_000 * 0.99 = 2_128_500)
    expect(beta.bidTotalPriceNoVat).toBe(2150000);
    expect(beta.bidUnitPriceNoVat).toBe(1075000);
    expect(beta.isWinner).toBe(true);
    // Gamma rejected
    expect(gamma.admittedStatus).toBe("Отклонен");

    // Combined lot (-ОЛ-): raw supplier price 1_400_000 is single sub-item, total must come from condPrice 2_850_000 / 0.95 = 3_000_000
    const norm2 = normalizeCompetitorLotAndBids({
      annoId: "19001002",
      annoNumber: "19001002-1",
      annoName: "Комплект",
      lotNumber: "90001002-ОЛ-ОК1",
      lotName: "Комплект панелей",
      enstruCode: "262030.100.000021",
      group: "ИП",
      kind: "Интерактивная панель",
      diagonal: '75"',
      cpu: "",
      isCombinedLot: true,
      isKit: false,
      status: "Закупка состоялась",
      startDate: "2026-04-10",
      endDate: "2026-04-18",
      customerBin: "111111111111",
      customerName: 'ГККП "Тестовый колледж"',
      qty: 1,
      plannedUnitPriceNoVat: 3000000,
      plannedSumNoVat: 3000000,
      hasTechspec: true,
      techspecUrl: "",
      protocolUrl: "",
      parsedItogi: parsed["90001002-ОЛ-ОК1"],
      cfg
    });
    expect(norm2.bids[0].bidTotalPriceNoVat).toBe(3000000);
    expect(norm2.bids[0].bidUnitPriceNoVat).toBeNull();
  });

  it("applies domain filters: 279020 interactive keyword, minUnitPrice, hiddenKinds, software guardrails, and latest-version deduplication", () => {
    const cfg = loadCompetitorsConfig();

    const nonInteractive279 = classifyCompetitorLot(
      { enstruCodes: ["279020.100.000001"], lotNumber: "1-ОК1", titleText: "Панель жидкокристаллическая для автобуса", unitPrice: 200000, plannedSum: 200000, qty: 1 },
      "LCD экран для маршрутного транспорта",
      cfg
    );
    expect(nonInteractive279.include).toBe(false);

    const interactive279 = classifyCompetitorLot(
      { enstruCodes: ["279020.100.000001"], lotNumber: "2-ОК1", titleText: "Панель жидкокристаллическая", unitPrice: 900000, plannedSum: 900000, qty: 1 },
      "Интерактивная сенсорная панель 75 дюймов для школы",
      cfg
    );
    expect(interactive279).toMatchObject({ include: true, group: "ИП", kind: "Интерактивная панель", diagonal: '75"' });

    const multimediaHidden = classifyCompetitorLot(
      { enstruCodes: ["262030.100.000011"], lotNumber: "3-ОК1", titleText: "Мультимедийная система", unitPrice: 500000, plannedSum: 500000, qty: 1 },
      "",
      cfg
    );
    expect(multimediaHidden.include).toBe(false);

    const cheapKit = classifyCompetitorLot(
      { enstruCodes: ["329959.900.000019"], lotNumber: "4-ОК1", titleText: "Комплект учебного оборудования", unitPrice: 5000, plannedSum: 5000, qty: 1 },
      "",
      cfg
    );
    expect(cheapKit).toMatchObject({ include: true, group: "ИП", kind: "Учебный комплект", isKit: true });

    // Software guardrails: macOS compatibility ignored; rejection missing software is not 'предложил участник'
    const macCompat = extractSoftwareMentions("Совместимость драйвера с ОС Windows, macOS, Linux", "требовал заказчик", false);
    expect(macCompat.map((x) => x.software)).not.toContain("macOS");

    const rejSw = extractSoftwareMentions("Не представлена лицензия на Windows 11 и антивирус Kaspersky", "не предоставил (причина отклонения)", true);
    expect(rejSw.every((x) => x.source === "не предоставил (причина отклонения)")).toBe(true);

    // Deduplication: prefers non-'Изменена документация', then startDate, then annoId
    const deduped = dedupeLatestLotVersions([
      { annoId: "100", lotNumber: "L-1", status: "Изменена документация", startDate: "2026-05-10" },
      { annoId: "101", lotNumber: "L-1", status: "Закупка не состоялась", startDate: "2026-05-01" },
      { annoId: "102", lotNumber: "L-1", status: "Закупка состоялась", startDate: "2026-06-01" }
    ]);
    expect(deduped.get("102:L-1")).toBe(true);
    expect(deduped.get("101:L-1")).toBe(false);
    expect(deduped.get("100:L-1")).toBe(false);

    expect(extractFailureReason("Признать закупку несостоявшейся: допущен только один потенциальный поставщик", 2, 1)).toContain("Допущен только один");
  });
});
