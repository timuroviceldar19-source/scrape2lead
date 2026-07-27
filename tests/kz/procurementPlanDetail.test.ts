import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { enrichEligibleEpzPlanDetails, parseEpzPlanDetail } from "../../src/kz/procurement/planDetail.js";
import type { ProcurementCollectionCompleteness, ProcurementRecord } from "../../src/kz/procurement/types.js";
import { EMPTY_PLAN_PERIOD } from "../../src/kz/procurement/planPeriod.js";
import { ProcurementHttpError } from "../../src/kz/procurement/http.js";

const fixture = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/kz/procurement/plan-item-18121209.json"), "utf8"));
const detail2024 = readFixture("plan-item-detail-2024.json");
const detail2026 = readFixture("plan-item-detail-2026.json");
/** Synthetic: EPZ sometimes returns `month` as a dictionary object instead of null. */
const detailMonthObject = readFixture("plan-item-detail-month-object.synthetic.json");

describe("EPZ plan year and month", () => {
  it("reads the plan year from the plan item, not from the shared load timestamp", () => {
    // Both records carry the identical batch timestamp 1776236804 but belong to different plan years.
    expect(detail2024.timestamp).toBe(detail2026.timestamp);

    expect(parseEpzPlanDetail(detail2024)).toMatchObject({ financialYear: 2024, planYearId: 9 });
    expect(parseEpzPlanDetail(detail2026)).toMatchObject({ financialYear: 2026, planYearId: 12 });
  });

  it("never derives the approval date from the load timestamp", () => {
    expect(detail2026.decree_date).toBeNull();
    expect(parseEpzPlanDetail(detail2026)?.approvedAt).toBeNull();
    expect(parseEpzPlanDetail({ ...detail2026, decree_date: "2026-02-11" })?.approvedAt).toBe("2026-02-11");
  });

  it("reads the plan month from an object, an id, or neither", () => {
    expect(parseEpzPlanDetail(detailMonthObject)?.planMonth).toBe(2);
    expect(parseEpzPlanDetail({ ...detail2026, month: null, month_id: 5 })?.planMonth).toBe(5);
    expect(parseEpzPlanDetail(detail2026)?.planMonth).toBeNull();
  });
});

