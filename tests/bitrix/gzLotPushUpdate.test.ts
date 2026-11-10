import { describe, expect, it } from "vitest";
import {
  LOT_EXISTING_DEAL_FIELDS,
  evaluateLotDealUpdate,
  updateLotComments,
  type ExistingLotDeal,
  type GzLotUpdateRow
} from "../../src/bitrix/gzLotSync.js";
import type { LotBidWindow } from "../../src/kz/goszakupLotWindow.js";

const SAMPLE_ROW: GzLotUpdateRow = {
  lotNumber: "83132229-ЗЦП1",
  lotName: "Интерактивная панель 75 дюймов",
  announceNumber: "12345678",
  announceName: "Закупка интерактивных панелей",
  customer: "КГУ «Школа-лицей №1»",
  quantity: "5",
  amount: "5000000",
  method: "Запрос ценовых предложений",
  status: "Опубликован (прием заявок)",
  month: "ноябрь",
  query: "интерактивная панель",
  lotUrl: "https://goszakup.gov.kz/ru/registry/lots/83132229",
  announceUrl: "https://goszakup.gov.kz/ru/announce/index/12345678"
};

const BID_WINDOW: LotBidWindow = {
  startDate: "2026-11-10 10:00:00",
  endDate: "2026-11-14 18:00:00"
};

describe("updateLotComments", () => {
  it("updates existing 'Приём заявок:' and 'Статус:' lines in comments", () => {
    const existingComments = [
      "GZ лот: 83132229-ЗЦП1 (Интерактивная панель 75 дюймов)",
      "Объявление: 12345678 — Закупка",
      "Заказчик: КГУ Школа",
      "Способ закупки: Запрос ценовых предложений",
      "Статус: Опубликован",
      "Количество: 5",
      "Сумма: 5000000 KZT",
      "Месяц поставки: ноябрь",
      "Поисковый запрос: интерактивная панель",
      "Лот: https://goszakup.gov.kz/ru/registry/lots/83132229",
      "Объявление: https://goszakup.gov.kz/ru/announce/index/12345678"
    ].join("\n");

    const updated = updateLotComments(existingComments, SAMPLE_ROW, BID_WINDOW);
    expect(updated).toContain("Приём заявок: 2026-11-10 10:00 — 2026-11-14 18:00 (время Алматы)");
    expect(updated).toContain("Статус: Опубликован (прием заявок)");
    expect(updated).not.toContain("Статус: Опубликован\n");
  });

  it("replaces existing 'Приём заявок:' line if already present", () => {
    const existingComments = [
      "GZ лот: 83132229-ЗЦП1 (Интерактивная панель 75 дюймов)",
      "Приём заявок: 2026-11-01 10:00 — 2026-11-05 18:00 (время Алматы)",
      "Статус: Опубликован"
    ].join("\n");

    const updated = updateLotComments(existingComments, SAMPLE_ROW, BID_WINDOW);
    expect(updated).toContain("Приём заявок: 2026-11-10 10:00 — 2026-11-14 18:00 (время Алматы)");
    expect(updated).not.toContain("2026-11-01");
    expect(updated).toContain("Статус: Опубликован (прием заявок)");
  });
});

