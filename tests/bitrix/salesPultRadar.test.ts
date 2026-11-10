import { describe, expect, it } from "vitest";
import {
  parseRadarLotDeal,
  parseRadarPlanDeal,
  buildRadarView,
  type RadarRawDeal,
  type RadarCard
} from "../../src/bitrix/salesPult/radar/aggregate.js";

const AS_OF_DATE = "2026-11-10";
const AS_OF_TIME = "2026-11-10T12:00:00+05:00";

describe("Radar data parsing", () => {
  it("parses lot deal from funnel 43 with bid window and comments", () => {
    const raw: RadarRawDeal = {
      ID: "4301",
      TITLE: "GZ 83132229-ЗЦП1 — Интерактивная панель 75",
      STAGE_ID: "C43:NEW",
      STAGE_SEMANTIC_ID: "P",
      CLOSED: "N",
      ASSIGNED_BY_ID: "2301",
      COMPANY_ID: "501",
      DATE_CREATE: "2026-11-09T10:00:00+05:00",
      BEGINDATE: "2026-11-09",
      CLOSEDATE: "2026-11-11",
      OPPORTUNITY: "6500000",
      ORIGIN_ID: "gz-lot:83132229-ЗЦП1",
      COMMENTS: [
        "GZ лот: 83132229-ЗЦП1 (Интерактивная панель 75)",
        "Приём заявок: 2026-11-09 10:00 — 2026-11-11 18:00 (время Алматы)",
        "Объявление: 12345678 — Закупка панелей",
        "Заказчик: КГУ «Школа-лицей №1 г. Астаны» (БИН 010203040506)",
        "Способ закупки: Запрос ценовых предложений",
        "Статус: Опубликован (прием заявок)",
        "Количество: 10",
        "Сумма: 6500000 KZT",
        "Лот: https://goszakup.gov.kz/ru/registry/lots/83132229",
        "Объявление: https://goszakup.gov.kz/ru/announce/index/12345678"
      ].join("\n"),
      UF_CRM_6627AEBD4503E: "Запрос ценовых предложений",
      UF_CRM_6627AEBD54B8D: "Интерактивная панель 75",
      UF_CRM_6627AEBD67FFF: "10",
      UF_CRM_6627AEBD72587: "КГУ «Школа-лицей №1 г. Астаны»",
      UF_CRM_6627AEBD85B4D: "Опубликован (прием заявок)"
    };

    const card = parseRadarLotDeal(raw, {
      asOfDate: AS_OF_DATE,
      asOfTime: AS_OF_TIME,
      portal: "https://f3.bitrix24.kz",
      managerNames: new Map([["2301", "Алия Менеджер"]])
    });

    expect(card).not.toBeNull();
    expect(card?.id).toBe("4301");
    expect(card?.dealUrl).toBe("https://f3.bitrix24.kz/crm/deal/details/4301/");
    expect(card?.sourceType).toBe("lot");
    expect(card?.group).toBe("ИП");
    expect(card?.kind).toBe("Интерактивные панели");
    expect(card?.lotNumber).toBe("83132229-ЗЦП1");
    expect(card?.planNumber).toBe("83132229");
    expect(card?.sum).toBe(6500000);
    expect(card?.qty).toBe(10);
    expect(card?.startAt).toBe("2026-11-09 10:00");
    expect(card?.endAt).toBe("2026-11-11 18:00");
    expect(card?.lotUrl).toBe("https://goszakup.gov.kz/ru/registry/lots/83132229");
    expect(card?.announceUrl).toBe("https://goszakup.gov.kz/ru/announce/index/12345678");
    expect(card?.managerName).toBe("Алия Менеджер");
    expect(card?.column).toBe("submitToday");
  });

  it("classifies computer hardware as 'КТ' and detects discussion column", () => {
    const raw: RadarRawDeal = {
      ID: "4302",
      TITLE: "GZ 99991111-ОК1 — Ноутбук Core i5",
      STAGE_ID: "C43:NEW",
      STAGE_SEMANTIC_ID: "P",
      CLOSED: "N",
      ASSIGNED_BY_ID: "2302",
      COMPANY_ID: "502",
      DATE_CREATE: "2026-11-10T08:00:00+05:00",
      BEGINDATE: "2026-11-15",
      CLOSEDATE: "2026-11-25",
      OPPORTUNITY: "15000000",
      ORIGIN_ID: "gz-lot:99991111-ОК1",
      COMMENTS: "GZ лот: 99991111-ОК1 (Ноутбук)\nСтатус: Опубликован",
      UF_CRM_6627AEBD4503E: "Открытый конкурс",
      UF_CRM_6627AEBD54B8D: "Ноутбук Core i5",
      UF_CRM_6627AEBD67FFF: "50",
      UF_CRM_6627AEBD72587: "ГККП «Больница»",
      UF_CRM_6627AEBD85B4D: "Опубликован"
    };

    const card = parseRadarLotDeal(raw, {
      asOfDate: AS_OF_DATE,
      asOfTime: AS_OF_TIME,
      portal: "https://f3.bitrix24.kz"
    });

    expect(card).not.toBeNull();
    expect(card?.group).toBe("КТ");
    expect(card?.kind).toBe("Ноутбуки");
    expect(card?.column).toBe("discussion");
    expect(card?.sum).toBe(15000000);
  });

  it("parses failed lot as 'secondChance'", () => {
    const raw: RadarRawDeal = {
      ID: "4303",
      TITLE: "GZ 77772222-1 — Интерактивная доска",
      STAGE_ID: "C43:NEW",
      STAGE_SEMANTIC_ID: "P",
      CLOSED: "N",
      ASSIGNED_BY_ID: "2301",
      COMPANY_ID: "503",
      DATE_CREATE: "2026-11-01T10:00:00+05:00",
      BEGINDATE: "2026-11-01",
      CLOSEDATE: "2026-11-08",
      OPPORTUNITY: "3000000",
      ORIGIN_ID: "gz-lot:77772222-1",
      COMMENTS: "GZ лот: 77772222-1\nСтатус: Закупка не состоялась",
      UF_CRM_6627AEBD4503E: "ЗЦП",
      UF_CRM_6627AEBD54B8D: "Интерактивная доска",
      UF_CRM_6627AEBD67FFF: "2",
      UF_CRM_6627AEBD72587: "КГУ «Гимназия»",
      UF_CRM_6627AEBD85B4D: "Закупка не состоялась"
    };

    const card = parseRadarLotDeal(raw, {
      asOfDate: AS_OF_DATE,
      asOfTime: AS_OF_TIME,
      portal: "https://f3.bitrix24.kz"
    });

    expect(card).not.toBeNull();
    expect(card?.column).toBe("secondChance");
  });
});