describe("EPZ plan detail enrichment", () => {
  it("parses authoritative fields from plan item 18121209", () => {
    const parsed = parseEpzPlanDetail(fixture);
    // Plan item 18121209 belongs to plan year 2024; its `timestamp` is a shared load stamp.
    expect(parsed).toMatchObject({ sourceRecordId: "18121209", externalId: "4128263137", source: "samruk",
      status: "Утвержден", customerBin: "970940002871", truCode: "262030.100.000021",
      quantity: 4, unitPrice: 1_475_000, amount: 5_900_000, approvedAt: null,
      financialYear: 2024, planYearId: 9, planMonth: null, unitName: "Штука" });
    expect(parsed?.deliveries).toEqual([
      { address: "микрорайон Промзона, дом 1.", kato: "101065100", quantity: 4 },
      { address: "Павлодарская область, Аксу Г.А., г.Аксу ул.Камзина, 1", kato: "551610000", quantity: 5 }
    ]);
  });

  it("fetches each detail id once, retries, and gives detail values priority", async () => {
    const fetchJson = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(fixture);
    const completeness = complete();
    const records = [row(), row()];
    const result = await enrichEligibleEpzPlanDetails(records, { fetchJson, completeness, retryDelayMs: 0 });

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchJson).toHaveBeenCalledWith("https://zakup.gov.kz/api/core/api/public/plan-items/18121209/");
    expect(result.records.every((record) => record.truCode === "262030.100.000021")).toBe(true);
    expect(result.records[0]).toMatchObject({ customerBin: "970940002871", amount: 5_900_000,
      url: "https://zakup.gov.kz/plan-items/18121209", enrichment: { source: "epz-plan-detail", confidence: "exact" } });
    expect(completeness).toMatchObject({ complete: true, detailRequested: 1, detailSucceeded: 1,
      detailFailed: 0, detailIdentityMismatches: 0 });
  });

  it("marks failed and identity-mismatched details as incomplete review issues", async () => {
    const completeness = complete();
    const fetchJson = vi.fn(async (url: string) => url.includes("18121209")
      ? { ...fixture, external_id: "wrong" }
      : Promise.reject(new Error("offline")));
    const result = await enrichEligibleEpzPlanDetails([
      row(), row({ sourceRecordId: "99", externalId: "99" })
    ], { fetchJson, completeness, retryDelayMs: 0, maxAttempts: 2 });

    expect(result.records.map((record) => record.detailIssue)).toEqual(["detail_identity_mismatch", "detail_fetch_failed"]);
    expect(completeness.complete).toBe(false);
    expect(completeness.detailFailed).toBe(1);
    expect(completeness.detailIdentityMismatches).toBe(1);
    expect(completeness.incompleteReasons).toEqual(expect.arrayContaining([
      "plan-detail:18121209:identity_mismatch", "plan-detail:99:fetch_failed"
    ]));
  });

  it("treats a 404 as an absent record: no retries, no incomplete collection", async () => {
    const completeness = complete();
    const fetchJson = vi.fn(async (url: string) => {
      throw new ProcurementHttpError(404, url);
    });
    const result = await enrichEligibleEpzPlanDetails([row()], { fetchJson, completeness, retryDelayMs: 0 });

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(result.records[0]?.detailIssue).toBe("detail_empty");
    expect(completeness).toMatchObject({ complete: true, detailEmpty: 1, detailFailed: 0 });
  });

  it("treats an empty body as an absent record rather than an identity mismatch", async () => {
    const completeness = complete();
    const result = await enrichEligibleEpzPlanDetails([row()], {
      fetchJson: vi.fn(async () => ({})), completeness, retryDelayMs: 0
    });

    expect(result.records[0]?.detailIssue).toBe("detail_empty");
    expect(completeness).toMatchObject({ complete: true, detailEmpty: 1, detailIdentityMismatches: 0 });
  });

  it("retries a server error before giving up and marks the collection incomplete", async () => {
    const completeness = complete();
    const fetchJson = vi.fn(async (url: string) => {
      throw new ProcurementHttpError(503, url);
    });
    const result = await enrichEligibleEpzPlanDetails([row()], {
      fetchJson, completeness, retryDelayMs: 0, maxAttempts: 3
    });

    expect(fetchJson).toHaveBeenCalledTimes(3);
    expect(result.records[0]?.detailIssue).toBe("detail_fetch_failed");
    expect(completeness).toMatchObject({ complete: false, detailFailed: 1, detailEmpty: 0 });
  });

  it("blocks a detail whose plan year contradicts the year it was collected under", async () => {
    const completeness = complete();
    const result = await enrichEligibleEpzPlanDetails([row({ collectionPlanYear: 2026, collectionPlanYearId: 12 })], {
      fetchJson: vi.fn(async () => fixture), completeness, retryDelayMs: 0
    });

    // Фикстура 18121209 относится к 2024 году, а запрашивали её под 2026.
    expect(result.records[0]?.detailIssue).toBe("plan_year_conflict");
    expect(completeness).toMatchObject({ complete: false, yearConflicts: 1, detailSucceeded: 0 });
    expect(completeness.incompleteReasons).toContain("plan-detail:18121209:plan_year_conflict:2026!=2024");
  });

  it("mirrors the plan period onto the record when the detail agrees with the collected year", async () => {
    const result = await enrichEligibleEpzPlanDetails([row({ collectionPlanYear: 2024, collectionPlanYearId: 9 })], {
      fetchJson: vi.fn(async () => fixture), completeness: complete(), retryDelayMs: 0
    });

    expect(result.records[0]).toMatchObject({ planYear: 2024, planYearId: 9, planMonth: null, approvedAt: null });
  });
});

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/kz/procurement", name), "utf8"));
}

function complete(): ProcurementCollectionCompleteness {
  return { complete: true, planYears: [{ year: 2026, planYearId: 12 }], pageLimit: 500, pagesFetched: 1,
    incompleteReasons: [], warnings: [] };
}

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return { source: "samruk", recordKind: "plan", sourceRecordId: "18121209", externalId: "4128263137",
    parentExternalId: null, status: "Утвержден", productName: "Панель интерактивная", description: "LCD поверхность",
    truCode: null, customerSourceId: "45697", customerName: "ТОО Заказчик", customerBin: null, amount: 5_900_000,
    currency: "KZT", startDate: null, endDate: null, url: "https://example.kz/old", purchaseMethod: null,
    ...EMPTY_PLAN_PERIOD, collectedAt: "2026-07-22T00:00:00.000Z", ...overrides };
}