describe("evaluateLotDealUpdate", () => {
  it("detects status transition from 'Опубликован' to 'Опубликован (прием заявок)' and updates fields", () => {
    const deal: ExistingLotDeal = {
      ID: "1001",
      COMPANY_ID: "50",
      STAGE_SEMANTIC_ID: "P",
      CLOSED: "N",
      DATE_CREATE: "2026-11-08T10:00:00+05:00",
      BEGINDATE: "2026-11-08",
      CLOSEDATE: "2026-11-15",
      COMMENTS: "GZ лот: 83132229-ЗЦП1\nСтатус: Опубликован",
      UF_CRM_6627AEBD85B4D: "Опубликован"
    };

    const result = evaluateLotDealUpdate(deal, SAMPLE_ROW, BID_WINDOW, "50");
    expect(result.action).toBe("update");
    expect(result.updateFields).toMatchObject({
      UF_CRM_6627AEBD85B4D: "Опубликован (прием заявок)",
      BEGINDATE: "2026-11-10",
      CLOSEDATE: "2026-11-14"
    });
    expect(result.updateFields?.COMMENTS).toContain("Приём заявок: 2026-11-10 10:00 — 2026-11-14 18:00");
  });

  it("updates dates when deal has placeholder dates even if status is already matching", () => {
    const deal: ExistingLotDeal = {
      ID: "1002",
      COMPANY_ID: "50",
      STAGE_SEMANTIC_ID: "P",
      CLOSED: "N",
      DATE_CREATE: "2026-11-10T10:00:00+05:00",
      BEGINDATE: "2026-11-10",
      CLOSEDATE: "2026-11-17", // +7 days placeholder from Bitrix
      COMMENTS: "GZ лот: 83132229-ЗЦП1\nСтатус: Опубликован (прием заявок)",
      UF_CRM_6627AEBD85B4D: "Опубликован (прием заявок)"
    };

    const result = evaluateLotDealUpdate(deal, SAMPLE_ROW, BID_WINDOW, "50");
    expect(result.action).toBe("update");
    expect(result.updateFields?.CLOSEDATE).toBe("2026-11-14");
  });

  it("returns 'existing' when status and dates are already up to date and company is linked", () => {
    const deal: ExistingLotDeal = {
      ID: "1003",
      COMPANY_ID: "50",
      STAGE_SEMANTIC_ID: "P",
      CLOSED: "N",
      DATE_CREATE: "2026-11-10T10:00:00+05:00",
      BEGINDATE: "2026-11-10",
      CLOSEDATE: "2026-11-14",
      COMMENTS: "GZ лот: 83132229-ЗЦП1\nПриём заявок: 2026-11-10 10:00 — 2026-11-14 18:00 (время Алматы)\nСтатус: Опубликован (прием заявок)",
      UF_CRM_6627AEBD85B4D: "Опубликован (прием заявок)"
    };

    const result = evaluateLotDealUpdate(deal, SAMPLE_ROW, BID_WINDOW, "50");
    expect(result.action).toBe("existing");
    expect(result.updateFields).toBeNull();
  });

  it("links company if company was missing but status/dates are up to date", () => {
    const deal: ExistingLotDeal = {
      ID: "1004",
      COMPANY_ID: null,
      STAGE_SEMANTIC_ID: "P",
      CLOSED: "N",
      DATE_CREATE: "2026-11-10T10:00:00+05:00",
      BEGINDATE: "2026-11-10",
      CLOSEDATE: "2026-11-14",
      COMMENTS: "GZ лот: 83132229-ЗЦП1\nПриём заявок: 2026-11-10 10:00 — 2026-11-14 18:00 (время Алматы)\nСтатус: Опубликован (прием заявок)",
      UF_CRM_6627AEBD85B4D: "Опубликован (прием заявок)"
    };

    const result = evaluateLotDealUpdate(deal, SAMPLE_ROW, BID_WINDOW, "50");
    expect(result.action).toBe("link_company");
    expect(result.updateFields).toEqual({ COMPANY_ID: "50" });
  });

  it("ignores closed deals (STAGE_SEMANTIC_ID === 'S' or 'F' or CLOSED === 'Y')", () => {
    const wonDeal: ExistingLotDeal = {
      ID: "1005",
      COMPANY_ID: "50",
      STAGE_SEMANTIC_ID: "S",
      CLOSED: "Y",
      DATE_CREATE: "2026-11-10T10:00:00+05:00",
      BEGINDATE: "2026-11-10",
      CLOSEDATE: "2026-11-17",
      COMMENTS: "",
      UF_CRM_6627AEBD85B4D: "Опубликован"
    };

    const result = evaluateLotDealUpdate(wonDeal, SAMPLE_ROW, BID_WINDOW, "50");
    expect(result.action).toBe("existing");
    expect(result.updateFields).toBeNull();
  });

  it("includes ORIGIN_ID in LOT_EXISTING_DEAL_FIELDS for syncOpenLotDeals", () => {
    expect(LOT_EXISTING_DEAL_FIELDS).toContain("ORIGIN_ID");
  });
});