describe("buildRadarView and Deduplication", () => {
  it("deduplicates secondChance plans and lots by plan number prefix and calculates KPIs", () => {
    // Lot from funnel 43
    const lotDeal: RadarRawDeal = {
      ID: "4310",
      TITLE: "GZ 55550001-ЗЦП1 — Интерактивная панель",
      STAGE_ID: "C43:NEW",
      STAGE_SEMANTIC_ID: "P",
      CLOSED: "N",
      ASSIGNED_BY_ID: "2301",
      OPPORTUNITY: "4000000",
      ORIGIN_ID: "gz-lot:55550001-ЗЦП1",
      COMMENTS: "Статус: Закупка не состоялась",
      UF_CRM_6627AEBD4503E: "ЗЦП",
      UF_CRM_6627AEBD54B8D: "Интерактивная панель 75",
      UF_CRM_6627AEBD67FFF: "4",
      UF_CRM_6627AEBD72587: "КГУ «Лицей»",
      UF_CRM_6627AEBD85B4D: "Закупка не состоялась"
    };

    // Plan deal with same plan number 55550001
    const duplicatePlan = {
      id: "9001",
      dealUrl: "https://f3.bitrix24.kz/crm/deal/details/9001/",
      planNumber: "55550001",
      planUrl: "https://goszakup.gov.kz/ru/registry/plan/55550001",
      month: "2026-11",
      customerName: "КГУ «Лицей»",
      customerBin: "112233445566",
      itemName: "Интерактивная панель 75",
      truCode: "262030.100.000021",
      kind: "Интерактивные панели",
      qty: 4,
      price: 1000000,
      sum: 4000000,
      method: "Запрос ценовых предложений",
      portalStatus: "Закупка не состоялась",
      managerName: "Алия",
      isNewStage: false,
      outcomeCategory: "cancelled" as const,
      outcomeKey: "failed:закупка не состоялась",
      group: "ИП" as const,
      managerId: "2301",
      dateCreate: "2026-10-01",
      isOpen: false,
      isWonCrm: false,
      isLostCrm: false
    };

    // Another distinct plan deal
    const distinctPlan = {
      ...duplicatePlan,
      id: "9002",
      planNumber: "55550002",
      sum: 8000000,
      dealUrl: "https://f3.bitrix24.kz/crm/deal/details/9002/"
    };

    const radarView = buildRadarView({
      lotDeals: [lotDeal],
      planDeals: [duplicatePlan, distinctPlan],
      asOfDate: AS_OF_DATE,
      asOfTime: AS_OF_TIME,
      portal: "https://f3.bitrix24.kz"
    });

    const ipGroup = radarView.ip;
    expect(ipGroup).toBeDefined();

    // In secondChance: should have 2 items, NOT 3 (the duplicate plan with planNumber 55550001 must be deduplicated)
    expect(ipGroup.secondChance.length).toBe(2);
    expect(ipGroup.secondChance.map((c: RadarCard) => c.planNumber)).toEqual(["55550002", "55550001"]); // sorted by sum DESC (8M, then 4M)

    // Check KPIs
    expect(ipGroup.kpis.secondChanceCount).toBe(2);
    expect(ipGroup.kpis.secondChanceSum).toBe(12000000);
    expect(ipGroup.kpis.totalCount).toBe(2);
    expect(ipGroup.kpis.totalSum).toBe(12000000);
  });
});
