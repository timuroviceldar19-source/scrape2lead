// Выдуманные сделки воронки 43 для «Радара»: живые сроки, пропущенные сроки, вид менеджера.
// Алия Тестовая (ID s) и Борис Тестовый (ID t) — те же люди, что в fixture() из contracts.ts.
import { buildRadarView, type RadarRawDeal } from "../../../src/bitrix/salesPult/radar/aggregate.js";
import type { RadarView } from "../../../src/bitrix/salesPult/radar/types.js";

export const RADAR_MANAGER_NAMES = new Map([["s", "Алия Тестовая"], ["t", "Борис Тестовый"]]);
export const RADAR_PORTAL = "https://example.invalid";

export function radarLot(overrides: Partial<RadarRawDeal> & { ID: string; window?: string; status?: string }): RadarRawDeal {
  const { window, status = "Опубликован (прием заявок)", ...rest } = overrides;
  return {
    STAGE_ID: "C43:NEW",
    STAGE_SEMANTIC_ID: "P",
    CLOSED: "N",
    ASSIGNED_BY_ID: "s",
    DATE_CREATE: "2026-11-10T10:00:00+05:00",
    OPPORTUNITY: "1000000",
    ORIGIN_ID: `gz-lot:${overrides.ID}-ЗЦП1`,
    UF_CRM_6627AEBD4503E: "Запрос ценовых предложений",
    UF_CRM_6627AEBD54B8D: `Интерактивная панель ${overrides.ID}`,
    UF_CRM_6627AEBD67FFF: "2",
    UF_CRM_6627AEBD72587: `КГУ «Школа-пример ${overrides.ID}»`,
    UF_CRM_6627AEBD85B4D: status,
    COMMENTS: [
      window ? `Приём заявок: ${window} (время Алматы)` : "",
      `Статус: ${status}`,
      `Лот: https://procurement.gov.kz/ru/registry/lots/${overrides.ID}`
    ].filter(Boolean).join("\n"),
    ...rest
  };
}

/** Срез «Радара» на 21.11.2026: у Алии и Бориса горящие и пропущенные лоты, плюс то, что в пропущенные попасть не должно. */
export function radarMissedDeals(): RadarRawDeal[] {
  return [
    // Горит сегодня у Алии: до 13:00.
    radarLot({ ID: "8101", OPPORTUNITY: "4000000", window: "2026-11-18 09:00 — 2026-11-21 13:00", UF_CRM_6627AEBD54B8D: "Панель Своя-горящая" }),
    // Приём у Бориса до завтра.
    radarLot({ ID: "8102", ASSIGNED_BY_ID: "t", OPPORTUNITY: "3000000", window: "2026-11-18 09:00 — 2026-11-22 18:00", UF_CRM_6627AEBD54B8D: "Панель Чужая-приём" }),
    // Пропущен у Алии: закрылся вчера в 18:00, сделка так и стоит в «Новой».
    radarLot({ ID: "8103", OPPORTUNITY: "2000000", window: "2026-11-16 09:00 — 2026-11-20 18:00", UF_CRM_6627AEBD54B8D: "Панель Своя-пропущенная" }),
    // Пропущен у Бориса позавчера.
    radarLot({ ID: "8104", ASSIGNED_BY_ID: "t", OPPORTUNITY: "5000000", window: "2026-11-14 09:00 — 2026-11-19 12:00", UF_CRM_6627AEBD54B8D: "Панель Чужая-пропущенная" }),
    // Срок прошёл, но сделку уже взяли в работу — не пропуск.
    radarLot({ ID: "8105", STAGE_ID: "C43:PREPARATION", OPPORTUNITY: "7000000", window: "2026-11-15 09:00 — 2026-11-20 12:00" }),
    // Срок прошёл восемь дней назад — старше окна в 7 дней.
    radarLot({ ID: "8106", OPPORTUNITY: "8000000", window: "2026-11-09 09:00 — 2026-11-13 09:00" }),
    // Сделка закрыта (проигрыш) в стадии «Новая» — с радара уходит.
    radarLot({ ID: "8107", STAGE_SEMANTIC_ID: "F", CLOSED: "Y", OPPORTUNITY: "9000000", window: "2026-11-15 09:00 — 2026-11-20 12:00" }),
    // Пропущен у Бориса тогда же, когда у Алии, но дороже: идёт первым.
    radarLot({ ID: "8108", ASSIGNED_BY_ID: "t", OPPORTUNITY: "6000000", window: "2026-11-16 09:00 — 2026-11-20 18:00", UF_CRM_6627AEBD54B8D: "Панель Чужая-дорогая" }),
    // Даты-заглушки Битрикса (день создания и +7 дней), строки «Приём заявок» нет: это не срок закупки.
    radarLot({ ID: "8109", DATE_CREATE: "2026-11-12T10:00:00+05:00", BEGINDATE: "2026-11-12T00:00:00+05:00", CLOSEDATE: "2026-11-19T00:00:00+05:00", OPPORTUNITY: "1500000" }),
    // КТ: ноутбуки Алии, приём закрылся сегодня в 09:00.
    radarLot({ ID: "8110", OPPORTUNITY: "2500000", window: "2026-11-17 09:00 — 2026-11-21 09:00", UF_CRM_6627AEBD54B8D: "Ноутбук Свой-пропущенный" }),
    // Обсуждение у Бориса: приём ещё не начался.
    radarLot({ ID: "8111", ASSIGNED_BY_ID: "t", OPPORTUNITY: "2200000", status: "Опубликован", window: "2026-11-25 09:00 — 2026-11-30 18:00", UF_CRM_6627AEBD54B8D: "Доска Чужая-обсуждение" })
  ];
}

export const RADAR_AS_OF_DATE = "2026-11-21";
/** 09:49:30 по Алматы: у 8101 остаётся 3 ч 10 мин 30 с. */
export const RADAR_AS_OF_TIME = "2026-11-21T09:49:30+05:00";

export function radarMissedView(asOfTime = RADAR_AS_OF_TIME): RadarView {
  return buildRadarView({
    lotDeals: radarMissedDeals(),
    asOfDate: RADAR_AS_OF_DATE,
    asOfTime,
    portal: RADAR_PORTAL,
    managerNames: RADAR_MANAGER_NAMES
  });
}
